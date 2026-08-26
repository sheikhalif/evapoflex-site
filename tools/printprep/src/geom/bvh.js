/**
 * A flat, binned-SAH bounding volume hierarchy over triangles.
 *
 * This is the most reused structure in the tool: clicking a face, deciding
 * whether a probe point is inside the solid, measuring how far a down-facing
 * facet is above whatever supports it, and auditing that a stamped joint really
 * sits inside its part all go through it. Everything is typed arrays and an
 * explicit work stack - no per-node objects, no recursion - so it can be built
 * in chunks without blocking and stays cheap in memory at half a million
 * triangles.
 */

const BINS = 12;
const LEAF_SIZE = 4;

export class BVH {
  /** @param {Float32Array} verts @param {Uint32Array} tris */
  constructor(verts, tris) {
    this.verts = verts;
    this.tris = tris;
    const nTri = tris.length / 3;

    // Per-triangle bounds and centroids, computed once.
    const tb = new Float32Array(nTri * 6);
    const tc = new Float32Array(nTri * 3);
    for (let t = 0; t < nTri; t++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = tris[t * 3 + k] * 3;
        const x = verts[v], y = verts[v + 1], z = verts[v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      tb.set([x0, y0, z0, x1, y1, z1], t * 6);
      tc[t * 3] = (x0 + x1) / 2; tc[t * 3 + 1] = (y0 + y1) / 2; tc[t * 3 + 2] = (z0 + z1) / 2;
    }
    this.triBounds = tb;

    this.index = new Uint32Array(nTri);
    for (let i = 0; i < nTri; i++) this.index[i] = i;

    const maxNodes = Math.max(1, 2 * nTri);
    this.bounds = new Float32Array(maxNodes * 6);
    this.left = new Int32Array(maxNodes).fill(-1);   // child node, or first index for a leaf
    this.count = new Int32Array(maxNodes);           // 0 for internal nodes
    this.nNodes = 0;

    this.root = this._build(tb, tc, 0, nTri);
  }

  _alloc() { return this.nNodes++; }

  _build(tb, tc, start, end) {
    const node = this._alloc();
    const b = this._boundsOf(tb, start, end);
    this.bounds.set(b, node * 6);
    const n = end - start;
    if (n <= LEAF_SIZE) { this.left[node] = start; this.count[node] = n; return node; }

    // Split along the widest centroid extent, binned, minimising surface area
    // times primitive count. Falling back to the median keeps degenerate cases
    // (all centroids coincident) from producing an empty child and recursing
    // forever.
    let cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = this.index[i];
      for (let a = 0; a < 3; a++) {
        const v = tc[t * 3 + a];
        if (v < cmin[a]) cmin[a] = v;
        if (v > cmax[a]) cmax[a] = v;
      }
    }
    let axis = 0, ext = cmax[0] - cmin[0];
    for (let a = 1; a < 3; a++) if (cmax[a] - cmin[a] > ext) { ext = cmax[a] - cmin[a]; axis = a; }

    let mid;
    if (ext < 1e-12) {
      mid = (start + end) >> 1;
    } else {
      const scale = BINS / ext;
      const binBounds = new Float32Array(BINS * 6).fill(0);
      const binCount = new Int32Array(BINS);
      for (let i = 0; i < BINS; i++) binBounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], i * 6);
      for (let i = start; i < end; i++) {
        const t = this.index[i];
        const bi = Math.min(BINS - 1, ((tc[t * 3 + axis] - cmin[axis]) * scale) | 0);
        binCount[bi]++;
        growInto(binBounds, bi * 6, tb, t * 6);
      }
      let bestCost = Infinity, bestSplit = -1;
      const leftB = new Float32Array(6), rightAcc = new Float32Array(BINS * 6);
      let acc = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      const rightCount = new Int32Array(BINS);
      let rc = 0;
      for (let i = BINS - 1; i >= 1; i--) {
        rc += binCount[i];
        growInto(acc, 0, binBounds, i * 6);
        rightAcc.set(acc, i * 6);
        rightCount[i] = rc;
      }
      leftB.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      let lc = 0;
      for (let i = 0; i < BINS - 1; i++) {
        lc += binCount[i];
        growInto(leftB, 0, binBounds, i * 6);
        if (lc === 0 || rightCount[i + 1] === 0) continue;
        const cost = lc * area6(leftB, 0) + rightCount[i + 1] * area6(rightAcc, (i + 1) * 6);
        if (cost < bestCost) { bestCost = cost; bestSplit = i; }
      }
      if (bestSplit < 0) {
        mid = (start + end) >> 1;
      } else {
        let i = start, j = end - 1;
        while (i <= j) {
          const t = this.index[i];
          const bi = Math.min(BINS - 1, ((tc[t * 3 + axis] - cmin[axis]) * scale) | 0);
          if (bi <= bestSplit) i++;
          else { const tmp = this.index[i]; this.index[i] = this.index[j]; this.index[j] = tmp; j--; }
        }
        mid = i;
        if (mid === start || mid === end) mid = (start + end) >> 1;
      }
    }

    const l = this._build(tb, tc, start, mid);
    const r = this._build(tb, tc, mid, end);
    this.left[node] = l;
    this.count[node] = 0;
    this.right = this.right || new Int32Array(this.bounds.length / 6);
    this.right[node] = r;
    return node;
  }

  _boundsOf(tb, start, end) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = this.index[i] * 6;
      for (let a = 0; a < 3; a++) { if (tb[t + a] < b[a]) b[a] = tb[t + a]; if (tb[t + 3 + a] > b[3 + a]) b[3 + a] = tb[t + 3 + a]; }
    }
    return b;
  }

  /** Nearest hit along the ray. @returns {{t:number, tri:number, point:number[]}|null} */
  raycast(origin, dir, maxT = Infinity) {
    const inv = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
    let best = maxT, bestTri = -1;
    const stack = [this.root];
    while (stack.length) {
      const n = stack.pop();
      if (!slab(this.bounds, n * 6, origin, inv, best)) continue;
      if (this.count[n] > 0) {
        for (let i = this.left[n]; i < this.left[n] + this.count[n]; i++) {
          const t = this.index[i];
          const hit = rayTri(this.verts, this.tris, t, origin, dir);
          if (hit !== null && hit > 1e-9 && hit < best) { best = hit; bestTri = t; }
        }
      } else {
        stack.push(this.left[n], this.right[n]);
      }
    }
    if (bestTri < 0) return null;
    return { t: best, tri: bestTri, point: [origin[0] + dir[0] * best, origin[1] + dir[1] * best, origin[2] + dir[2] * best] };
  }

  /**
   * Parity test along a fixed, deliberately irrational direction. The odd
   * direction is not superstition: axis-aligned rays hit edges and vertices of
   * axis-aligned models constantly, and each such hit is counted twice or not at
   * all, which flips the answer.
   */
  pointInside(p) {
    const dir = [0.5773502691896258, 0.5567764362830022, 0.5971385862305308];
    const inv = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
    let crossings = 0;
    const stack = [this.root];
    while (stack.length) {
      const n = stack.pop();
      if (!slab(this.bounds, n * 6, p, inv, Infinity)) continue;
      if (this.count[n] > 0) {
        for (let i = this.left[n]; i < this.left[n] + this.count[n]; i++) {
          const hit = rayTri(this.verts, this.tris, this.index[i], p, dir);
          if (hit !== null && hit > 1e-9) crossings++;
        }
      } else stack.push(this.left[n], this.right[n]);
    }
    return (crossings & 1) === 1;
  }

  /** Every hit along the ray, sorted by distance. Used for support-height probes. */
  raycastAll(origin, dir, maxT = Infinity) {
    const inv = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
    const hits = [];
    const stack = [this.root];
    while (stack.length) {
      const n = stack.pop();
      if (!slab(this.bounds, n * 6, origin, inv, maxT)) continue;
      if (this.count[n] > 0) {
        for (let i = this.left[n]; i < this.left[n] + this.count[n]; i++) {
          const t = this.index[i];
          const hit = rayTri(this.verts, this.tris, t, origin, dir);
          if (hit !== null && hit > 1e-9 && hit < maxT) hits.push({ t: hit, tri: t });
        }
      } else stack.push(this.left[n], this.right[n]);
    }
    hits.sort((a, b) => a.t - b.t);
    return hits;
  }
}

