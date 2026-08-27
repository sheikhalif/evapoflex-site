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

/**
 * A lower bound on how many more cuts a set of pieces needs.
 *
 * Each piece needs at least enough parallel divisions per axis to bring its
 * extent under the printable span, and a piece that splits into m parts took at
 * least m - 1 cuts. It ignores shape entirely - a disc is treated as its
 * bounding box - which is exactly what a bound should do: never overestimate.
 */
function remainingCuts(pieces, bed, margin, prot) {
  const lim = [bed.x - 2 * margin - prot, bed.y - 2 * margin - prot, bed.z - margin];
  let n = 0;
  for (const p of pieces) {
    if (p.fit) continue;
    const b = soupBounds(p.soup);
    let parts = 1;
    for (let k = 0; k < 3; k++) {
      if (!(lim[k] > 1)) continue;
      parts *= Math.max(1, Math.ceil((b.max[k] - b.min[k]) / lim[k]));
    }
    n += parts - 1;
  }
  return n;
}

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

/**
 * Candidate planes for one piece: axis sweeps, dominant faces, principal axes.
 *
 * `opts.overflowAxes` restricts the directions to ones that can actually help.
 * A 520 x 400 x 24 panel is oversize in x and y; a z-normal cut slices it into
 * thinner panels that are exactly as unprintable as before, and because those
 * sections are huge and flat the objective LIKED them - the search once turned
 * that panel into eleven stacked slabs, some zero millimetres thick. A cut can
 * only reduce an overflow if its normal has real component along an
 * overflowing axis, so directions that do not are never offered.
 */
