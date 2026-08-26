/**
 * Choosing how each part sits on the plate.
 *
 * Two tiers, because the terms have wildly different costs. Every candidate
 * direction gets the cheap terms - overhang estimate from the normal histogram,
 * height, hole-axis alignment, joint-axis alignment, bed fit. The best twenty
 * get the exact terms: the real overhang audit with plate contact and bridging,
 * bed contact area, and centre-of-mass stability. The user sees the top five.
 *
 * The weights encode one strong opinion: a joint that prints badly scraps the
 * whole print, so jointPrintability outranks every soft term. Supports being
 * needed is an inconvenience; a snap that does not snap is a failure.
 */
import { estimateOverhang, estimateShadow } from '../geom/normalHist.js';
import { overhangAudit } from '../geom/overhang.js';

/** Candidate build directions for a part. */
export function candidateDirs(analysis, jointAxes = [], cutNormals = []) {
  const out = [];
  const push = (v, why) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l < 1e-6) return;
    const u = [v[0] / l, v[1] / l, v[2] / l];
    for (const q of out) if (q.d[0] * u[0] + q.d[1] * u[1] + q.d[2] * u[2] > 0.996) return;   // ~5 deg dedupe
    out.push({ d: u, why });
  };

  // Axis-aligned and corner diagonals - always in the running.
  for (const s of [-1, 1]) { push([s, 0, 0], 'axis'); push([0, s, 0], 'axis'); push([0, 0, s], 'axis'); }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) push([x, y, z], 'diag');

  // Big planar faces down: printing on a large flat face is the classic win.
  if (analysis?.regions) {
    for (const r of analysis.regions.slice().sort((a, b) => b.area - a.area).slice(0, 20)) {
      push(r.n.map((v) => -v), 'face-down');
    }
  }
  // Hole axes vertical: circularity survives, and so does the dimension.
  if (analysis?.cylinders) {
    for (const c of analysis.cylinders) { push(c.axis, 'hole'); push(c.axis.map((v) => -v), 'hole'); }
  }
  // Cut faces up or down: joints print best square to the plate.
  for (const n of cutNormals) { push(n, 'cut'); push(n.map((v) => -v), 'cut'); }
  for (const a of jointAxes) { push(a, 'joint'); push(a.map((v) => -v), 'joint'); }
  return out;
}

/**
 * @param {object} part  {m: analysed mesh, hist, bbox, jointAxes, cutNormals, totalArea}
 * @param {{x,y,z}} bed
 * @returns ranked orientations, best first
 */
export function rankOrientations(part, bed, opts = {}) {
  const dirs = candidateDirs(part.analysis, part.jointAxes, part.cutNormals);
  const maxDim = Math.max(...part.size);
  const totalArea = part.totalArea || 1;

  // ---- tier 1: cheap terms for everyone
  const scored = dirs.map(({ d, why }) => {
    const up = d;
    const height = extentAlong(part.m.verts, up);
    const lateral = lateralExtents(part.m.verts, up);
    const fitsBed = height <= bed.z - 1 &&
      Math.min(lateral.a, lateral.b) <= Math.min(bed.x, bed.y) - 4 &&
      Math.max(lateral.a, lateral.b) <= Math.max(bed.x, bed.y) - 4;
    if (!fitsBed) return null;

    const over = estimateOverhang(part.hist, up) / totalArea;
    const loadAxis = part.jointAxes.length
      ? Math.max(...part.jointAxes.map((a) => Math.abs(a[0] * up[0] + a[1] * up[1] + a[2] * up[2])))
      : 0;
    const holeMiss = holeAxisMiss(part.analysis, up);
    const cheap =
      1.0 * over +
      0.6 * (1 - loadAxis) +        // mating axis along the layers = snap loads peel layers apart; upright is strong
      0.5 * (height / (maxDim || 1)) +
      0.4 * holeMiss;
    return { up, why, cheap, height };
  }).filter(Boolean);

  scored.sort((a, b) => a.cheap - b.cheap);

  // ---- tier 2: exact terms for the shortlist
  const short = scored.slice(0, opts.shortlist ?? 20).map((cand) => {
    const audit = overhangAudit(part.m, cand.up, { bridgeMm: 2 });
    const contact = plateContact(part.m, cand.up);
    const com = comStability(part.m, cand.up);
    const jointBad = jointFaceOverhang(part, cand.up, audit);
    const exact =
      1.2 * jointBad +
      1.0 * (audit.unsupportedMm2 / totalArea) +
      0.9 * Math.max(0, 1 - contact.frac / 0.10) * 0.5 +
      0.7 * com +
      cand.cheap * 0.5;
    return {
      ...cand, exact,
      unsupportedMm2: audit.unsupportedMm2,
      worstDeg: audit.worstDeg,
      contactMm2: contact.mm2,
      needsSupport: audit.unsupportedMm2 > 4,
    };
  });
  short.sort((a, b) => a.exact - b.exact);
  return short.slice(0, opts.keep ?? 5);
}

/**
 * Fraction of hole-axis area whose axis is NOT within 10 degrees of vertical.
 * Holes printed off-axis come out oval and undersized; this term nudges the
 * ranking toward orientations that keep the bores round.
 */