function growInto(dst, dOff, src, sOff) {
  for (let a = 0; a < 3; a++) {
    if (src[sOff + a] < dst[dOff + a]) dst[dOff + a] = src[sOff + a];
    if (src[sOff + 3 + a] > dst[dOff + 3 + a]) dst[dOff + 3 + a] = src[sOff + 3 + a];
  }
}

function area6(b, o) {
  const dx = Math.max(0, b[o + 3] - b[o]), dy = Math.max(0, b[o + 4] - b[o + 1]), dz = Math.max(0, b[o + 5] - b[o + 2]);
  return 2 * (dx * dy + dy * dz + dz * dx);
}

function slab(b, o, org, inv, maxT) {
  let t0 = 0, t1 = maxT;
  for (let a = 0; a < 3; a++) {
    let lo = (b[o + a] - org[a]) * inv[a], hi = (b[o + 3 + a] - org[a]) * inv[a];
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    if (lo > t0) t0 = lo;
    if (hi < t1) t1 = hi;
    if (t0 > t1) return false;
  }
  return true;
}

/** Moller-Trumbore, double-sided. */
function rayTri(verts, tris, t, o, d) {
  const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
  const e1x = verts[b] - verts[a], e1y = verts[b + 1] - verts[a + 1], e1z = verts[b + 2] - verts[a + 2];
  const e2x = verts[c] - verts[a], e2y = verts[c + 1] - verts[a + 1], e2z = verts[c + 2] - verts[a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return null;
  const invDet = 1 / det;
  const tx = o[0] - verts[a], ty = o[1] - verts[a + 1], tz = o[2] - verts[a + 2];
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * invDet;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * invDet;
}
