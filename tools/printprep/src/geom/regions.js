/**
 * Turning triangle soup into something that looks and behaves like CAD.
 *
 * An STL has no faces, only triangles, and no amount of cleverness recovers the
 * original B-rep. What can be recovered is the grouping: which triangles lie on
 * one flat face, which belong to one cylindrical bore, and which edges between
 * them are real features rather than tessellation. That grouping is what makes
 * the model render like a solid instead of a wireframe hairball, and it is what
 * gives the user something to click on when placing a split plane.
 *
 * Two passes, in this order for a reason.
 *
 *   Pass A - smooth shells. Flood fill across edges whose dihedral angle is
 *   under a threshold. Every edge the fill refuses to cross is, by construction,
 *   a feature edge. So this pass produces the wireframe overlay for free, and it
 *   fences off each curved surface (a bore, a fillet) into its own shell before
 *   the planar pass can wander into it.
 *
 *   Pass B - planar regions within a shell. The obvious rule, "grow while this
 *   triangle's normal is close to its neighbour's", drifts: on a coarsely
 *   tessellated cylinder each step is under the threshold and the whole barrel
 *   becomes one "plane". Growing against the region's own accumulated plane
 *   instead, and re-fitting it as the region grows, does not drift.
 */

const D2R = Math.PI / 180;

/**
 * @param {object} m  {verts, tris, diag, normal, area, triAdj}
 * @param {object} [opts]
 *   featureDeg  dihedral above which an edge is a feature and a shell boundary
 *   planeDeg    how far a triangle's normal may sit from the region plane normal
 *   planeTolMm  how far a triangle's vertices may sit off the region plane
 */
export function extractRegions(m, opts = {}) {
  const featureDeg = opts.featureDeg ?? 25;
  const planeDeg = opts.planeDeg ?? 1.0;
  const planeTol = opts.planeTolMm ?? Math.max(0.02, 1e-4 * m.diag);
  const { verts, tris, normal, area, triAdj } = m;
  const nTri = area.length;

  // ---------------------------------------------------------------- pass A
  const cosFeature = Math.cos(featureDeg * D2R);
  const triShell = new Int32Array(nTri).fill(-1);
  const stack = new Int32Array(nTri);
  const shells = [];

  for (let seed = 0; seed < nTri; seed++) {
    if (triShell[seed] !== -1) continue;
    const id = shells.length;
    let sp = 0, count = 0, areaSum = 0;
    stack[sp++] = seed; triShell[seed] = id;
    while (sp > 0) {
      const t = stack[--sp];
      count++; areaSum += area[t];
      for (let k = 0; k < 3; k++) {
        const o = triAdj[t * 3 + k];
        if (o < 0 || triShell[o] !== -1) continue;
        const d = normal[t * 3] * normal[o * 3] + normal[t * 3 + 1] * normal[o * 3 + 1] + normal[t * 3 + 2] * normal[o * 3 + 2];
        if (d < cosFeature) continue;                 // feature edge: do not cross
        triShell[o] = id; stack[sp++] = o;
      }
    }
    shells.push({ id, triCount: count, area: areaSum, kind: 'freeform', tris: null });
  }

  // ---------------------------------------------------------------- pass B
  // Seeding from the largest triangle first means the faces a user is most
  // likely to want to click become region 0, 1, 2 ... rather than whichever
  // sliver happened to be first in the file.
  const order = new Uint32Array(nTri);
  for (let i = 0; i < nTri; i++) order[i] = i;
  const bigFirst = Array.from(order).sort((a, b) => area[b] - area[a]);

  const cosPlane = Math.cos(planeDeg * D2R);
  const triRegion = new Int32Array(nTri).fill(-1);
  const regions = [];

  for (const seed of bigFirst) {
    if (triRegion[seed] !== -1) continue;
    const id = regions.length;
    // Accumulated area-weighted normal and centroid. The region plane is re-fitted
    // from these as it grows, which is what stops drift.
    let ax = normal[seed * 3] * area[seed], ay = normal[seed * 3 + 1] * area[seed], az = normal[seed * 3 + 2] * area[seed];
    let cx = 0, cy = 0, cz = 0, wsum = 0;
    let nx = normal[seed * 3], ny = normal[seed * 3 + 1], nz = normal[seed * 3 + 2], d = 0;
    let refitAt = 32, accepted = 0, areaSum = 0;
    const members = [];
    let sp = 0;
    stack[sp++] = seed; triRegion[seed] = id;

    const addCentroid = (t, w) => {
      for (let k = 0; k < 3; k++) {
        const v = tris[t * 3 + k] * 3;
        cx += verts[v] * w / 3; cy += verts[v + 1] * w / 3; cz += verts[v + 2] * w / 3;
      }
      wsum += w;
    };
    const refit = () => {
      const len = Math.hypot(ax, ay, az) || 1;
      nx = ax / len; ny = ay / len; nz = az / len;
      d = -(nx * cx / wsum + ny * cy / wsum + nz * cz / wsum);
    };
    addCentroid(seed, area[seed]); refit();

    while (sp > 0) {
      const t = stack[--sp];
      members.push(t); accepted++; areaSum += area[t];
      if (accepted >= refitAt) { refit(); refitAt *= 2; }
      for (let k = 0; k < 3; k++) {
        const o = triAdj[t * 3 + k];
        if (o < 0 || triRegion[o] !== -1 || triShell[o] !== triShell[t]) continue;
        const dot = nx * normal[o * 3] + ny * normal[o * 3 + 1] + nz * normal[o * 3 + 2];
        if (dot < cosPlane) continue;
        let far = 0;
        for (let j = 0; j < 3; j++) {
          const v = tris[o * 3 + j] * 3;
          const dist = Math.abs(nx * verts[v] + ny * verts[v + 1] + nz * verts[v + 2] + d);
          if (dist > far) far = dist;
        }
        if (far > planeTol) continue;
        triRegion[o] = id; stack[sp++] = o;
        ax += normal[o * 3] * area[o]; ay += normal[o * 3 + 1] * area[o]; az += normal[o * 3 + 2] * area[o];
        addCentroid(o, area[o]);
      }
    }
    refit();
    regions.push({
      id, shellId: triShell[seed], triCount: members.length, area: areaSum,
      n: [nx, ny, nz], d, centroid: [cx / wsum, cy / wsum, cz / wsum],
      tris: Uint32Array.from(members), planar: members.length > 1 || areaSum > 0,
    });
  }

  // A shell that is exactly one planar region is a flat face; that is the single
  // most useful thing to know about it, and it makes the primitive fitter's job
  // smaller.
  const regionsPerShell = new Int32Array(shells.length);
  for (const r of regions) regionsPerShell[r.shellId]++;
  for (const s of shells) if (regionsPerShell[s.id] === 1) s.kind = 'planar';

  return { triShell, shells, triRegion, regions, featureDeg, planeTol };
}

