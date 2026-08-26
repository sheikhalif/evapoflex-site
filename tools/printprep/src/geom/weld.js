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
 * different cells and never merge. So the grid is only an accelerator - each
 * cell holds at most one representative, and a new point probes all 27
 * neighbouring cells and merges into the first representative genuinely within
 * epsilon.
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
  get(x, y, z) { const i = this._slot(x, y, z); return this.val[i]; }
  set(x, y, z, v) {
    const i = this._slot(x, y, z);
    this.cx[i] = x; this.cy[i] = y; this.cz[i] = z; this.val[i] = v;
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
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const eps = opts.eps ?? Math.max(1e-5 * diag, 1e-6);
  const inv = 1 / eps;
  const eps2 = eps * eps;

  const hash = new CellHash(nCorner);
  const verts = new Float32Array(nCorner * 3);       // trimmed at the end
  const remap = new Uint32Array(nCorner);
  let nVert = 0;

  for (let c = 0; c < nCorner; c++) {
    const px = positions[c * 3], py = positions[c * 3 + 1], pz = positions[c * 3 + 2];
    const bx = Math.floor(px * inv), by = Math.floor(py * inv), bz = Math.floor(pz * inv);
    let found = EMPTY, bestD2 = eps2;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const v = hash.get(bx + dx, by + dy, bz + dz);
      if (v === EMPTY) continue;
      const qx = verts[v * 3] - px, qy = verts[v * 3 + 1] - py, qz = verts[v * 3 + 2] - pz;
      const d2 = qx * qx + qy * qy + qz * qz;
      if (d2 <= bestD2) { bestD2 = d2; found = v; }
    }
    if (found === EMPTY) {
      verts[nVert * 3] = px; verts[nVert * 3 + 1] = py; verts[nVert * 3 + 2] = pz;
      hash.set(bx, by, bz, nVert);
      remap[c] = nVert++;
    } else {
      remap[c] = found;
    }
  }

  // Drop triangles that collapsed to a line or a point, and any whose area is
  // vanishing relative to the model. They carry no surface, they poison normal
  // and dihedral maths, and manifold rejects meshes containing them.
  const nTriIn = nCorner / 3;
  const tris = new Uint32Array(nTriIn * 3);
  const areaFloor = 1e-9 * diag * diag;
  let nTri = 0, degenerate = 0;
  for (let t = 0; t < nTriIn; t++) {
    const a = remap[t * 3], b = remap[t * 3 + 1], c = remap[t * 3 + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    const ux = verts[b * 3] - verts[a * 3], uy = verts[b * 3 + 1] - verts[a * 3 + 1], uz = verts[b * 3 + 2] - verts[a * 3 + 2];
    const vx = verts[c * 3] - verts[a * 3], vy = verts[c * 3 + 1] - verts[a * 3 + 1], vz = verts[c * 3 + 2] - verts[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (0.5 * Math.hypot(nx, ny, nz) < areaFloor) { degenerate++; continue; }
    tris[nTri * 3] = a; tris[nTri * 3 + 1] = b; tris[nTri * 3 + 2] = c;
    nTri++;
  }

  return {
    verts: verts.subarray(0, nVert * 3),
    tris: tris.subarray(0, nTri * 3),
    bbox: { min, max }, diag, eps, degenerate,
  };
}
