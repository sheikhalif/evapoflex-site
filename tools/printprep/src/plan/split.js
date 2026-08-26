/**
 * The split planner: recursive binary decomposition with a beam search.
 *
 * Everything here runs on the proxy soup with the pure-JS clipper - the real
 * booleans happen exactly once, after the plan is decided. That is what lets a
 * search over hundreds of candidate planes finish in well under a second
 * instead of minutes.
 *
 * The objective departs from Chopper's on purpose. Chopper minimises cut area,
 * which is right for glue. With a real mechanical joint the cut face needs to
 * be JUST BIG ENOUGH to host its joints - a beautiful minimal seam that cannot
 * take a 12 mm joint is worth nothing. So the joint-capacity term outweighs the
 * area term, and bed fit (with joint protrusions included) is a hard
 * constraint, never a weighted preference.
 */
import { clipSoup, soupBounds } from '../geom/meshclip.js';
import { areaProfile, sectionLoops } from '../geom/slice2d.js';
import { rasterize, distanceField } from '../geom/raster.js';
import { fitsWithJoints, fitPoints } from './fitTest.js';

const SQRT2 = Math.SQRT2;

/** Local minima of an area profile, plus midpoint, as candidate offsets. */
function candidateOffsets(profile, maxPer = 5) {
  const { offsets, areas } = profile;
  const N = areas.length;
  const out = [];
  for (let i = 2; i < N - 2; i++) {
    if (areas[i] > 0 &&
        areas[i] <= areas[i - 1] && areas[i] <= areas[i + 1] &&
        areas[i] < 0.96 * Math.max(areas[i - 2], areas[i + 2])) {
      out.push({ d: offsets[i], area: areas[i], why: 'neck' });
    }
  }
  out.sort((a, b) => a.area - b.area);
  const picks = out.slice(0, maxPer);
  picks.push({ d: offsets[N >> 1], area: areas[N >> 1], why: 'mid' });
  return picks;
}

/** Candidate planes for one piece: axis sweeps, dominant faces, principal axes. */
export function candidatePlanes(piece, analysis, opts = {}) {
  const soup = piece.soup;
  const cands = [];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  for (const n of axes) {
    const prof = areaProfile(soupVerts(soup), soupTris(soup), n, 96);
    for (const c of candidateOffsets(prof)) cands.push({ n, d: c.d, why: c.why + '-axis' });
  }

  // Dominant planar-region normals from the analysis, if we have them - cutting
  // parallel to a big face tends to give flat, joinable sections.
  if (analysis?.regions) {
    const top = analysis.regions
      .filter((r) => r.area > 0.01 * analysis.totalArea)
      .sort((a, b) => b.area - a.area).slice(0, 6);
    for (const r of top) {
      const n = r.n;
      // Skip near-axis normals - already covered.
      if (axes.some((a) => Math.abs(a[0] * n[0] + a[1] * n[1] + a[2] * n[2]) > 0.98)) continue;
      const prof = areaProfile(soupVerts(soup), soupTris(soup), n, 64);
      for (const c of candidateOffsets(prof, 3)) cands.push({ n, d: c.d, why: 'face' });
    }
  }

  // Guaranteed fallbacks: mid-box on each axis. The search must always have a
  // feasible completion available.
  const b = soupBounds(soup);
  for (let k = 0; k < 3; k++) {
    const n = axes[k];
    cands.push({ n, d: (b.min[k] + b.max[k]) / 2, why: 'fallback' });
  }
  return cands;
}

// The proxy soup is unindexed; slice2d wants (verts, tris) so give it an
// identity index view.
function soupVerts(soup) { return soup; }
function soupTris(soup) {
  const n = soup.length / 3;
  const t = new Uint32Array(n);
  for (let i = 0; i < n; i++) t[i] = i;
  return t;
}

/**
 * Score one candidate plane on one piece. Lower is better; Infinity rejects.
 *
 * Terms:
 *   jointCap   can the section host a joint of the target size, with margin?
 *   areaPen    |ln(area / ideal)| - the section should suit its joints
 *   thin       does the section keep any body after erosion by the block depth?
 *   seam       section perimeter relative to the piece - the visible scar
 *   balance    how evenly the cut divides the volume (proxy: bbox volumes)
 */
