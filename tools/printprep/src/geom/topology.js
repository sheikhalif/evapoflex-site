/**
 * Triangle adjacency, normals, areas, and an honest audit of what is wrong with
 * the mesh.
 *
 * The audit matters as much as the adjacency. Manifold will refuse a mesh with
 * boundary edges or inconsistent winding, and it refuses at the point where the
 * user has already picked split planes and is expecting parts. Catching it here,
 * with counts of exactly what is broken, is the difference between "this STL has
 * 412 boundary edges and 3 shells" and a stack trace.
 */

const EMPTY = -1;
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/** Open-addressed map from an undirected vertex pair to a slot index. */
class EdgeHash {
  constructor(hint) {
    this.cap = nextPow2(Math.max(16, hint * 2));
    this.mask = this.cap - 1;
    this.ka = new Int32Array(this.cap).fill(EMPTY);
    this.kb = new Int32Array(this.cap);
    this.val = new Int32Array(this.cap);
    this.count = 0;
  }
  slot(a, b) {
    if (a > b) { const t = a; a = b; b = t; }
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) >>> 0;
    let i = h & this.mask;
    while (this.ka[i] !== EMPTY) {
      if (this.ka[i] === a && this.kb[i] === b) return i;
      i = (i + 1) & this.mask;
    }
    this.ka[i] = a; this.kb[i] = b; this.val[i] = EMPTY; this.count++;
    return i;
  }
}

/**
 * @returns {{
 *   triAdj: Int32Array,        // 3 per triangle: neighbour across edge k, or -1
 *   triAdjEdge: Int8Array,     // which edge of the neighbour it is
 *   normal: Float32Array,      // unit face normals, 3 per triangle
 *   area: Float32Array,
 *   nonManifoldEdges: number,  // edges with more than two incident faces
 *   boundaryEdges: number,     // edges with exactly one
 *   flippedEdges: number,      // shared edges traversed the same way by both faces
 *   edgeCount: number,
 * }}
 */
export function buildTopology(verts, tris) {
  const nTri = tris.length / 3;
  const triAdj = new Int32Array(nTri * 3).fill(-1);
  const triAdjEdge = new Int8Array(nTri * 3).fill(-1);
  const normal = new Float32Array(nTri * 3);
  const area = new Float32Array(nTri);

  for (let t = 0; t < nTri; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    area[t] = 0.5 * len;
    const s = len > 0 ? 1 / len : 0;
    normal[t * 3] = nx * s; normal[t * 3 + 1] = ny * s; normal[t * 3 + 2] = nz * s;
  }

  // Edge k of a triangle runs from local vertex k to local vertex (k+1)%3, so
  // its direction is fixed by the winding. Two faces sharing an edge in a
  // consistently wound closed mesh traverse it in opposite directions; if they
  // traverse it the same way, one of them is flipped.
  const hash = new EdgeHash(nTri * 3);
  const firstHalf = new Int32Array(hash.cap).fill(EMPTY);   // packed t*3+k of the first sighting
  const seen = new Int32Array(hash.cap);                    // incident count
  let nonManifoldEdges = 0, flippedEdges = 0;

  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const va = tris[t * 3 + k], vb = tris[t * 3 + (k + 1) % 3];
      const s = hash.slot(va, vb);
      seen[s]++;
      if (seen[s] === 1) {
        firstHalf[s] = t * 3 + k;
      } else if (seen[s] === 2) {
        const other = firstHalf[s];
        const ot = (other / 3) | 0, ok = other % 3;
        triAdj[t * 3 + k] = ot; triAdjEdge[t * 3 + k] = ok;
        triAdj[other] = t; triAdjEdge[other] = k;
        if (tris[ot * 3 + ok] === va) flippedEdges++;   // same direction => inconsistent winding
      } else {
        // Three or more faces on one edge. Leave both sides unlinked rather than
        // picking a pair arbitrarily: an arbitrary pick makes flood fills leak
        // across a self-intersection, and a leak is far worse than a seam.
        if (seen[s] === 3) {
          const other = firstHalf[s];
          const prev = triAdj[other];
          if (prev >= 0) {
            triAdj[prev * 3 + triAdjEdge[other]] = -1;
            triAdjEdge[prev * 3 + triAdjEdge[other]] = -1;
          }
          triAdj[other] = -1; triAdjEdge[other] = -1;
          nonManifoldEdges++;
        }
      }
    }
  }

  let boundaryEdges = 0;
  for (let i = 0; i < hash.cap; i++) if (hash.ka[i] !== EMPTY && seen[i] === 1) boundaryEdges++;

  return { triAdj, triAdjEdge, normal, area, nonManifoldEdges, boundaryEdges, flippedEdges, edgeCount: hash.count };
}

/** Dihedral angle in degrees across edge k of triangle t. NaN on a boundary. */
export function dihedralDeg(normal, triAdj, t, k) {
  const o = triAdj[t * 3 + k];
  if (o < 0) return NaN;
  const d = normal[t * 3] * normal[o * 3] + normal[t * 3 + 1] * normal[o * 3 + 1] + normal[t * 3 + 2] * normal[o * 3 + 2];
  return Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
}

/**
 * Convexity of edge k of triangle t.
 *
 * With e the edge direction in t's own winding order and nA, nB the two face
 * normals, cross(nA, nB) points along +e on a convex edge and against it on a
 * concave one. Getting this backwards silently turns a chamfer into a fillet, so
 * it is pinned by a unit-cube test.
 */
export function edgeIsConvex(verts, tris, normal, triAdj, t, k) {
  const o = triAdj[t * 3 + k];
  if (o < 0) return null;
  const va = tris[t * 3 + k] * 3, vb = tris[t * 3 + (k + 1) % 3] * 3;
  const ex = verts[vb] - verts[va], ey = verts[vb + 1] - verts[va + 1], ez = verts[vb + 2] - verts[va + 2];
  const ax = normal[t * 3], ay = normal[t * 3 + 1], az = normal[t * 3 + 2];
  const bx = normal[o * 3], by = normal[o * 3 + 1], bz = normal[o * 3 + 2];
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return (cx * ex + cy * ey + cz * ez) > 0;
}