export function candidatePlanes(piece, analysis, opts = {}) {
  const soup = piece.soup;
  const cands = [];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const over = opts.overflowAxes;   // e.g. [true, true, false], or null for all
  const helps = (n) => !over || over.some((o, k) => o && Math.abs(n[k]) > 0.5);

  for (const n of axes) {
    if (!helps(n)) continue;
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
      if (!helps(n)) continue;
      // Skip near-axis normals - already covered.
      if (axes.some((a) => Math.abs(a[0] * n[0] + a[1] * n[1] + a[2] * n[2]) > 0.98)) continue;
      const prof = areaProfile(soupVerts(soup), soupTris(soup), n, 64);
      for (const c of candidateOffsets(prof, 3)) cands.push({ n, d: c.d, why: 'face' });
    }
  }

  // Guaranteed fallbacks: mid-box on each helpful axis. The search must always
  // have a feasible completion available.
  const b = soupBounds(soup);
  for (let k = 0; k < 3; k++) {
    const n = axes[k];
    if (!helps(n)) continue;
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
/**
 * The widest single lump of material the seam passes through.
 *
 * A stamped joint needs an inscribed SQUARE, which is what sFit measures. A
 * profiled joint does not - it is cut through the full thickness, so what
 * limits it is how wide the rail is across the seam, and nothing else. On sheet
 * stock sFit is tiny for every candidate, so the joint term of the cost went
 * flat and the planner had no reason to prefer a cut through a 240 mm plate
 * over one through a 6 mm rail. This is the gradient that was missing.
 *
 * Widest rather than total: four 6 mm rails and one 24 mm plate put the same
 * material across the seam, and only one of them can hold a joint.
 *
 * A column scan, not a flood fill. For any seam that runs straight down through
 * a sheet, frameOf puts the section's own u axis along z, so a raster column is
 * a line of constant thickness and a contiguous run down it is exactly one
 * rail's width. The first version projected every cell into world space and
 * flood-filled: correct, and slow enough that the 15 s search budget expired
 * after 6 of the 15 cuts the wheel needs, which is a worse plan than no bias
 * at all. Scoring runs thousands of times; it has to stay nearly free.
 */
function widestLump(grid, sec) {
  if (Math.abs(sec.u[2]) < 0.9) return 0;        // not a straight-down seam
  const { mask, w, h, cell } = grid;
  let widest = 0;
  for (let i = 0; i < w; i++) {
    let run = 0;
    for (let j = 0; j < h; j++) {
      if (mask[j * w + i]) { run++; if (run > widest) widest = run; }
      else run = 0;
    }
  }
  return widest * cell;
}

export function scorePlane(piece, plane, ctx) {
  if (ctx.work) ctx.work.n++;
  const { n, d } = plane;
  const { a, b } = clipSoup(piece.soup, n, d);
  if (a.length < 27 || b.length < 27) return { cost: Infinity };

  // The section is taken through the ROOT solid, then masked down to this
  // piece's halfspaces on the raster. Slicing the piece's own soup is the
  // obvious move and it is wrong: clipped soups are open shells, their section
  // loops do not close, and the areas come out as zero - which once rejected
  // every candidate through a panel that had already been cut once.
  const rootSoup = ctx.rootSoup || piece.soup;
  const sec = sectionLoops(soupVerts(rootSoup), soupTris(rootSoup), n, d);
  if (!sec.loops.length) return { cost: Infinity };

  let grid = rasterize(sec.loops.map((l) => l), { cell: Math.max(0.5, Math.sqrt(Math.max(sec.area, 25)) / 96) });
  if (piece.halfspaces?.length) {
    const { mask, w, h, x0, y0, cell } = grid;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!mask[k]) continue;
        const x = x0 + (i + 0.5) * cell, y = y0 + (j + 0.5) * cell;
        const px = sec.u[0] * x + sec.w[0] * y + sec.n[0] * sec.d;
        const py = sec.u[1] * x + sec.w[1] * y + sec.n[1] * sec.d;
        const pz = sec.u[2] * x + sec.w[2] * y + sec.n[2] * sec.d;
        for (const hsp of piece.halfspaces) {
          if ((hsp.n[0] * px + hsp.n[1] * py + hsp.n[2] * pz - hsp.d) * hsp.sign < 0.25) { mask[k] = 0; break; }
        }
      }
    }
  }
  let cells = 0;
  for (let i = 0; i < grid.mask.length; i++) cells += grid.mask[i];
  const secArea = cells * grid.cell * grid.cell;
  if (secArea < 1) return { cost: Infinity };
  sec.area = secArea;

  const fld = distanceField(grid);
  let maxD = 0;
  for (let i = 0; i < fld.d.length; i++) if (fld.d[i] > maxD) maxD = fld.d[i];
  const sFit = SQRT2 * (maxD - ctx.margin);
  // A face that cannot host a joint is normally rejected outright. But when a
  // piece is oversize and NO plane through it can carry a joint - a thin-walled
  // tube's annular section, a wheel's spoked disc - a plain glued butt seam
  // beats a part that cannot print at all. The caller re-runs the scoring with
  // allowJointless once the strict pass finds nothing.
  const jointless = sFit < 1.1 * ctx.sMin;
  if (jointless && !ctx.allowJointless) return { cost: Infinity };

  const sTarget = Math.min(ctx.sMax, Math.max(ctx.sMin, sFit));

  // What a PROFILED joint could grip here, if a stamped one cannot fit.
  //
  // The tab is cut through the thickness, so the rail's width sets the head,
  // the head sets the undercut, and the face's area caps the reach. Flat 1.5
  // for every jointless candidate said "no joint either way" and let the
  // planner cut a 6 mm rail as happily as a 240 mm plate; grading it says
  // "some of these seams can still hold something" and steers toward them.
  const widest = jointless ? widestLump(grid, sec) : 0;
  const profGrip = jointless
    ? Math.max(0, Math.min((widest - 2.4) / 4, Math.sqrt(Math.max(0, widest) * (sec.area / Math.max(widest, 1e-6)))))
    : 0;
  const GOOD_GRIP = 3;                    // mm of undercut worth calling a joint
  const profBonus = Math.min(1, profGrip / GOOD_GRIP);
  const jointCap = jointless ? 1.5 : Math.max(0, (ctx.sMax - sFit) / (ctx.sMax - ctx.sMin));

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

  // The profiled-joint term is a TIE-BREAKER, deliberately small.
  //
  // Grading jointCap itself gave it a full 1.0 swing - as large as the area
  // term - and joint quality started outbidding printability: the wheel's
  // search chased wide seams through the rim, wandered, and hit its budget
  // after 6 of the 15 cuts it needs, leaving three oversize pieces. A part that
  // does not fit the bed cannot be printed at all, so fit has to win every
  // time; this only decides between cuts that are otherwise as good as each
  // other, which is exactly where "and this one can hold a joint" belongs.
  const cost =
    1.5 * jointCap +
    1.0 * areaPen +
    0.4 * seam +
    0.3 * balance +
    (axisAligned ? 0 : 0.25) -
    0.25 * profBonus;

  return { cost, a, b, section: sec, sFit, sTarget, nTargetJoints, jointless, profGrip, widest };
}

