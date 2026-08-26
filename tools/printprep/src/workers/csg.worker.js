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
import { makeSeamCoupon, makeSeamPair, seamParams, tabPolygon } from '../csg/seamJoints.js';
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
   */
  async 'csg.splitProfiled'({ solidId, plane, stock, opts }) {
    const k = [0, 1, 2].findIndex((i) => Math.abs(plane.n[i]) > 0.999);
    if (k !== 0 && k !== 1) {
      throw new Error('profiled cuts need an X or Y aligned seam through a sheet lying in XY');
    }
    arena.beginScope();
    try {
      const m = arena.M(solidId);
      const bb = m.boundingBox();
      const T = bb.max[2] - bb.min[2];
      const p = seamParams(opts?.type || 'dovetail', { width: stock.width, thickness: T }, opts || {});
      if (!p.ok) throw new Error(p.why || 'stock too thin for a seam joint');

      const d = plane.d * Math.sign(plane.n[k]);
      const uAxis = k === 0 ? 1 : 0;
      const uMid = stock.at ?? (bb.min[uAxis] + bb.max[uAxis]) / 2;
      const span = 4 * Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);

      // Local (x across the seam, y along the cut normal) -> world XY.
      const toWorld = ([x, y]) => {
        const w = [0, 0];
        w[k] = d + y;
        w[uAxis] = uMid + x;
        return w;
      };
      const backing = [[-span, -span], [span, -span], [span, 0], [-span, 0]];
      const cs = (pts, grow) => {
        let c = new (ctx().CrossSection)([pts.map(toWorld)], 'Positive');
        if (grow) { const g = c.offset(grow, 'Miter', 2, 0); c.delete(); c = g; }
        return c;
      };
      const half = cs(backing, 0);
      const tab = cs(tabPolygon(p), 0);
      const tabFat = cs(tabPolygon(p), p.clearance);
      const aSide = half.add(tab);            // everything behind the seam, tab included
      const bSide = half.add(tabFat);         // the socket, opened by the clearance

      const { Manifold } = ctx();
      const cutA = Manifold.extrude(aSide, T + 4).translate([0, 0, bb.min[2] - 2]);
      const cutB = Manifold.extrude(bSide, T + 4).translate([0, 0, bb.min[2] - 2]);
      const A = forceEval(m.intersect(cutA));
      const B = forceEval(m.subtract(cutB));
      for (const c of [half, tab, tabFat, aSide, bSide]) c.delete();
      cutA.delete(); cutB.delete();

      if (A.isEmpty() || B.isEmpty()) {
        A.delete(); B.delete();
        return { aId: null, bId: null, why: 'the profiled cut missed the solid' };
      }
      const aId = arena.retain(arena.track(A));
      const bId = arena.retain(arena.track(B));
      arena.release(solidId);
      return {
        aId, bId, params: p,
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