function holeAxisMiss(analysis, up) {
  const cyls = analysis?.cylinders?.filter((c) => c.isHole);
  if (!cyls || !cyls.length) return 0;
  let hit = 0, tot = 0;
  for (const c of cyls) {
    const w = c.radius * c.extent;
    tot += w;
    const d = Math.abs(c.axis[0] * up[0] + c.axis[1] * up[1] + c.axis[2] * up[2]);
    if (d > 0.985) hit += w;
  }
  return tot ? 1 - hit / tot : 0;
}

function extentAlong(verts, d) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const h = verts[i] * d[0] + verts[i + 1] * d[1] + verts[i + 2] * d[2];
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return hi - lo;
}

function lateralExtents(verts, up) {
  const ref = Math.abs(up[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = unit(cross(up, ref)), v = cross(up, u);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i] * u[0] + verts[i + 1] * u[1] + verts[i + 2] * u[2];
    const y = verts[i] * v[0] + verts[i + 1] * v[1] + verts[i + 2] * v[2];
    if (x < a0) a0 = x; if (x > a1) a1 = x;
    if (y < b0) b0 = y; if (y > b1) b1 = y;
  }
  return { a: a1 - a0, b: b1 - b0 };
}

/** Area within 0.2 mm of the lowest point - what actually adheres. */
function plateContact(m, up) {
  const { verts, tris, area, normal } = m;
  let floor = Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const h = verts[i] * up[0] + verts[i + 1] * up[1] + verts[i + 2] * up[2];
    if (h < floor) floor = h;
  }
  let mm2 = 0, tot = 0;
  const nTri = area.length;
  for (let t = 0; t < nTri; t++) {
    tot += area[t];
    // Down-facing and low.
    const nd = normal[t * 3] * up[0] + normal[t * 3 + 1] * up[1] + normal[t * 3 + 2] * up[2];
    if (nd > -0.966) continue;
    let low = true;
    for (let k = 0; k < 3 && low; k++) {
      const v = tris[t * 3 + k] * 3;
      if (verts[v] * up[0] + verts[v + 1] * up[1] + verts[v + 2] * up[2] > floor + 0.2) low = false;
    }
    if (low) mm2 += area[t];
  }
  return { mm2, frac: tot ? mm2 / tot : 0 };
}

/** 0 = COM well inside the footprint, 1 = outside (tippy). */
function comStability(m, up) {
  const { verts, tris, area } = m;
  const ref = Math.abs(up[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = unit(cross(up, ref)), v = cross(up, u);
  let cx = 0, cy = 0, wsum = 0;
  let floor = Infinity;
  const nTri = area.length;
  for (let t = 0; t < nTri; t++) {
    let px = 0, py = 0, h = 0;
    for (let k = 0; k < 3; k++) {
      const w = tris[t * 3 + k] * 3;
      px += (verts[w] * u[0] + verts[w + 1] * u[1] + verts[w + 2] * u[2]) / 3;
      py += (verts[w] * v[0] + verts[w + 1] * v[1] + verts[w + 2] * v[2]) / 3;
      h = Math.min(h, verts[w] * up[0] + verts[w + 1] * up[1] + verts[w + 2] * up[2]);
    }
    cx += px * area[t]; cy += py * area[t]; wsum += area[t];
    if (h < floor) floor = h;
  }
  cx /= wsum; cy /= wsum;
  // Footprint proxy: the spread of near-floor vertices.
  let f0 = Infinity, f1 = -Infinity, g0 = Infinity, g1 = -Infinity, any = false;
  for (let i = 0; i < verts.length; i += 3) {
    const h = verts[i] * up[0] + verts[i + 1] * up[1] + verts[i + 2] * up[2];
    if (h > floor + 1.0) continue;
    any = true;
    const x = verts[i] * u[0] + verts[i + 1] * u[1] + verts[i + 2] * u[2];
    const y = verts[i] * v[0] + verts[i + 1] * v[1] + verts[i + 2] * v[2];
    if (x < f0) f0 = x; if (x > f1) f1 = x;
    if (y < g0) g0 = y; if (y > g1) g1 = y;
  }
  if (!any || f1 - f0 < 1e-6 || g1 - g0 < 1e-6) return 1;
  const inX = (cx - f0) / (f1 - f0), inY = (cy - g0) / (g1 - g0);
  if (inX < 0 || inX > 1 || inY < 0 || inY > 1) return 1;
  return Math.max(Math.abs(inX - 0.5), Math.abs(inY - 0.5)) * 2 * 0.5;
}

/**
 * Overhang belonging to joint zones. The stamp records each joint's centre and
 * S; unsupported patches within a joint's box mean the joint itself would need
 * support, which defeats its whole design.
 */
function jointFaceOverhang(part, up, audit) {
  if (!part.joints?.length || !audit.patches.length) return 0;
  let bad = 0;
  for (const p of audit.patches) {
    if (p.bridgeable) continue;
    for (const t of p.tris.slice(0, 50)) {
      const c = triCentroid(part.m, t);
      for (const j of part.joints) {
        const dx = c[0] - j.center[0], dy = c[1] - j.center[1], dz = c[2] - j.center[2];
        if (Math.hypot(dx, dy, dz) < j.S) { bad += p.area; break; }
      }
      break;    // one representative triangle per patch is enough
    }
  }
  return Math.min(1, bad / 100);
}

function triCentroid(m, t) {
  const o = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = m.tris[t * 3 + k] * 3;
    o[0] += m.verts[v] / 3; o[1] += m.verts[v + 1] / 3; o[2] += m.verts[v + 2] / 3;
  }
  return o;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
