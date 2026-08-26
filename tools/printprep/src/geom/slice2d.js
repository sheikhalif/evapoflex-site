/**
 * Plane sections of a triangle mesh, and the area profile the split search
 * feeds on.
 *
 * The search wants to know, for a candidate cut direction, how the cross-section
 * area varies along it - local minima are natural places to cut (necks and
 * waists), and the profile also says where a cut would sever thin walls. One
 * sweep gives all N samples in O(sum of active triangles) by bucketing each
 * triangle into the samples its extent covers, rather than testing every
 * triangle at every sample.
 *
 * Area is computed from the section segments with the shoelace rule, summed over
 * consistently wound loops and |total| taken at the end - which is what makes
 * holes subtract rather than add.
 */

/** Signed distance of vertex v from the plane n.x = d */
const dist = (verts, v, n, d) => verts[v * 3] * n[0] + verts[v * 3 + 1] * n[1] + verts[v * 3 + 2] * n[2] - d;

/**
 * Section one triangle with the plane; returns a 2D segment in the (u, w) frame
 * or null.
 *
 * Orientation is the part that matters. The cross-section of a solid is a
 * region in the plane; its boundary loops must all be traversed the same way
 * or the shoelace areas cancel into garbage and the loop chaining cannot walk
 * end-to-start. The reliable convention is geometric, not combinatorial: the
 * segment runs along cross(planeNormal, faceNormal), which always keeps the
 * solid's interior on the same side regardless of how the triangle's winding
 * happened to order the crossing edges.
 */
function triSegment(verts, tris, t, n, d, u, w) {
  const i0 = tris[t * 3], i1 = tris[t * 3 + 1], i2 = tris[t * 3 + 2];
  const d0 = dist(verts, i0, n, d), d1 = dist(verts, i1, n, d), d2 = dist(verts, i2, n, d);
  const below = (d0 < 0 ? 1 : 0) + (d1 < 0 ? 1 : 0) + (d2 < 0 ? 1 : 0);
  if (below === 0 || below === 3) return null;

  const pts3 = [];
  const edges = [[i0, i1, d0, d1], [i1, i2, d1, d2], [i2, i0, d2, d0]];
  for (const [a, b, da, db] of edges) {
    if ((da < 0) === (db < 0)) continue;
    const s = da / (da - db);
    pts3.push([
      verts[a * 3] + s * (verts[b * 3] - verts[a * 3]),
      verts[a * 3 + 1] + s * (verts[b * 3 + 1] - verts[a * 3 + 1]),
      verts[a * 3 + 2] + s * (verts[b * 3 + 2] - verts[a * 3 + 2]),
    ]);
  }
  if (pts3.length !== 2) return null;

  // Outward face normal from the winding.
  const ux = verts[i1 * 3] - verts[i0 * 3], uy = verts[i1 * 3 + 1] - verts[i0 * 3 + 1], uz = verts[i1 * 3 + 2] - verts[i0 * 3 + 2];
  const vx = verts[i2 * 3] - verts[i0 * 3], vy = verts[i2 * 3 + 1] - verts[i0 * 3 + 1], vz = verts[i2 * 3 + 2] - verts[i0 * 3 + 2];
  const Nx = uy * vz - uz * vy, Ny = uz * vx - ux * vz, Nz = ux * vy - uy * vx;
  // Desired direction: cross(n, N).
  const dx = n[1] * Nz - n[2] * Ny, dy = n[2] * Nx - n[0] * Nz, dz = n[0] * Ny - n[1] * Nx;
  const sx = pts3[1][0] - pts3[0][0], sy = pts3[1][1] - pts3[0][1], sz = pts3[1][2] - pts3[0][2];
  const flip = (sx * dx + sy * dy + sz * dz) < 0;
  const A = flip ? pts3[1] : pts3[0], B = flip ? pts3[0] : pts3[1];
  return [
    [A[0] * u[0] + A[1] * u[1] + A[2] * u[2], A[0] * w[0] + A[1] * w[1] + A[2] * w[2]],
    [B[0] * u[0] + B[1] * u[1] + B[2] * u[2], B[0] * w[0] + B[1] * w[1] + B[2] * w[2]],
  ];
}

function frameOf(n) {
  const up = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(n, up));
  return { u, w: cross3(n, u) };
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Area of one section from its segments: half the sum of cross products. */
function segsArea(segs) {
  let a = 0;
  for (const [[x0, y0], [x1, y1]] of segs) a += x0 * y1 - x1 * y0;
  return Math.abs(a) / 2;
}