export function scorePlane(piece, plane, ctx) {
  const { n, d } = plane;
  const { a, b } = clipSoup(piece.soup, n, d);
  if (a.length < 27 || b.length < 27) return { cost: Infinity };

  const sec = sectionLoops(soupVerts(piece.soup), soupTris(piece.soup), n, d);
  if (sec.area < 1) return { cost: Infinity };

  // Joint capacity from the section's own distance field.
  const grid = rasterize(sec.loops.map((l) => l), { cell: Math.max(0.5, Math.sqrt(sec.area) / 96) });
  const fld = distanceField(grid);
  let maxD = 0;
  for (let i = 0; i < fld.d.length; i++) if (fld.d[i] > maxD) maxD = fld.d[i];
  const sFit = SQRT2 * (maxD - ctx.margin);
  if (sFit < 1.1 * ctx.sMin) return { cost: Infinity };     // cannot joint: reject outright

  const sTarget = Math.min(ctx.sMax, Math.max(ctx.sMin, sFit));
  const jointCap = Math.max(0, (ctx.sMax - sFit) / (ctx.sMax - ctx.sMin));

  const nTargetJoints = Math.max(1, Math.min(4, Math.floor(sec.area / (6 * sTarget * sTarget))));
  const areaIdeal = nTargetJoints * Math.pow(sTarget + 2 * ctx.margin, 2) / 0.35;
  const areaPen = Math.min(1, Math.abs(Math.log(sec.area / areaIdeal)) / Math.log(8));

  let perim = 0;
  for (const l of sec.loops) {
    for (let i = 0; i < l.length; i++) {
      const p = l[i], q = l[(i + 1) % l.length];
      perim += Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
  }
  const bb = soupBounds(piece.soup);
  const bboxPerim = 2 * ((bb.max[0] - bb.min[0]) + (bb.max[1] - bb.min[1]) + (bb.max[2] - bb.min[2]));
  const seam = Math.min(1, perim / (bboxPerim || 1));

  const va = boxVol(soupBounds(a)), vb = boxVol(soupBounds(b));
  const balance = Math.abs(va - vb) / (va + vb || 1);

  const axisAligned = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])].some((v) => v > 0.999);

  const cost =
    1.5 * jointCap +
    1.0 * areaPen +
    0.4 * seam +
    0.3 * balance +
    (axisAligned ? 0 : 0.25);

  return { cost, a, b, section: sec, sFit, sTarget, nTargetJoints };
}

const boxVol = (b) => Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1]) * Math.max(0, b.max[2] - b.min[2]);

/**
 * The search itself. States are whole configurations; each expansion splits the
 * worst-overflowing piece with one of its best candidate planes.
 *
 * @returns {{planes: {n,d}[], pieces: {soup, cutFaces}[], log: string[]}}
 */
export function planSplit(rootSoup, analysis, opts) {
  const bed = opts.bed;
  const prot = opts.protrusion;
  const margin = opts.margin ?? 2;
  const ctx = { sMin: opts.sMin ?? 12, sMax: opts.sMax ?? 25, margin: opts.jointMargin ?? 1.5 };
  const beamWidth = opts.beamWidth ?? 4;
  const maxDepth = opts.maxParts ?? 16;
  const deadline = performance.now() + (opts.budgetMs ?? 6000);
  const log = [];

  let nextId = 0;
  const all = new Map();
  const mkPiece = (soup, cutFaces) => {
    const p = { id: nextId++, soup, cutFaces, fit: null };
    all.set(p.id, p);
    return p;
  };
  const fitOf = (piece) => fitsWithJoints(fitPoints(piece.soup), piece.cutFaces, bed, prot, margin);

  const root = mkPiece(rootSoup, []);
  root.fit = fitOf(root);
  if (root.fit) {
    log.push('fits whole - no split needed');
    return { planes: [], pieces: [root], all, log };
  }

  let beam = [{ pieces: [root], planes: [], cost: 0 }];
  const seen = new Set();

  for (let depth = 0; depth < maxDepth; depth++) {
    const done = beam.find((s) => s.pieces.every((p) => p.fit));
    if (done) { log.push(`solved at depth ${depth}, ${done.pieces.length} pieces`); return finish(done, log, all); }
    if (performance.now() > deadline) { log.push('budget hit - taking best partial'); break; }

    const next = [];
    for (const state of beam) {
      // Expand the worst piece: the one that overflows the bed the most.
      let worst = -1, worstBy = -1;
      state.pieces.forEach((p, i) => {
        if (p.fit) return;
        const b = soupBounds(p.soup);
        const over = Math.max(
          b.max[0] - b.min[0] - bed.x, b.max[1] - b.min[1] - bed.y, b.max[2] - b.min[2] - bed.z);
        if (over > worstBy) { worstBy = over; worst = i; }
      });
      if (worst < 0) continue;
      const piece = state.pieces[worst];

      const cands = candidatePlanes(piece, analysis, opts);
      const scored = [];
      for (const c of cands) {
        const s = scorePlane(piece, c, ctx);
        if (s.cost < Infinity) scored.push({ ...c, ...s });
        if (performance.now() > deadline) break;
      }
      scored.sort((x, y) => x.cost - y.cost);

      for (const c of scored.slice(0, 6)) {
        const key = state.planes.map((p) => planeKey(p)).concat(planeKey(c)).sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const fa = { n: c.n.map((v) => -v), boundary: sectionBoundary3D(c.section), plane: { n: c.n, d: c.d } };
        const fb = { n: c.n.slice(), boundary: fa.boundary, plane: { n: c.n, d: c.d } };
        const pa = mkPiece(c.a, [...piece.cutFaces, fa]);
        const pb = mkPiece(c.b, [...piece.cutFaces, fb]);
        pa.fit = fitOf(pa); pb.fit = fitOf(pb);
        const pieces = state.pieces.slice();
        pieces.splice(worst, 1, pa, pb);
        next.push({
          pieces,
          // The tree structure travels with the plane: which piece it split and
          // what the two children are called. Execution on the real solids
          // replays exactly this, so the plan and the booleans cannot drift.
          planes: [...state.planes, {
            n: c.n, d: c.d, sTarget: c.sTarget, nJoints: c.nTargetJoints,
            parentId: piece.id, aId: pa.id, bId: pb.id,
          }],
          cost: state.cost + c.cost + 0.8,
        });
      }
    }
    if (!next.length) { log.push('no expansions possible'); break; }
    next.sort((x, y) => x.cost - y.cost);
    beam = next.slice(0, beamWidth);
  }

  const best = beam.slice().sort((x, y) =>
    (y.pieces.filter((p) => p.fit).length - x.pieces.filter((p) => p.fit).length) || (x.cost - y.cost))[0];
  log.push(`partial plan: ${best.pieces.filter((p) => p.fit).length}/${best.pieces.length} pieces fit`);
  return finish(best, log, all);
}