const boxVol = (b) => Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1]) * Math.max(0, b.max[2] - b.min[2]);

/** Extent of a soup along a direction - the sliver test. */
function depthAlong(soup, n) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const h = soup[i] * n[0] + soup[i + 1] * n[1] + soup[i + 2] * n[2];
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return hi - lo;
}

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
  // Work is counted, not timed.
  //
  // The budget used to be milliseconds alone, which makes the PLAN depend on
  // what else the machine happens to be doing. Measured on the EEDX wheel: the
  // same model, same code, gave 15 cuts and 34 printable parts on an idle
  // machine and 6 cuts with three oversize pieces at load average 7 - reported
  // as "partial plan", as though the geometry had defeated it. A user on a
  // slower laptop would silently get the worse split. Scoring a plane is the
  // unit of work here, so counting those makes the result reproducible; the
  // clock stays on as a ceiling for pathological models, an order of magnitude
  // out of the way so it never decides a normal run.
  const ctx = { sMin: opts.sMin ?? 12, sMax: opts.sMax ?? 25, margin: opts.jointMargin ?? 1.5, rootSoup,
                work: { n: 0 } };
  const beamWidth = opts.beamWidth ?? 4;
  const deadline = performance.now() + (opts.budgetMs ?? 6000);
  const log = [];

  let nextId = 0;
  const all = new Map();
  const mkPiece = (soup, cutFaces, halfspaces = []) => {
    const p = { id: nextId++, soup, cutFaces, halfspaces, fit: null };
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

  // How many expansions to allow. A fixed 16 was fine while every expansion was
  // one cut of a part that needed a handful, but it is not a property of the
  // search - it is a property of the MODEL. A 967 mm wheel on a 256 mm bed needs
  // fifteen cuts before it can fit at all, so a sixteen-iteration cap left it
  // permanently two pieces short and reported that as "ran out of workable
  // cuts", which sounds like the geometry defeated it rather than the loop
  // bound. The budget in milliseconds is the real limit; this is only a
  // backstop against a pathological model.
  const need = remainingCuts([root], bed, margin, prot);
  const maxDepth = opts.maxParts ?? Math.min(400, Math.max(16, 2 * need + 8));
  const maxWork = opts.maxWork ?? Math.max(4000, 900 * (need + 6));
  log.push(`needs at least ${need} cuts; allowing ${maxDepth} expansions, ${maxWork} plane scores`);

  let solved = [];
  for (let depth = 0; depth < maxDepth; depth++) {
    // Take every solved state in the beam AT THE SAME DEPTH, and stop there.
    //
    // Searching on past the first answer to collect more of them cost the EEDX
    // wheel eight minutes against ninety seconds, for alternatives it never
    // found - and a plan the user is still waiting for is not a better plan.
    // The beam is several states wide, so when one solves, its siblings often
    // solve on the same pass, and those are genuine alternatives that are free.
    const done = beam.filter((st) => st.pieces.every((q) => q.fit));
    if (done.length) {
      solved = done;
      log.push(`solved at depth ${depth}, ${done.length} plan${done.length === 1 ? '' : 's'}`);
      break;
    }
    if (ctx.work.n > maxWork) { log.push(`work budget hit (${ctx.work.n} plane scores) - taking best partial`); break; }
    if (performance.now() > deadline) { log.push('clock ceiling hit - taking best partial'); break; }

    // Duplicate suppression stops the beam collapsing into permutations of one
    // configuration, but taken as law it can also strangle it: with few viable
    // planes per piece, every child of every state can be "already seen" and
    // the search dies with pieces still oversize. When a pass produces nothing,
    // run it once more with the suppression off - a redundant expansion beats
    // no expansion.
    let next = expandBeam(true);
    if (!next.length) next = expandBeam(false);

    function expandBeam(useDedupe) {
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

      // Only offer cut directions that can reduce what actually overflows.
      const pb = soupBounds(piece.soup);
      const overflowAxes = [
        pb.max[0] - pb.min[0] > bed.x - 2 * margin,
        pb.max[1] - pb.min[1] > bed.y - 2 * margin,
        pb.max[2] - pb.min[2] > bed.z - margin,
      ];
      const anyOver = overflowAxes.some(Boolean);
      const cands = candidatePlanes(piece, analysis, { ...opts, overflowAxes: anyOver ? overflowAxes : null });

      // ---------------------------------------------------------- slab move
      //
      // A piece more than twice the bed along an axis needs a row of parallel
      // cuts, and finding them one expansion at a time is how the search dies:
      // a 967 mm wheel on a 256 mm bed needs a 4 x 4 grid, which is fifteen
      // sequential expansions, each re-clipping a 412k-triangle soup. It ran
      // out of budget at six pieces and reported that it could not split the
      // model - when the answer is the one any engineer writes down
      // immediately: divide the long axis into equal printable slabs.
      //
      // So that move is offered directly. It is still a chain of ordinary
      // binary cuts - the plan format and the executor do not change - but the
      // whole chain is proposed in ONE expansion.
      const slabStates = () => {
        const out = [];
        for (let k = 0; k < 3; k++) {
          const ext = pb.max[k] - pb.min[k];
          // Usable span per slab: the bed less its margins, less the joint boss
          // that will stand proud of each vertical cut face.
          const lim = [bed.x, bed.y, bed.z][k] - 2 * margin - (k === 2 ? 0 : prot);
          if (!(lim > 1) || ext <= 2 * lim) continue;   // one cut is enough - leave it to the normal move
          const nSlabs = Math.ceil(ext / lim);
          if (nSlabs > 12) continue;                    // absurd; something else is wrong
          const step = ext / nSlabs;
          const n = [0, 0, 0]; n[k] = 1;
          let cur = piece, ok = true;
          const planes = state.planes.slice();
          const made = [];
          let cost = state.cost;
          for (let i = 1; i < nSlabs && ok; i++) {
            const d = pb.min[k] + step * i;
            if (ctx.work.n > maxWork || performance.now() > deadline) { ok = false; break; }
            const c = scorePlane(cur, { n, d }, { ...ctx, allowJointless: true });
            if (c.cost === Infinity) { ok = false; break; }
            const rawB = sectionBoundary3D(c.section);
            const inside = (pc) => (pt) => pc.halfspaces.every((h) =>
              (h.n[0] * pt[0] + h.n[1] * pt[1] + h.n[2] * pt[2] - h.d) * h.sign >= -1);
            const boundary = cur.halfspaces.length ? rawB.filter(inside(cur)) : rawB;
            const fa = { n: n.map((v) => -v), boundary, plane: { n, d }, jointless: !!c.jointless };
            const fb = { n: n.slice(), boundary, plane: { n, d }, jointless: !!c.jointless };
            const above = mkPiece(c.a, [...cur.cutFaces, fa], [...cur.halfspaces, { n, d, sign: 1 }]);
            const below = mkPiece(c.b, [...cur.cutFaces, fb], [...cur.halfspaces, { n, d, sign: -1 }]);
            planes.push({
              n, d, sTarget: c.sTarget, nJoints: c.nTargetJoints, jointless: !!c.jointless,
              parentId: cur.id, aId: above.id, bId: below.id,
            });
            cost += c.cost + 0.8;
            below.fit = fitOf(below);
            made.push(below);       // everything under this plane is a finished slab
            cur = above;            // keep cutting what is left above it
          }
          if (!ok || !made.length) continue;
          // Slab moves need the same duplicate suppression as single cuts. Without
          // it the beam filled with four copies of the same configuration - the
          // log showed one piece slabbed eight times over - and the budget went
          // on re-deriving an answer already in hand.
          const key = planes.map((p) => p.parentId + '@' + planeKey(p)).sort().join('|');
          if (useDedupe && seen.has(key)) continue;
          seen.add(key);
          cur.fit = fitOf(cur);
          made.push(cur);
          const pieces = state.pieces.slice();
          pieces.splice(worst, 1, ...made);
          out.push({ pieces, planes, cost });
        }
        return out;
      };
      const slabs = slabStates();
      next.push(...slabs);

      // When a slab move exists, the piece is more than twice the bed on some
      // axis and NO single cut can make it fit. Scoring the full candidate set
      // anyway - two dozen clips of a 412k-triangle soup, every one of them a
      // dead end - is exactly where the budget went on the real wheel. Keep
      // only the guaranteed mid-box fallbacks so the search still has an
      // alternative if the slabs turn out badly.
      const useCands = slabs.length ? cands.filter((c) => c.why === 'fallback' || c.why === 'mid-axis') : cands;

      const scoreAll = (allowJointless) => {
        const out = [];
        const c2 = allowJointless ? { ...ctx, allowJointless: true } : ctx;
        for (const c of useCands) {
          // Check the budget HERE, not only between depths. Scoring a plane
          // sections a 412k-triangle soup, and one depth of a wide beam is
          // hundreds of those - so a per-depth check let the wheel run for
          // minutes past a budget it had already spent, with the clock ceiling
          // never reached because it is only tested at the top of the loop.
          if (ctx.work.n > maxWork || performance.now() > deadline) break;
          const s = scorePlane(piece, c, c2);
          if (s.cost === Infinity) continue;
          // Refuse slivers here too, not only in manual mode: a shaving cannot
          // carry a joint and prints as scrap.
          if (depthAlong(s.a, c.n) < 5 || depthAlong(s.b, c.n) < 5) continue;
          out.push({ ...c, ...s });
          if (performance.now() > deadline) break;
        }
        return out;
      };
      let scored = scoreAll(false);
      if (!scored.length) {
        // No plane through this piece can host a joint. A butt seam beats an
        // unprintable part; the executor leaves such seams jointless and the
        // UI says so.
        scored = scoreAll(true);
        if (scored.length) log.push('piece has no joint-capable cut - allowing a plain seam');
      }
      scored.sort((x, y) => x.cost - y.cost);

      for (const c of scored.slice(0, 6)) {
        // The dedup key must name the PIECE each plane cut, not just the plane.
        // A global plane-set key once made the second y = 0 cut of a wheel
        // "a duplicate" of the first - applied to the other half, it was the
        // one cut that search still needed.
        const key = state.planes.map((p) => p.parentId + '@' + planeKey(p))
          .concat(piece.id + '@' + planeKey(c)).sort().join('|');
        if (useDedupe && seen.has(key)) continue;
        seen.add(key);
        // The section was taken through the ROOT, so its boundary spans the
        // whole model - but this piece only owns the portion inside its own
        // halfspaces. Attaching the full boundary once inflated a 130 mm panel
        // piece's fit cloud to 493 mm and failed every piece of a fully
        // solved plan.
        const rawBoundary = sectionBoundary3D(c.section);
        const boundary = piece.halfspaces.length
          ? rawBoundary.filter((pt) => piece.halfspaces.every((h) =>
              (h.n[0] * pt[0] + h.n[1] * pt[1] + h.n[2] * pt[2] - h.d) * h.sign >= -1))
          : rawBoundary;
        const fa = { n: c.n.map((v) => -v), boundary, plane: { n: c.n, d: c.d }, jointless: !!c.jointless };
        const fb = { n: c.n.slice(), boundary, plane: { n: c.n, d: c.d }, jointless: !!c.jointless };
        const pa = mkPiece(c.a, [...piece.cutFaces, fa], [...piece.halfspaces, { n: c.n, d: c.d, sign: 1 }]);
        const pb = mkPiece(c.b, [...piece.cutFaces, fb], [...piece.halfspaces, { n: c.n, d: c.d, sign: -1 }]);
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
            jointless: !!c.jointless,
            parentId: piece.id, aId: pa.id, bId: pb.id,
          }],
          cost: state.cost + c.cost + 0.8,
          // What this cut could hold, banked so the finished plans can be
          // ranked on strength and not only on how few pieces they make.
          joint: (state.joint || 0) + (c.jointless ? (c.profGrip || 0) / 3 : 1),
        });
      }
    }
    return next;
    }

    if (!next.length) { log.push('no expansions possible'); break; }
    const readyNow = next.filter((st) => st.pieces.every((q) => q.fit));
    if (readyNow.length) { solved = readyNow; log.push(`solved, ${readyNow.length} plans`); break; }
    // Rank by the total number of cuts the state is heading for: the ones it has
    // already made plus a lower bound on the ones it still needs. Two rankings
    // were tried and both were wrong. Pure accumulated cost punished the slab
    // move for laying three planes at once, so it was pruned before its pieces
    // could pay off. Counting pieces that still do not fit was worse - a slab
    // move turns one oversize piece into four (still oversize until the
    // perpendicular pass) while a single cut makes two, so the move that
    // actually advances the plan always looked like the one falling behind.
    //
    // A lower bound is honest about both: it does not care how the cuts are
    // grouped, only how many remain, and among states heading for the same
    // total it prefers the one with more of them already banked - which is the
    // slab move, and the cheap one to evaluate.
    const total = (s) => s.planes.length + remainingCuts(s.pieces, bed, margin, prot);
    next.sort((x, y) => (total(x) - total(y)) ||
      (remainingCuts(x.pieces, bed, margin, prot) - remainingCuts(y.pieces, bed, margin, prot)) ||
      (x.cost - y.cost));
    beam = next.slice(0, beamWidth);
  }

  // Three answers, when there really are three.
  //
  // A split is judged on two things that pull against each other. SIMPLICITY
  // wants few pieces, few DISTINCT pieces, and each as big as the bed allows,
  // because every extra part is another seam to glue. STRENGTH wants seams
  // that land where a joint can live, which usually means more cuts through
  // fatter material. There is no single right trade, so where the search found
  // more than one plan that WORKS, offer the extreme of each and the best
  // compromise.
  //
  // "That works" is the load-bearing qualifier. Ranking the whole search
  // archive on these scores promotes a two-piece state that has not finished
  // cutting: one shape, enormous pieces, a perfect simplicity score and a
  // model that does not fit the printer. Only complete plans compete.
  const bedVol = bed.x * bed.y * bed.z;
  const dims = (piece) => { const b = soupBounds(piece.soup);
    return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]; };
  const rate = (st) => {
    const n = st.pieces.length;
    const shapes = new Set(st.pieces.map((q) => dims(q).map((v) => v.toFixed(0)).sort().join('x')));
    const biggest = Math.max(...st.pieces.map((q) => dims(q).reduce((a, b) => a * b, 1)));
    const r = {
      st, n, distinct: shapes.size,
      simplicity: 0.55 * (1 - (shapes.size - 1) / Math.max(1, n - 1)) + 0.45 * Math.min(1, biggest / bedVol),
      strength: st.planes.length ? Math.min(1, (st.joint || 0) / st.planes.length) : 0,
    };
    r.blend = 0.5 * r.simplicity + 0.5 * r.strength;
    return r;
  };

  // The primary answer is the search's own: most pieces fitting, then cheapest.
  // This is unchanged, and it is what runs.
  const ranked = (solved.length ? solved : beam).slice().sort((x, y) =>
    (y.pieces.filter((q) => q.fit).length - x.pieces.filter((q) => q.fit).length) || (x.cost - y.cost));
  const best = ranked[0];

  if (!solved.length) {
    log.push(`partial plan: ${best.pieces.filter((q) => q.fit).length}/${best.pieces.length} pieces fit`);
    for (const q of best.pieces) {
      if (q.fit) continue;
      const b = soupBounds(q.soup);
      log.push(`  oversize piece ${q.id}: ${[0, 1, 2].map((k) => (b.max[k] - b.min[k]).toFixed(0)).join(' x ')} mm, ${q.cutFaces.length} cut faces`);
    }
    return finish(best, log, all);
  }

  const pool = solved.map(rate);
  const pick = (key) => pool.reduce((a, b) => (b[key] > a[key] ? b : a));
  const named = [
    { label: 'simplest', r: pick('simplicity') },
    { label: 'strongest', r: pick('strength') },
    { label: 'balanced', r: pick('blend') },
  ];
  const options = [];
  for (const o of named) {
    if (options.some((q) => q.r.st === o.r.st)) continue;   // one plan, one entry
    options.push(o);
  }
  log.push(`${solved.length} complete plan${solved.length === 1 ? '' : 's'}, ${options.length} distinct to choose from`);

  const chosen = (options.find((o) => o.label === 'balanced') || options[0]);
  const out = finish(chosen.r.st, log, all);
  out.options = options.length > 1 ? options.map((o) => ({
    label: o.label, pieces: o.r.n, distinct: o.r.distinct,
    simplicity: Math.round(o.r.simplicity * 100), strength: Math.round(o.r.strength * 100),
    planes: finish(o.r.st, [], all).planes,
  })) : [];
  out.chosen = chosen.label;
  return out;
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

  /**
   * Does this cut apply to this piece?
   *
   * A plane is infinite, and manualTree offers every plane to every piece it
   * crosses - which is right for a user-placed cut and wrong for a cut that
   * belongs to one sector of a symmetric model. Sixteen ring cuts meant to
   * shorten sixteen spokes sliced all sixteen sectors each, and the wheel came
   * out in 280 parts instead of 35.
   *
   * `only` is a list of halfspaces the piece's centroid has to satisfy. It says
   * "this cut belongs over there" without needing to name a piece id, which the
   * caller cannot know because ids are minted as the tree is built.
   */
  const applies = (pl, piece) => {
    if (!pl.only || !pl.only.length) return true;
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let i = 0; i < piece.soup.length; i += 3) { cx += piece.soup[i]; cy += piece.soup[i+1]; cz += piece.soup[i+2]; n++; }
    if (!n) return false;
    cx /= n; cy /= n; cz /= n;
    return pl.only.every((h) => (h.n[0]*cx + h.n[1]*cy + h.n[2]*cz - h.d) >= -1e-6);
  };

  for (const pl of planes) {
    const next = [];
    for (const piece of pieces) {
      if (!applies(pl, piece)) { next.push(piece); continue; }
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
      const pa = mk(a, [...piece.cutFaces, { n: pl.n.map((v) => -v), boundary, plane: { n: pl.n, d: pl.d } }]);
      const pb = mk(b, [...piece.cutFaces, { n: pl.n.slice(), boundary, plane: { n: pl.n, d: pl.d } }]);
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