/**
 * Cross-section area at N evenly spaced offsets along direction n.
 * @returns {{offsets: Float32Array, areas: Float32Array, lo: number, hi: number}}
 */
export function areaProfile(verts, tris, n, N = 96) {
  const { u, w } = frameOf(n);
  const nTri = tris.length / 3;

  let lo = Infinity, hi = -Infinity;
  const nv = verts.length / 3;
  for (let v = 0; v < nv; v++) {
    const h = verts[v * 3] * n[0] + verts[v * 3 + 1] * n[1] + verts[v * 3 + 2] * n[2];
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const span = hi - lo || 1;
  const step = span / (N + 1);

  // Bucket triangles by the sample range their extent covers.
  const buckets = Array.from({ length: N }, () => []);
  for (let t = 0; t < nTri; t++) {
    let tLo = Infinity, tHi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      const h = verts[v * 3] * n[0] + verts[v * 3 + 1] * n[1] + verts[v * 3 + 2] * n[2];
      if (h < tLo) tLo = h;
      if (h > tHi) tHi = h;
    }
    let k0 = Math.max(0, Math.ceil((tLo - lo) / step - 1));
    let k1 = Math.min(N - 1, Math.floor((tHi - lo) / step - 1) + 1);
    for (let k = k0; k <= k1; k++) buckets[k].push(t);
  }

  const offsets = new Float32Array(N), areas = new Float32Array(N);
  const segs = [];
  for (let k = 0; k < N; k++) {
    const d = lo + (k + 1) * step;
    offsets[k] = d;
    segs.length = 0;
    for (const t of buckets[k]) {
      const s = triSegment(verts, tris, t, n, d, u, w);
      if (s) segs.push(s);
    }
    areas[k] = segsArea(segs);
  }
  return { offsets, areas, lo, hi };
}

/**
 * The full section at one offset: closed loops in the plane's (u, w) frame plus
 * the frame itself, for anyone who needs to go back to 3D.
 */
export function sectionLoops(verts, tris, n, d) {
  const { u, w } = frameOf(n);
  const nTri = tris.length / 3;
  const segs = [];
  for (let t = 0; t < nTri; t++) {
    const s = triSegment(verts, tris, t, n, d, u, w);
    if (s) segs.push(s);
  }
  // Chain segments into loops by endpoint proximity. Snapping to a single grid
  // key is the tempting version and it is subtly wrong: a coordinate sitting a
  // hair either side of a cell boundary rounds to different keys, and exactly
  // that happens at box corners where several triangles interpolate the same
  // point through different arithmetic. So the lookup probes the 3x3 cell
  // neighbourhood and matches by true distance.
  let ext = 1e-6;
  for (const [[x0, y0], [x1, y1]] of segs) ext = Math.max(ext, Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1));
  const snap = ext * 1e-5;
  const cellOf = (p) => [Math.round(p[0] / snap), Math.round(p[1] / snap)];
  const from = new Map();
  segs.forEach((s, i) => {
    const [cx, cy] = cellOf(s[0]);
    const k = cx + ':' + cy;
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(i);
  });
  const used = new Uint8Array(segs.length);
  const findStart = (p, tol) => {
    const [cx, cy] = cellOf(p);
    let best = -1, bestD = tol * tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cands = from.get((cx + dx) + ':' + (cy + dy));
      if (!cands) continue;
      for (const c of cands) {
        if (used[c]) continue;
        const q = segs[c][0];
        const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
        if (d2 <= bestD) { bestD = d2; best = c; }
      }
    }
    return best;
  };
  const loops = [];
  const tol = snap * 2;
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i][0]];
    let cur = segs[i][1];
    const start = segs[i][0];
    let guard = segs.length + 1;
    while (guard-- > 0) {
      if ((cur[0] - start[0]) ** 2 + (cur[1] - start[1]) ** 2 <= tol * tol) break;   // closed
      const next = findStart(cur, tol);
      if (next < 0) break;                        // open chain: leave unclosed
      used[next] = 1;
      loop.push(cur);
      cur = segs[next][1];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  const area = loops.reduce((s, l) => {
    let a = 0;
    for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return s + a;
  }, 0);
  return { loops, area: Math.abs(area) / 2, u, w, n, d };
}

/** Map a 2D point in a section frame back to 3D. */
export function sectionToWorld(sec, x, y) {
  return [
    sec.u[0] * x + sec.w[0] * y + sec.n[0] * sec.d,
    sec.u[1] * x + sec.w[1] * y + sec.n[1] * sec.d,
    sec.u[2] * x + sec.w[2] * y + sec.n[2] * sec.d,
  ];
}
