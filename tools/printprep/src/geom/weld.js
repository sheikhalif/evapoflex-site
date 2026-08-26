/**
 * Vertex welding.
 *
 * An STL is triangle soup, so the first job is to find which of the 3N loose
 * corners are the same point. Everything downstream - adjacency, regions,
 * feature edges, the manifold check - depends on this being right and fast.
 *
 * The hash is open-addressed over typed arrays, deliberately. A string-keyed Map
 * ("cx,cy,cz") on a 1.5M-vertex model costs seconds and hundreds of megabytes in
 * key strings alone; this costs a couple of hundred milliseconds and a few tens
 * of megabytes, and that difference is the difference between the tool being
 * usable on a real part and not.
 *
 * Quantising to a grid and merging whole cells is the tempting shortcut and it
 * is wrong: two points 1 nm apart that straddle a cell boundary land in
 * different cells and never merge. So the grid is only an accelerator - a new
 * point probes all 27 neighbouring cells and merges into the nearest
 * representative genuinely within epsilon.
 *
 * Each cell holds a CHAIN of representatives, not one. A cell is eps wide, so
 * two points in it can be up to eps*sqrt(3) apart and legitimately distinct;
 * keeping only the latest silently forgot the earlier one, and every subsequent
 * copy of that forgotten vertex started a fresh vertex instead of merging. On
 * well-behaved test parts this never showed. On a 412k-triangle Rhino export it
 * turned a watertight mesh into one with 8368 open edges, which read as "your
 * model is broken" when the model was fine.
 */

const EMPTY = -1;

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

class CellHash {
  constructor(capacityHint) {
    this.cap = nextPow2(Math.max(16, capacityHint * 2));
    this.mask = this.cap - 1;
    this.cx = new Int32Array(this.cap);
    this.cy = new Int32Array(this.cap);
    this.cz = new Int32Array(this.cap);
    this.val = new Int32Array(this.cap).fill(EMPTY);
  }
  _slot(x, y, z) {
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
    let i = h & this.mask;
    while (this.val[i] !== EMPTY) {
      if (this.cx[i] === x && this.cy[i] === y && this.cz[i] === z) return i;
      i = (i + 1) & this.mask;
    }
    return i;                      // first free slot for this key
  }
  /** Head of this cell's chain, or EMPTY. */
  get(x, y, z) { const i = this._slot(x, y, z); return this.val[i]; }
  /** Push v onto this cell's chain; `next` links vertex -> next vertex in cell. */
  push(x, y, z, v, next) {
    const i = this._slot(x, y, z);
    next[v] = this.val[i] === EMPTY ? EMPTY : this.val[i];
    this.cx[i] = x; this.cy[i] = y; this.cz[i] = z;
    this.val[i] = v;
  }
}

/**
 * @param {Float32Array} positions  9 floats per triangle, unindexed
 * @param {{eps?: number}} [opts]   absolute weld radius; defaults to 1e-5 of the
 *                                  bounding diagonal, which is well under any
 *                                  meaningful print feature and well above
 *                                  float32 noise
 * @returns {{verts: Float32Array, tris: Uint32Array, bbox: {min:number[],max:number[]},
 *            diag: number, eps: number, degenerate: number}}
 */
