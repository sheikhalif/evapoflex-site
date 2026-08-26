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
