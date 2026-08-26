/**
 * The CSG worker. One instance per session; the only place Manifold handles
 * exist. Everything arrives and leaves as typed arrays or plain data - the main
 * thread deals in integer handle ids and never touches a WASM object.
 */
import { serve } from './rpc.js';
import { initManifold, ctx, solidFromMesh, forceEval } from '../csg/manifoldCtx.js';
import * as arena from '../csg/arena.js';
import { meshOut, transfersOf, soupToMesh } from '../csg/convert.js';
import { makeJoint, params as jointParams } from '../csg/joint.js';
import { bossPolygon, makeSeamCoupon, makeSeamPair, seamParams, tabPolygon } from '../csg/seamJoints.js';
import { stampJoints } from '../csg/jointStamp.js';
import { chamferChains } from '../csg/chamfer.js';
import { writeSTL } from '../geom/stl.js';

serve({
  async 'csg.init'({ manifoldUrl }) {
    await initManifold(manifoldUrl);
    return { ok: true };
  },

  /** Turn a triangle soup into a solid. Throws with an honest message if it is not one. */
  async 'csg.fromSoup'({ positions, diag }) {
    arena.beginScope();
    try {
      const r = solidFromMesh(soupToMesh(positions), { diag });
      arena.retain(r.id);
      return { solidId: r.id, volume: r.volume, genus: r.genus, weldedAt: r.tolerance };
    } finally { arena.endScope(); }
  },

  /**
   * Split ONE solid by ONE plane. The main thread replays the planner's tree
   * with these, keeping its own id map, so the plan and the real booleans stay
   * in one-to-one correspondence.
   */
  async 'csg.splitOne'({ solidId, plane }) {
    arena.beginScope();
    try {
      const [above, below] = arena.M(solidId).splitByPlane(plane.n, plane.d);
      if (above.isEmpty() || below.isEmpty()) {
        above.delete(); below.delete();
        return { aId: null, bId: null };
      }
      const aId = arena.retain(arena.track(forceEval(above)));
      const bId = arena.retain(arena.track(forceEval(below)));
      arena.release(solidId);
      return {
        aId, bId,
        aBbox: arena.M(aId).boundingBox(), bBbox: arena.M(bId).boundingBox(),
        aVolume: arena.M(aId).volume(), bVolume: arena.M(bId).volume(),
      };
    } finally { arena.endScope(); }
  },

  /** Split a solid by a sequence of planes into its final leaves. */
  async 'csg.splitTree'({ solidId, planes }, cx) {
    const { Manifold } = ctx();
    arena.beginScope();
    try {
      let pieces = [{ m: arena.M(solidId), owned: false }];
      let done = 0;
      for (const pl of planes) {
        const next = [];
        for (const piece of pieces) {
          // Split every current piece that the plane actually crosses.
          const bb = piece.m.boundingBox();
          const side = classify(bb, pl);
          if (side !== 0) { next.push(piece); continue; }
          const [above, below] = piece.m.splitByPlane(pl.n, pl.d);
          if (above.isEmpty() || below.isEmpty()) {
            above.delete(); below.delete();
            next.push(piece);
            continue;
          }
          if (piece.owned) piece.m.delete();
          next.push({ m: forceEval(above), owned: true, from: pl },
                    { m: forceEval(below), owned: true, from: pl });
        }
        pieces = next;
        cx.progress('split', ++done / planes.length);
      }
      const out = [];
      for (const piece of pieces) {
        // A piece the planes never touched IS the input solid - handing back a
        // second handle to the same WASM object would eventually delete it
        // twice, so the original id is reused instead.
        const id = piece.owned ? arena.retain(arena.track(piece.m)) : solidId;
        out.push({ solidId: id, volume: piece.m.volume(), bbox: piece.m.boundingBox() });
      }
      return { pieces: out };
    } finally { arena.endScope(); }
  },

  /**
   * Split a solid into its connected components.
   *
   * A single plane can leave a piece whose material is in several disjoint
   * lumps: cut the prongs off a fork and the upper piece is two separate
   * prongs, cut a ring twice and the middle piece is two separate arcs.
   * Manifold is happy to hold that as one solid - it is a legal, closed,
   * two-shelled manifold - but it is not one printable object, it cannot be
   * jointed as one, and calling it "Part 3" in the list is a lie the user
   * only discovers on the plate.
   *
   * So every leaf goes through here and a part always means one lump you
   * could pick up.
   */
  async 'csg.decompose'({ solidId }) {
    arena.beginScope();
    try {
      const comps = arena.M(solidId).decompose();
      // One component is the common case; hand back the original handle rather
      // than a copy so the caller's id stays valid and nothing is reallocated.
      if (comps.length <= 1) {
        for (const c of comps) c.delete();
        const m = arena.M(solidId);
        return { parts: [{ solidId, volume: m.volume(), bbox: m.boundingBox() }], split: false };
      }
      const out = [];
      for (const c of comps) {
        const id = arena.retain(arena.track(forceEval(c)));
        out.push({ solidId: id, volume: c.volume(), bbox: c.boundingBox() });
      }
      // The multi-shell parent is superseded by its components.
      arena.release(solidId);
      out.sort((p, q) => q.volume - p.volume);
      return { parts: out, split: true };
    } finally { arena.endScope(); }
  },

  /**
   * Where a seam plane actually passes through material, lump by lump.
   *
   * A profiled cut has to know what it is cutting BEFORE it cuts - the tab is
   * sized to the rail, and the rail is only discoverable by sectioning. The
   * planner works on a triangle soup and never sees the solid, so this is the
   * one place that measurement can honestly come from.
   */
  async 'csg.seamSection'({ solidId, plane }) {
    const k = seamAxis(plane);
    arena.beginScope();
    try {
      return seamSection(arena.M(solidId), k, plane.d * Math.sign(plane.n[k]));
    } finally { arena.endScope(); }
  },

  /**
   * Split one solid with a JOINTED cut instead of a plane.
   *
   * The joint is not stamped onto the halves afterwards - the cut itself
   * carries the profile, so the two pieces come out already mated and there is
   * nothing to audit for containment: a joint that is the shape of the cut
   * cannot poke out of its own part.
   *
   * Restricted, on purpose, to what it can do honestly: a sheet lying in XY
   * with an axis-aligned cut. That is exactly the EEDX case - a 10 mm sheet
   * grid-cut along X and Y - and the extrusion axis is then already Z, so the
   * profile maps straight into world coordinates with no basis to get wrong.
   * Anything else is refused rather than silently cut on a plane, because a
   * seam the user believes is jointed and is not is the worst outcome here.
   *
   * ONE TAB PER LUMP, and the caller has to name every lump. A plane across
   * the EEDX wheel meets sixteen separate rails; a single tab would joint one
   * and butt-cut fifteen with nothing said. So `stock.tabs` carries an entry
   * per lump the seam crosses - `{at, width, plain}` - and a lump nobody
   * mentioned is an error, not a plain cut. `{width, at}` is still accepted as
   * shorthand when the seam crosses exactly one lump.
   *
   * `aId` is the n.x >= plane.d side, the same side `csg.splitOne` calls `aId`.
   * The tab lives on the other one, so `maleOn` in the result says which.
   */
  async 'csg.splitProfiled'({ solidId, plane, stock, opts }) {
    const k = seamAxis(plane);
    arena.beginScope();
    try {
      const m = arena.M(solidId);
      const bb = m.boundingBox();
      const T = bb.max[2] - bb.min[2];
      const sgn = Math.sign(plane.n[k]);
      const d = plane.d * sgn;
      const uAxis = k === 0 ? 1 : 0;
      const span = 4 * Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
      const { Manifold } = ctx();

      const { lumps } = seamSection(m, k, d);
      if (!lumps.length) throw new Error('the seam plane does not cross the solid');

      // Local (x across the rail, y along the cut normal) -> world XY, about a
      // given position along the seam.
      //
      // Every polygon here - backing, tab, boss - is authored counter-clockwise,
      // and `Positive` fills winding > 0 only. For an X-normal seam this map is
      // a transposition (local x becomes world Y), which is a reflection: the
      // ring comes out clockwise and fills NOTHING. Measured before the
      // reversal below, an X-aligned seam sectioned to an empty solid and the
      // cut silently no-opped while the identical Y-aligned seam cut correctly
      // - and on a grid-cut sheet that is half of all seams.
      const cs = (pts, at, grow) => {
        const ring = pts.map(([x, y]) => {
          const w = [0, 0];
          w[k] = d + y;
          w[uAxis] = at + x;
          return w;
        });
        if (k === 0) ring.reverse();
        let c = new (ctx().CrossSection)([ring], 'Positive');
        if (grow) { const g = c.offset(grow, 'Miter', 2, 0); c.delete(); c = g; }
        return c;
      };

      // Match the caller's tabs to the lumps one for one. Both directions are
      // checked: a lump with no tab would be butt-cut in silence, and a tab in
      // no lump would weld a floating island of pad into the model - measured
      // on two rails at x=+-20 with `at` left to default to the bbox midpoint,
      // which produced exactly that at x=-9..9, touching no material, and
      // decompose duly turned it into a part that would orient, pack and print.
      const asked = stock.tabs
        ?? (lumps.length === 1 ? [{ at: stock.at ?? lumps[0].at, width: stock.width }] : null);
      if (!asked) {
        throw new Error(`the seam crosses ${lumps.length} separate lumps - pass stock.tabs with one entry `
          + `per lump (centres ${lumps.map((l) => l.at.toFixed(1)).join(', ')})`);
      }
      const paired = lumps.map((lump) => {
        const hits = asked.filter((t) => Number(t.at) >= lump.uLo - 1e-6 && Number(t.at) <= lump.uHi + 1e-6);
        if (hits.length !== 1) {
          throw new Error(hits.length === 0
            ? `no tab given for the material at ${lump.uLo.toFixed(1)}..${lump.uHi.toFixed(1)} - `
              + 'name every lump, a seam is never left half jointed'
            : `${hits.length} tabs fall inside ${lump.uLo.toFixed(1)}..${lump.uHi.toFixed(1)} - one tab per lump`);
        }
        return { lump, ask: hits[0] };
      });
      const orphan = asked.find((t) => !paired.some((pr) => pr.ask === t));
      if (orphan) {
        throw new Error(`the tab at ${Number(orphan.at).toFixed(1)} is not inside any material at the seam`);
      }

      // Resolve each lump's joint. A rail too thin to hold one is reported as
      // plain WITH the reason rather than throwing - that is the same bargain
      // the seam list already makes elsewhere, and it keeps one narrow rail
      // from vetoing a cut the other fifteen can take.
      const tabs = paired.map(({ lump, ask }) => {
        const width = Number(ask.width ?? lump.width);
        if (width > lump.width + 1e-6) {
          throw new Error(`asked for a ${width.toFixed(1)} mm tab in ${lump.width.toFixed(1)} mm of material `
            + `at ${lump.at.toFixed(1)}`);
        }
        if (ask.plain) return { at: Number(ask.at), width, plain: true, params: null, why: 'asked for a plain cut' };
        const p = seamParams(opts?.type || 'dovetail', { width, thickness: T }, opts || {});
        return p.ok
          ? { at: Number(ask.at), width, plain: false, params: p, why: null }
          : { at: Number(ask.at), width, plain: true, params: p, why: p.why || 'stock too thin for a seam joint' };
      });

      // Build the cut: a backing halfspace with every tab added to it, and the
      // same again with the tabs grown by their clearance to open the sockets.
      // The pad is unioned into the stock BEFORE either boolean, so it is
      // continuous across the seam and the joint sits in solid material.
      //
      // Without it the tab is cut from stock narrower than itself: seamParams
      // sizes the tab to the BOSSED width, so a boss on 6 mm stock returns a
      // 15.6 mm head, which clips to the rail and loses its undercut while the
      // grown socket takes that whole width out of the other half. Measured on
      // 6 x 60 x 10 stock the halves came out spanning y <= 3.90 and y >= 4.08
      // - a butt cut with a 0.18 mm gap, nothing touching anywhere.
      const backing = [[-span, -span], [span, -span], [span, 0], [-span, 0]];
      let aSide = cs(backing, 0, 0);
      let bSide = cs(backing, 0, 0);
      let pad = null;
      const add = (target, poly, at, grow) => {
        const piece = cs(poly, at, grow);
        const merged = target.add(piece);
        target.delete(); piece.delete();
        return merged;
      };
      for (const t of tabs) {
        if (t.plain) continue;
        aSide = add(aSide, tabPolygon(t.params), t.at, 0);
        bSide = add(bSide, tabPolygon(t.params), t.at, t.params.clearance);
        const bossPoly = bossPolygon(t.params);
        if (!bossPoly) continue;
        const bcs = cs(bossPoly, t.at, 0);
        const slab = Manifold.extrude(bcs, T).translate([0, 0, bb.min[2]]);
        bcs.delete();
        if (!pad) { pad = slab; continue; }
        const merged = forceEval(pad.add(slab));
        pad.delete(); slab.delete();
        pad = merged;
      }

      const stockSolid = pad ? forceEval(m.add(pad)) : m;
      const cutA = Manifold.extrude(aSide, T + 4).translate([0, 0, bb.min[2] - 2]);
      const cutB = Manifold.extrude(bSide, T + 4).translate([0, 0, bb.min[2] - 2]);
      const lo = forceEval(stockSolid.intersect(cutA));   // the x_k <= d side, tab included
      const hi = forceEval(stockSolid.subtract(cutB));    // the x_k >= d side, socketed
      aSide.delete(); bSide.delete(); cutA.delete(); cutB.delete();
      // lo and hi are evaluated, so the intermediates have no readers left.
      if (pad) pad.delete();
      if (stockSolid !== m) stockSolid.delete();

      if (lo.isEmpty() || hi.isEmpty()) {
        lo.delete(); hi.delete();
        return { aId: null, bId: null, why: 'the profiled cut missed the solid' };
      }
      // `lo` is the low side along axis k. csg.splitOne calls the n.x >= d side
      // `aId`, and the planner only ever emits +1 axis normals, so for every
      // real plane those are opposite. Label by the shared convention rather
      // than leaving the caller to discover the inversion by way of a seam
      // graph that silently comes back empty.
      const [A, B] = sgn > 0 ? [hi, lo] : [lo, hi];
      const aId = arena.retain(arena.track(A));
      const bId = arena.retain(arena.track(B));
      arena.release(solidId);
      return {
        aId, bId,
        maleOn: sgn > 0 ? 'B' : 'A',
        tabs: tabs.map((t) => ({ at: t.at, width: t.width, plain: t.plain, why: t.why, params: t.params })),
        jointed: tabs.filter((t) => !t.plain).length,
        params: tabs.find((t) => !t.plain)?.params ?? null,
        aVolume: A.volume(), bVolume: B.volume(),
        aBbox: A.boundingBox(), bBbox: B.boundingBox(),
      };
    } finally { arena.endScope(); }
  },

  /** Stamp a joint pair across one plane between two pieces. */
  async 'csg.stamp'({ aId, bId, placement, fit, maleOn }) {
    arena.beginScope();
    try {
      const r = stampJoints(arena.M(aId), arena.M(bId), placement, { fit, maleOn });
      const newA = arena.retain(arena.track(r.A));
      const newB = arena.retain(arena.track(r.B));
      // The inputs are superseded; drop them so they cannot leak.
      arena.release(aId); arena.release(bId);
      return { aId: newA, bId: newB, audit: r.audit, meta: r.meta,
               aVolume: r.A.volume(), bVolume: r.B.volume(),
               aBbox: r.A.boundingBox(), bBbox: r.B.boundingBox() };
    } finally { arena.endScope(); }
  },

  /** Chamfer a set of prepared chains on one solid. */
  async 'csg.chamfer'({ solidId, chains }, cx) {
    arena.beginScope();
    try {
      const { result, cutterCount } = chamferChains(arena.M(solidId), chains, {
        onProgress: (f) => cx.progress('chamfer', f),
      });
      const id = arena.retain(arena.track(result));
      arena.release(solidId);
      return { solidId: id, cutterCount, volume: result.volume(), status: result.status() };
    } finally { arena.endScope(); }
  },

  /** A standalone joint pair, for preview and for the calibration coupon. */
  async 'csg.jointPreview'({ S, fit }) {
    arena.beginScope();
    try {
      const { male, female, params } = makeJoint(S, fit || {});
      const m = meshOut(male), f = meshOut(female);
      male.delete(); female.delete();
      return { male: m, female: f, params };
    } finally { arena.endScope(); }
  },

  /**
   * A coupon of seam-profile joints in one bar of stock, for printing and
   * trying by hand. Returns the mesh plus what each variant actually resolved
   * to, since the stock caps the tab and the caller should see the real numbers
   * rather than what it asked for.
   */
  async 'csg.seamCoupon'({ variants, stock, opts }, cx) {
    arena.beginScope();
    try {
      const { solid, variants: made } = makeSeamCoupon(variants, stock, opts || {});
      const mesh = meshOut(solid);
      solid.delete();
      cx.transfer(transfersOf(mesh));
      return { mesh, variants: made };
    } finally { arena.endScope(); }
  },

  /**
   * Does the pair actually go together?
   *
   * makeSeamPair leaves the halves in their mated position, so the volume they
   * share is the interference. With the detents off that has to be zero or the
   * joint does not assemble at all; with them on it should be just the balls,
   * which is the snap doing its job. Anything else means the clearance is not
   * reaching where it is needed.
   */
  async 'csg.seamFit'({ type, stock, opts }) {
    arena.beginScope();
    try {
      const { male, female, params } = makeSeamPair(type, stock, opts || {});
      // `insertZ` lifts the male part-way out along the assembly direction. At
      // rest a snap must be a clearance fit or it never seats; the interference
      // that makes it a snap happens on the way in, so measuring only the mated
      // position proves nothing about whether a detent is doing anything.
      const lifted = (opts && opts.insertZ) ? male.translate([0, 0, opts.insertZ]) : male;
      const both = lifted.intersect(female);
      if (lifted !== male) lifted.delete();
      const r = {
        interferenceMm3: both.volume(),
        maleMm3: male.volume(), femaleMm3: female.volume(),
        detentR: params.detentR, detents: params.detent,
      };
      both.delete(); male.delete(); female.delete();
      return r;
    } finally { arena.endScope(); }
  },

  /** Resolve seam-joint dimensions for some stock, without building anything. */
  async 'csg.seamParams'({ type, stock, opts }) {
    return seamParams(type, stock, opts || {});
  },

  async 'csg.mesh'({ solidId }, cx) {
    const mesh = meshOut(arena.M(solidId));
    cx.transfer(transfersOf(mesh));
    return mesh;
  },

  async 'csg.transform'({ solidId, matrix }) {
    arena.beginScope();
    try {
      const t = forceEval(arena.M(solidId).transform(matrix));
      const id = arena.retain(arena.track(t));
      return { solidId: id, bbox: t.boundingBox() };
    } finally { arena.endScope(); }
  },

  async 'csg.stl'({ solidId, name }, cx) {
    const mesh = meshOut(arena.M(solidId));
    const buf = writeSTL(mesh.vertProperties, mesh.triVerts, { name });
    cx.transfer([buf]);
    return buf;
  },

  async 'csg.release'({ solidIds }) { solidIds.forEach((id) => arena.release(id)); return true; },
  async 'csg.stats'() { return arena.stats(); },
});