export function weld(positions, opts = {}) {
  const nCorner = positions.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let far = 0;                     // largest coordinate magnitude, for the noise floor
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
      const a = Math.abs(v);
      if (a > far) far = a;
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;

  // The tolerance has to sit between two hard limits.
  //
  // Below: float32 noise. An STL stores coordinates as float32, so a vertex a
  // long way from the origin - this wheel is modelled 4 metres out - is only
  // resolved to about maxCoord * 2^-23, and two corners that the CAD system
  // considers identical can differ by an ulp or two.
  //
  // Above: the mesh's own finest edge. Welding wider than the shortest edge
  // merges the two ENDS of a real edge, which is not repair, it is damage: it
  // collapses the triangle, flips its neighbours and opens the mesh. Scaling
  // the tolerance off the bounding diagonal ignored this completely - on a
  // 1368 mm diagonal it asked for 13.7 um against a mesh whose finest edge is
  // 10.3 um, wrongly merged 192 vertex pairs, and reported the damage as the
  // model's fault.
  const noiseFloor = Math.max(2 * far * 1.1920929e-7, 1e-6);   // 2 ulp of float32
  let shortest = Infinity;
  for (let t = 0; t + 8 < positions.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const a = t + k * 3, b = t + ((k + 1) % 3) * 3;
      const dx = positions[a] - positions[b], dy = positions[a + 1] - positions[b + 1], dz = positions[a + 2] - positions[b + 2];
      const d = Math.hypot(dx, dy, dz);
      if (d > 0 && d < shortest) shortest = d;
    }
  }
  const featureCap = Number.isFinite(shortest) ? 0.4 * shortest : Infinity;
  const eps = opts.eps ?? Math.min(Math.max(1e-5 * diag, 1e-6), Math.max(featureCap, noiseFloor));
  const inv = 1 / eps;
  const eps2 = eps * eps;

  const hash = new CellHash(nCorner);
  const verts = new Float32Array(nCorner * 3);       // trimmed at the end
  const remap = new Uint32Array(nCorner);
  const next = new Int32Array(nCorner).fill(EMPTY);  // vertex -> next vertex in the same cell
  let nVert = 0;

  for (let c = 0; c < nCorner; c++) {
    const px = positions[c * 3], py = positions[c * 3 + 1], pz = positions[c * 3 + 2];
    const bx = Math.floor(px * inv), by = Math.floor(py * inv), bz = Math.floor(pz * inv);
    let found = EMPTY, bestD2 = eps2;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (let v = hash.get(bx + dx, by + dy, bz + dz); v !== EMPTY; v = next[v]) {
        const qx = verts[v * 3] - px, qy = verts[v * 3 + 1] - py, qz = verts[v * 3 + 2] - pz;
        const d2 = qx * qx + qy * qy + qz * qz;
        if (d2 <= bestD2) { bestD2 = d2; found = v; }
      }
    }
    if (found === EMPTY) {
      verts[nVert * 3] = px; verts[nVert * 3 + 1] = py; verts[nVert * 3 + 2] = pz;
      hash.push(bx, by, bz, nVert, next);
      remap[c] = nVert++;
    } else {
      remap[c] = found;
    }
  }

  // Drop triangles that collapsed to a line or a point. That is safe: when two
  // corners weld together the triangle is a zero-width flap whose two surviving
  // edges are the same edge traversed both ways, so they cancel and the mesh
  // stays closed.
  //
  // Nothing else is dropped. There used to be an area floor of 1e-9 * diag^2 as
  // well, on the theory that a sliver carries no surface and poisons the
  // dihedral maths. But a THIN triangle with three distinct corners is a real
  // face: deleting it leaves three unmatched edges, which is a hole. The floor
  // also scaled with the model, so a metre-wide part got a bigger threshold
  // than a small one for no reason related to its features - on a 967 mm wheel
  // it sat above the mesh's own MEDIAN triangle area and deleted 6,941 good
  // faces, reporting the resulting 8,364 holes as "not a clean solid". Slivers
  // are kept; the normal maths already yields a zero normal rather than a NaN
  // for a degenerate one, and manifold welds to its own tolerance downstream.
  const nTriIn = nCorner / 3;
  const tris = new Uint32Array(nTriIn * 3);
  let nTri = 0, degenerate = 0;
  for (let t = 0; t < nTriIn; t++) {
    const a = remap[t * 3], b = remap[t * 3 + 1], c = remap[t * 3 + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    tris[nTri * 3] = a; tris[nTri * 3 + 1] = b; tris[nTri * 3 + 2] = c;
    nTri++;
  }

  return {
    verts: verts.subarray(0, nVert * 3),
    tris: tris.subarray(0, nTri * 3),
    bbox: { min, max }, diag, eps, degenerate,
  };
}
