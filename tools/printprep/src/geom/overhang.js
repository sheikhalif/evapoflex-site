/**
 * Overhang auditing: which down-facing surface would need support, in a given
 * build direction.
 *
 * One implementation, three callers - the joint's six-direction self-check, the
 * orientation solver's main scoring term, and the split objective's "can this
 * piece be printed at all" proxy. Keeping it single means the number the user
 * sees on the orientation card is the same number the planner optimised, which
 * is the only way either is trustworthy.
 *
 * Two details do the real work:
 *
 *   Faces resting on the build plate are not overhangs. Obvious, and easy to get
 *   wrong: the entire bottom face of any part is a 90 degree overhang by angle
 *   alone.
 *
 *   Narrow patches bridge. A 1.5 mm flat ceiling between two walls prints fine
 *   because the extruder spans it; a 30 mm one does not. Measuring the minor
 *   axis of each connected patch, not its area, is what separates the two.
 */

const SIN45 = Math.sin(Math.PI / 4);

/**
 * @param {object} m  {verts, tris, normal, area, triAdj}
 * @param {number[]} d  build direction (which way is up), unit
 */
export function overhangAudit(m, d, opts = {}) {
  const angleDeg = opts.angleDeg ?? 45;
  const bridgeMm = opts.bridgeMm ?? 2.0;
  const plateTol = opts.plateTol ?? 0.05;
  const limit = Math.sin(angleDeg * Math.PI / 180);
  const { verts, tris, normal, area, triAdj } = m;
  const nTri = area.length;

  let floor = Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const h = verts[i] * d[0] + verts[i + 1] * d[1] + verts[i + 2] * d[2];
    if (h < floor) floor = h;
  }

  const over = new Uint8Array(nTri);
  const sinT = new Float32Array(nTri);
  let candidates = 0;
  for (let t = 0; t < nTri; t++) {
    const s = -(normal[t * 3] * d[0] + normal[t * 3 + 1] * d[1] + normal[t * 3 + 2] * d[2]);
    sinT[t] = s;
    if (s <= limit + 1e-4) continue;
    let onPlate = true;
    for (let k = 0; k < 3 && onPlate; k++) {
      const v = tris[t * 3 + k] * 3;
      if (verts[v] * d[0] + verts[v + 1] * d[1] + verts[v + 2] * d[2] > floor + plateTol) onPlate = false;
    }
    if (onPlate) continue;
    over[t] = 1; candidates++;
  }
  if (candidates === 0) {
    return { unsupportedMm2: 0, bridgedMm2: 0, worstDeg: 0, patches: [], floor };
  }

  // Two axes perpendicular to the build direction, for measuring patch width.
  const up = Math.abs(d[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = unit(cross(d, up)), w = cross(d, u);

  // Group connected, near-coplanar overhang faces. Coplanarity matters: two
  // steep faces meeting at an angle are separate islands to the extruder even
  // though they touch.
  const comp = new Int32Array(nTri).fill(-1);
  const stack = [];
  const patches = [];
  let unsupported = 0, bridged = 0, worst = 0;

  for (let seed = 0; seed < nTri; seed++) {
    if (!over[seed] || comp[seed] !== -1) continue;
    const id = patches.length;
    stack.length = 0; stack.push(seed); comp[seed] = id;
    const members = [];
    let a = 0, maxSin = 0;
    let uMin = Infinity, uMax = -Infinity, wMin = Infinity, wMax = -Infinity;
    while (stack.length) {
      const t = stack.pop();
      members.push(t); a += area[t];
      if (sinT[t] > maxSin) maxSin = sinT[t];
      for (let k = 0; k < 3; k++) {
        const v = tris[t * 3 + k] * 3;
        const pu = verts[v] * u[0] + verts[v + 1] * u[1] + verts[v + 2] * u[2];
        const pw = verts[v] * w[0] + verts[v + 1] * w[1] + verts[v + 2] * w[2];
        if (pu < uMin) uMin = pu; if (pu > uMax) uMax = pu;
        if (pw < wMin) wMin = pw; if (pw > wMax) wMax = pw;
      }
      for (let k = 0; k < 3; k++) {
        const o = triAdj[t * 3 + k];
        if (o < 0 || !over[o] || comp[o] !== -1) continue;
        const dp = Math.abs(normal[t * 3] * normal[o * 3] + normal[t * 3 + 1] * normal[o * 3 + 1] + normal[t * 3 + 2] * normal[o * 3 + 2]);
        if (dp <= 0.999) continue;
        comp[o] = id; stack.push(o);
      }
    }
    const span = Math.min(uMax - uMin, wMax - wMin);
    const deg = Math.asin(Math.min(1, maxSin)) * 180 / Math.PI;
    const patch = { id, area: a, span, worstDeg: deg, tris: members, bridgeable: span <= bridgeMm };
    if (patch.bridgeable) bridged += a;
    else { unsupported += a; if (deg > worst) worst = deg; }
    patches.push(patch);
  }

  return {
    unsupportedMm2: unsupported, bridgedMm2: bridged,
    worstDeg: worst, patches, floor,
  };
}

const DIRS = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0],
  '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};

/**
 * The joint's own acceptance test: printable without support in all six
 * axis-aligned build directions, for both halves. Port of check_joint() from
 * evf_joint.py.
 */
export function checkJoint(m, opts = {}) {
  let unsupported = 0, bridgedTotal = 0, worst = 0;
  const perDir = {};
  for (const [name, d] of Object.entries(DIRS)) {
    const r = overhangAudit(m, d, opts);
    perDir[name] = { unsupportedMm2: round2(r.unsupportedMm2), worstDeg: round1(r.worstDeg) };
    unsupported += r.unsupportedMm2;
    bridgedTotal += r.bridgedMm2;
    if (r.worstDeg > worst) worst = r.worstDeg;
  }
  return {
    unsupported_mm2: round2(unsupported),
    worst_overhang_deg: round1(worst),
    bridged_mm2: round2(bridgedTotal),
    perDir,
    pass: unsupported < (opts.allowMm2 ?? 0.01),
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function unit(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
export { SIN45, DIRS };