/** The world axis a seam runs perpendicular to, or a refusal. */
function seamAxis(plane) {
  const k = [0, 1, 2].findIndex((i) => Math.abs(plane.n[i]) > 0.999);
  if (k !== 0 && k !== 1) {
    throw new Error('profiled cuts need an X or Y aligned seam through a sheet lying in XY');
  }
  return k;
}

/**
 * Section a solid at a seam and report the material lump by lump.
 *
 * A thin slab rather than a true section, because what a tab needs to know is
 * "how much rail is there", and a slab has a volume and a decompose() where a
 * zero-thickness section has neither. 0.5 mm is thin enough that a rail's width
 * does not change measurably across it and thick enough to survive the float32
 * noise on a model sitting metres from the origin - which the EEDX wheel does,
 * at 3.2 m.
 *
 * Lumps come back sorted along the seam, so a caller pairing tabs to them by
 * position gets a stable order between the measuring call and the cutting one.
 */
function seamSection(m, k, d) {
  const { Manifold, CrossSection } = ctx();
  const bb = m.boundingBox();
  const uAxis = k === 0 ? 1 : 0;
  const T = bb.max[2] - bb.min[2];
  const span = 4 * Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
  const probe = 0.5;
  const ring = [[-span, -probe / 2], [span, -probe / 2], [span, probe / 2], [-span, probe / 2]]
    .map(([x, y]) => { const w = [0, 0]; w[k] = d + y; w[uAxis] = x; return w; });
  if (k === 0) ring.reverse();
  const rect = new CrossSection([ring], 'Positive');
  const slab = Manifold.extrude(rect, T + 4).translate([0, 0, bb.min[2] - 2]);
  rect.delete();
  const sec = forceEval(m.intersect(slab));
  slab.delete();
  const lumps = [];
  for (const c of sec.decompose()) {
    const b = c.boundingBox();
    // An empty component reports an inverted infinite box rather than throwing.
    if (!c.isEmpty() && Number.isFinite(b.min[uAxis]) && b.max[uAxis] > b.min[uAxis]) {
      lumps.push({
        at: (b.min[uAxis] + b.max[uAxis]) / 2,
        width: b.max[uAxis] - b.min[uAxis],
        uLo: b.min[uAxis], uHi: b.max[uAxis],
        zLo: b.min[2], zHi: b.max[2],
      });
    }
    c.delete();
  }
  sec.delete();
  lumps.sort((p, q) => p.at - q.at);
  return { k, uAxis, thickness: T, lumps };
}

/** -1 fully below, +1 fully above, 0 crossed. */
function classify(bb, pl) {
  const corners = [];
  for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) for (const z of [bb.min[2], bb.max[2]]) {
    corners.push(x * pl.n[0] + y * pl.n[1] + z * pl.n[2] - pl.d);
  }
  if (corners.every((c) => c >= -1e-6)) return 1;
  if (corners.every((c) => c <= 1e-6)) return -1;
  return 0;
}