function finish(state, log, all) {
  return { planes: state.planes, pieces: state.pieces, all, log };
}

/**
 * A split tree from user-placed planes: each plane is applied, in order, to
 * every current piece it genuinely crosses. Same output shape as the search, so
 * execution downstream cannot tell who chose the planes.
 */
export function manualTree(rootSoup, planes) {
  let nextId = 0;
  const all = new Map();
  const mk = (soup, cutFaces) => { const p = { id: nextId++, soup, cutFaces, fit: true }; all.set(p.id, p); return p; };
  let pieces = [mk(rootSoup, [])];
  const outPlanes = [];
  for (const pl of planes) {
    const next = [];
    for (const piece of pieces) {
      const { a, b } = clipSoup(piece.soup, pl.n, pl.d);
      if (a.length < 27 || b.length < 27) { next.push(piece); continue; }
      // A cut that shaves a sliver is worse than no cut: the sliver cannot
      // carry a joint and prints as confetti. Both sides must have real depth
      // along the cut normal.
      const depthOf = (soup) => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < soup.length; i += 3) {
          const h = soup[i] * pl.n[0] + soup[i + 1] * pl.n[1] + soup[i + 2] * pl.n[2];
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
        return hi - lo;
      };
      if (depthOf(a) < 5 || depthOf(b) < 5) { next.push(piece); continue; }
      const sec = sectionLoops(piece.soup, identityTris(piece.soup), pl.n, pl.d);
      const boundary = sectionBoundary3D(sec);
      const pa = mk(a, [...piece.cutFaces, { n: pl.n.map((v) => -v), boundary }]);
      const pb = mk(b, [...piece.cutFaces, { n: pl.n.slice(), boundary }]);
      outPlanes.push({ n: pl.n, d: pl.d, parentId: piece.id, aId: pa.id, bId: pb.id });
      next.push(pa, pb);
    }
    pieces = next;
  }
  return { planes: outPlanes, pieces, all, log: [`manual: ${outPlanes.length} cuts, ${pieces.length} pieces`] };
}

function identityTris(soup) {
  const n = soup.length / 3;
  const t = new Uint32Array(n);
  for (let i = 0; i < n; i++) t[i] = i;
  return t;
}

function planeKey(p) {
  const q = (v) => Math.round(v * 50);
  return `${q(p.n[0])},${q(p.n[1])},${q(p.n[2])},${Math.round(p.d * 2)}`;
}

/** A sparse 3D boundary of the section, for the protrusion-inflated fit test. */
function sectionBoundary3D(sec) {
  const out = [];
  for (const l of sec.loops) {
    const stride = Math.max(1, Math.floor(l.length / 24));
    for (let i = 0; i < l.length; i += stride) {
      const [x, y] = l[i];
      out.push([
        sec.u[0] * x + sec.w[0] * y + sec.n[0] * sec.d,
        sec.u[1] * x + sec.w[1] * y + sec.n[1] * sec.d,
        sec.u[2] * x + sec.w[2] * y + sec.n[2] * sec.d,
      ]);
    }
  }
  return out;
}
