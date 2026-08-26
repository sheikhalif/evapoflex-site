/**
 * Auto-chamfering convex right-angle edges.
 *
 * Each qualifying edge chain gets a triangular-prism cutter: hull of six points,
 * two at each end of the (extended) segment - the edge point itself and the two
 * points sitting distance c along each adjacent face. Extending 2c past the
 * ends makes neighbouring cutters overlap instead of leaving slivers; where
 * three chamfered edges meet, the three wedges still miss a small corner
 * tetrahedron, so a junction hull is added over each such vertex.
 *
 * The tangent directions are the part that silently goes wrong: tA must point
 * along face A away from the edge, and flipping it turns the cutter inside out
 * so the boolean ADDS a ridge instead of cutting one. The sign convention is
 * pinned by a unit-cube test, not by eyeballing renders.
 */
import { ctx, forceEval } from './manifoldCtx.js';

/**
 * Build cutters for a set of chains and subtract them in batches.
 * @param {Manifold} solid
 * @param {object[]} chains  [{segments: [{p0, p1, nA, nB}], c}]
 * @returns {Manifold} a new solid; the input is left alive for the caller
 */
export function chamferChains(solid, chains, { batch = 48, onProgress } = {}) {
  const { Manifold } = ctx();
  const cutters = [];
  const junctions = new Map();      // vertex key -> {v, dirs: []}

  for (const chain of chains) {
    const c = chain.c;
    for (const seg of chain.segments) {
      const cut = cutterForSegment(seg, c);
      if (cut) cutters.push(cut);
      for (const [v, other] of [[seg.p0, seg.p1], [seg.p1, seg.p0]]) {
        const k = `${Math.round(v[0] * 100)},${Math.round(v[1] * 100)},${Math.round(v[2] * 100)}`;
        if (!junctions.has(k)) junctions.set(k, { v, arms: [] });
        junctions.get(k).arms.push({ seg, away: unit(sub(other, v)), c });
      }
    }
  }

  // A junction needs covering when three or more chamfered edges meet.
  for (const { v, arms } of junctions.values()) {
    if (arms.length < 3) continue;
    const pts = [v.slice()];
    for (const { seg, away, c } of arms) {
      pts.push(add(v, scale(seg.tA, c)), add(v, scale(seg.tB, c)), add(v, scale(away, c)));
    }
    try { cutters.push(ctx().Manifold.hull(pts)); } catch { /* degenerate corner */ }
  }

  let acc = solid;
  let owned = false;
  for (let i = 0; i < cutters.length; i += batch) {
    const group = cutters.slice(i, i + batch);
    const next = forceEval(Manifold.difference([acc, ...group]));
    if (owned) acc.delete();
    acc = next; owned = true;
    group.forEach((g) => g.delete());
    onProgress?.(Math.min(1, (i + batch) / cutters.length));
  }
  return { result: owned ? acc : forceEval(Manifold.difference([acc])), cutterCount: cutters.length };
}

/**
 * Six-point prism for one segment. Also decorates the segment with tA/tB for
 * junction hulls.
 */
export function cutterForSegment(seg, c) {
  const { p0, p1, nA, nB } = seg;
  const e = unit(sub(p1, p0));
  if (!isFinite(e[0])) return null;

  // In face A, perpendicular to the edge, away from the material of B.
  let tA = unit(cross(nA, e));
  if (dot(tA, nB) > 0) tA = neg(tA);
  let tB = unit(cross(e, nB));
  if (dot(tB, nA) > 0) tB = neg(tB);
  seg.tA = tA; seg.tB = tB;

  const ext = 2 * c;
  const q0 = sub(p0, scale(e, ext)), q1 = add(p1, scale(e, ext));
  const pts = [];
  for (const q of [q0, q1]) pts.push(q, add(q, scale(tA, c)), add(q, scale(tB, c)));
  try { return ctx().Manifold.hull(pts); } catch { return null; }
}

/**
 * Select chains worth chamfering from the feature analysis, and size each one.
 *
 * localFeatureSize is approximated per chain as the shorter of its two adjacent
 * regions' inradius proxies (area / halfPerimeter would be better; sqrt(area)
 * is close enough to keep a chamfer from eating a small face).
 */
export function selectChains(featureChains, edges, verts, tris, normal, regions, opts = {}) {
  const angleTol = opts.angleTol ?? 5;
  const cMin = opts.cMin ?? 0.4, cMax = opts.cMax ?? 2.0;
  const maxChains = opts.maxChains ?? 300;

  const out = [];
  for (const ch of featureChains) {
    if (!ch.convex) continue;
    if (Math.abs(ch.angle - 90) > angleTol) continue;

    // Feature-size guardrails.
    const rA = regions[ch.regA], rB = ch.regB >= 0 ? regions[ch.regB] : null;
    const sizes = [rA, rB].filter(Boolean).map((r) => Math.sqrt(r.area));
    const local = Math.min(...sizes, Infinity);
    let c = clamp(0.25 * local, cMin, cMax);
    c = Math.round(c / 0.2) * 0.2;
    if (ch.length < 4 * c) continue;                       // too short to matter
    if (sizes.some((s) => s * s < 10 * c * c)) continue;   // would eat a small face

    const segments = ch.edges.map((ei) => {
      const e = edges[ei];
      if (e.o == null || e.o < 0) return null;    // boundary edge: nothing to chamfer against
      return {
        p0: [verts[e.va * 3], verts[e.va * 3 + 1], verts[e.va * 3 + 2]],
        p1: [verts[e.vb * 3], verts[e.vb * 3 + 1], verts[e.vb * 3 + 2]],
        nA: [normal[e.t * 3], normal[e.t * 3 + 1], normal[e.t * 3 + 2]],
        nB: [normal[e.o * 3], normal[e.o * 3 + 1], normal[e.o * 3 + 2]],
      };
    }).filter(Boolean);
    if (!segments.length) continue;
    out.push({ c, segments, length: ch.length, angle: ch.angle });
  }
  out.sort((a, b) => b.length - a.length);
  return { chains: out.slice(0, maxChains), dropped: Math.max(0, out.length - maxChains) };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const neg = (a) => [-a[0], -a[1], -a[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [NaN, NaN, NaN]; };