/**
 * Boundary loops of a region, as arrays of vertex indices, wound consistently
 * with the region's own triangles.
 *
 * Used for the outline overlay and, more importantly, as the polygon a split
 * plane snaps to when the user clicks a face. The outer loop comes first; any
 * remaining loops are holes.
 */
export function regionBoundary(m, region, triRegion) {
  const { tris, triAdj } = m;
  const starts = [], ends = [];
  for (const t of region.tris) {
    for (let k = 0; k < 3; k++) {
      const o = triAdj[t * 3 + k];
      if (o >= 0 && triRegion[o] === region.id) continue;
      starts.push(tris[t * 3 + k]);
      ends.push(tris[t * 3 + (k + 1) % 3]);
    }
  }
  // Bucket half-edges by their start vertex so the walk is O(E) rather than a
  // linear scan per step.
  const bucket = new Map();
  for (let i = 0; i < starts.length; i++) {
    let b = bucket.get(starts[i]);
    if (!b) bucket.set(starts[i], (b = []));
    b.push(i);
  }
  const used = new Uint8Array(starts.length);
  const loops = [];
  for (let i = 0; i < starts.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [starts[i]];
    let cur = ends[i];
    const first = starts[i];
    let guard = starts.length + 1;
    while (cur !== first && guard-- > 0) {
      const b = bucket.get(cur);
      let next = -1;
      if (b) for (const e of b) if (!used[e]) { next = e; break; }
      if (next < 0) break;                 // open chain: non-manifold input
      used[next] = 1;
      loop.push(cur);
      cur = ends[next];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  // Largest projected area first, so loops[0] is the outer boundary.
  const n = region.n;
  const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(n, ax)), v = cross(n, u);
  const areaOf = (loop) => {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i] * 3, q = loop[(i + 1) % loop.length] * 3;
      const px = m.verts[p] * u[0] + m.verts[p + 1] * u[1] + m.verts[p + 2] * u[2];
      const py = m.verts[p] * v[0] + m.verts[p + 1] * v[1] + m.verts[p + 2] * v[2];
      const qx = m.verts[q] * u[0] + m.verts[q + 1] * u[1] + m.verts[q + 2] * u[2];
      const qy = m.verts[q] * v[0] + m.verts[q + 1] * v[1] + m.verts[q + 2] * v[2];
      a += px * qy - qx * py;
    }
    return Math.abs(a) / 2;
  };
  loops.sort((a, b) => areaOf(b) - areaOf(a));
  return loops;
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
