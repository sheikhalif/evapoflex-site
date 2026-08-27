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
      return { solidId: r.id, volume: r.volume, genus: r.genus, weldedAt: r.tolerance, flipped: r.flipped };
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
    const fr = seamFrame(plane);
    arena.beginScope();
    try {
      return seamSection(arena.M(solidId), fr);
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
    const fr = seamFrame(plane);
    arena.beginScope();
    try {
      // WHICH DIMENSION THE JOINT GETS TO USE.
      //
      // The profile is cut in the plane of the sheet and extruded through its
      // thickness, so the undercut is limited by the rail's WIDTH. On the EEDX
      // frame that is 6 mm against a 10 mm thickness - the joint is working in
      // the smaller of the two dimensions it has.
      //
      // `across: 'thickness'` rolls the solid a quarter turn about the seam
      // normal before cutting and rolls it back after. The seam is unmoved (it
      // is the rotation axis), but width and thickness swap, so the same
      // profile now takes its undercut from the 10 mm and extrudes through the
      // 6 mm. Everything downstream is identical; only which dimension is
      // spent on engagement changes.
      const roll = opts?.across === 'thickness';
      let rolled = null, rollBack = null;
      if (roll) {
        const n = fr.n;
        const c = Math.cos(Math.PI / 2), sn = Math.sin(Math.PI / 2);
        const K = [[0, -n[2], n[1]], [n[2], 0, -n[0]], [-n[1], n[0], 0]];
        const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
          (i === j ? 1 : 0) + sn * K[i][j] + (1 - c) * (K[i][0] * K[0][j] + K[i][1] * K[1][j] + K[i][2] * K[2][j])));
        // Column-major 4x3 for Manifold.transform, about the seam's own point.
        const o = [fr.n[0] * fr.d, fr.n[1] * fr.d, 0];
        const mat = [
          R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2],
          o[0] - (R[0][0] * o[0] + R[0][1] * o[1] + R[0][2] * o[2]),
          o[1] - (R[1][0] * o[0] + R[1][1] * o[1] + R[1][2] * o[2]),
          o[2] - (R[2][0] * o[0] + R[2][1] * o[1] + R[2][2] * o[2]),
        ];
        const inv = [
          R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2],
          o[0] - (R[0][0] * o[0] + R[1][0] * o[1] + R[2][0] * o[2]),
          o[1] - (R[0][1] * o[0] + R[1][1] * o[1] + R[2][1] * o[2]),
          o[2] - (R[0][2] * o[0] + R[1][2] * o[1] + R[2][2] * o[2]),
        ];
        rolled = forceEval(arena.M(solidId).transform(mat));
        rollBack = inv;
      }
      const m = rolled || arena.M(solidId);
      const bb = m.boundingBox();
      const T = bb.max[2] - bb.min[2];
      const uMid = (bb.min[0] + bb.max[0]) / 2 * fr.u[0] + (bb.min[1] + bb.max[1]) / 2 * fr.u[1];
      const span = 4 * Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
      const { Manifold } = ctx();

      const { lumps } = seamSection(m, fr);
      if (!lumps.length) throw new Error('the seam plane does not cross the solid');

      // "A sheet lying in XY" is asserted in the contract but only the seam
      // NORMAL was ever checked. T is the whole solid's z extent, and it is
      // what sizes the joint and the pad, so if the seam crosses material
      // thinner than the solid is tall - rails around a taller hub, say - then
      // every number here is taken from geometry the seam never touches, and
      // the pad is extruded as a fin through empty space above the rail.
      // Check it against what the section actually found.
      const thin = lumps.find((l) => l.zHi - l.zLo < T - 1e-3);
      if (thin) {
        throw new Error(`the seam crosses material ${(thin.zHi - thin.zLo).toFixed(1)} mm thick in a solid `
          + `${T.toFixed(1)} mm tall - profiled cuts need a sheet of one thickness`);
      }

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
        const ring = pts.map(([x, y]) => seamPoint(fr, at, x, y));
        let c = new (ctx().CrossSection)([ring], 'Positive');
        if (grow) { const g = c.offset(grow, 'Miter', 2, 0); c.delete(); c = g; }
        return c;
      };

      // Match the caller's tabs to the lumps BY INDEX.
      //
      // Matching by position looks natural and is wrong: lumps are disjoint in
      // space but not necessarily in their projection along the seam. Cut a
      // lattice along one of its own bars and the section holds five short
      // rungs plus that bar, running the full width and overlapping every one
      // of them - so "which lump is this tab in" had six answers and the cut
      // was refused on geometry it could have jointed. seamSection returns
      // lumps in a defined order, so the honest contract is that the caller
      // hands back one tab per lump in that same order.
      const asked = stock.tabs
        ?? (lumps.length === 1 ? [{ at: stock.at ?? lumps[0].at, width: stock.width }] : null);
      if (!asked) {
        throw new Error(`the seam crosses ${lumps.length} separate lumps - pass stock.tabs with one entry `
          + `per lump, in seamSection order (centres ${lumps.map((l) => l.at.toFixed(1)).join(', ')})`);
      }
      if (asked.length !== lumps.length) {
        throw new Error(`${asked.length} tabs for ${lumps.length} lumps - a seam is never left half jointed`);
      }
      const paired = lumps.map((lump, i) => ({ lump, ask: asked[i] }));

      // Resolve each lump's joint. A rail too thin to hold one is reported as
      // plain WITH the reason rather than throwing - that is the same bargain
      // the seam list already makes elsewhere, and it keeps one narrow rail
      // from vetoing a cut the other fifteen can take.
      // A pad may not grow into its neighbour.
      //
      // The default boss is 18 mm wide on a 6 mm rail, so two rails 12 mm apart
      // get pads that overlap by 6 mm and fuse. Measured on rails at x=+-6:
      // before the cut the seam crosses two clean lumps, after it one side came
      // back as a single part spanning both rails and the other as that part
      // plus a 1.8 mm sliver of leftover pad - two parts the planner meant to
      // keep separate welded together, and debris carved out of the bridge by
      // the two sockets. Capping each pad at half the distance to its
      // neighbour, less half a millimetre, keeps them apart; a rail with no
      // room to grow simply gets no pad and says so.
      const centres = paired.map(({ ask }) => Number(ask.at)).sort((x, y) => x - y);
      const roomAt = (at) => {
        let room = Infinity;
        for (const c of centres) if (c !== at) room = Math.min(room, Math.abs(c - at) - 1);
        return room;                                   // full width available to this pad
      };

      // How many tabs this face wants, and how wide each one's slot is.
      //
      // One tab per face is a template, not a fit. The face's thickness is the
      // dimension a profiled joint cannot change - it is cut through it - so
      // that is what sets the natural size of a tab, and the width says how
      // many of them fit. A 240 mm rail given a single tab gets one 49 mm
      // dovetail and 190 mm of plain butt either side of it; the same rail
      // given six gets engagement spread along the whole seam, which is both
      // stronger and stiffer against the seam hinging open.
      //
      // Narrow stock is unaffected: a 6 mm rail has room for exactly one, which
      // is what it already had.
      const slotsFor = (lump) => {
        const T = Math.max(1e-3, lump.zHi - lump.zLo);
        const want = Math.max(6, 1.6 * T) + 2 * (opts?.sideWall ?? 1.2) + 2;
        return Math.max(1, Math.min(8, Math.floor(lump.width / want)));
      };
      // PICK THE GEOMETRY PER LUMP, not per cut.
      //
      // One plane crosses rails of different widths. Choosing a single type for
      // the whole cut meant that when the dovetail fitted SOME rails, the ones
      // it did not fit stayed plain - on the frame, 71 of 116 seams. Deciding
      // per lump lets a wide rail take the stronger dovetail while the narrow
      // one beside it takes fingers, and no seam is left with nothing.
      // `askedType`, not `wanted` - the pad cap below already binds a `wanted`
      // inside the tab loop, and shadowing it made every profiled cut die with
      // a temporal-dead-zone error that surfaced only as "no joints".
      const askedType = opts?.type || 'dovetail';
      const typeFor = (lump) => {
        if (askedType === 'fingers') return 'fingers';
        const p0 = seamParams(askedType, { width: lump.width, thickness: lump.zHi - lump.zLo }, opts || {});
        return p0.ok ? askedType : 'fingers';
      };

      const expanded = [];
      for (const { lump, ask } of paired) {
        const lumpType = ask.type || typeFor(lump);
        // Fingers interlock, so only ALTERNATE slots carry a tooth: the ones
        // between them are the other half's teeth. An odd count means the
        // pattern starts and ends on a tooth, which keeps the seam symmetric.
        if (lumpType === 'fingers') {
          // Finger count from the rail's own width: as many as fit while each
          // stays at least a few extrusions wide, always odd so the pattern
          // starts and ends on a tooth and the seam stays symmetric.
          const nz = opts?.nozzle ?? 0.4;
          const minTooth = Math.max(2.5 * nz, 1.0);
          let n = Math.max(3, Math.min(9, Math.floor(lump.width / minTooth)));
          if (n % 2 === 0) n -= 1;
          if (n < 3) n = 3;
          const slot = lump.width / n;
          for (let k = 0; k < n; k += 2) {
            expanded.push({
              lump: { ...lump, width: slot, uLo: lump.uLo + k * slot, uHi: lump.uLo + (k + 1) * slot,
                      at: lump.uLo + (k + 0.5) * slot },
              ask: { ...ask, type: 'fingers', at: lump.uLo + (k + 0.5) * slot, width: slot },
            });
          }
          continue;
        }
        const n = ask.count ?? (ask.width != null || ask.at != null ? 1 : slotsFor(lump));
        if (n <= 1) { expanded.push({ lump, ask }); continue; }
        const slot = lump.width / n;
        for (let k = 0; k < n; k++) {
          expanded.push({
            lump: { ...lump, width: slot, uLo: lump.uLo + k * slot, uHi: lump.uLo + (k + 1) * slot,
                    at: lump.uLo + (k + 0.5) * slot },
            ask: { ...ask, at: lump.uLo + (k + 0.5) * slot, width: slot },
          });
        }
      }

      const tabs = expanded.map(({ lump, ask }) => {
        const at = Number(ask.at ?? lump.at);
        const width = Number(ask.width ?? lump.width);
        if (!Number.isFinite(at) || !Number.isFinite(width) || width <= 0) {
          throw new Error(`a tab needs a finite at and a positive width, got at=${ask.at} width=${ask.width}`);
        }
        // `lump.width` is measured off float32 vertices, so a nominally 6.000 mm
        // rail on a model 3.2 m from the origin measures 5.99976 as readily as
        // 6.00024. Comparing a caller's round number against it exactly would
        // reject the rail for being a quarter of a micron too narrow.
        const tol = 1e-5 * Math.max(1, Math.abs(lump.uLo), Math.abs(lump.uHi));
        if (width > lump.width + tol) {
          throw new Error(`asked for a ${width.toFixed(1)} mm tab in ${lump.width.toFixed(1)} mm of material `
            + `at ${lump.at.toFixed(1)}`);
        }
        // The centre being inside the lump is not enough - a tab centred near a
        // rail's edge hangs off it, gets clipped away by the intersect, and
        // still reports a full-size joint. The tab has to FIT.
        if (at - width / 2 < lump.uLo - tol || at + width / 2 > lump.uHi + tol) {
          throw new Error(`a ${width.toFixed(1)} mm tab at ${at.toFixed(1)} does not fit the material at `
            + `${lump.uLo.toFixed(1)}..${lump.uHi.toFixed(1)}`);
        }
        if (ask.plain) return { at, width, plain: true, params: null, why: 'asked for a plain cut' };
        const useType = ask.type || askedType;

        const room = roomAt(at);
        // seamParams returns a null boss when the stock is already wide enough
        // to joint unaided, so there is nothing to cap and nothing to say.
        const wanted = opts?.boss
          ? (seamParams(opts.type || 'dovetail', { width, thickness: T }, opts).boss?.width ?? 0)
          : 0;
        const capped = wanted > room;
        const useOpts = capped
          ? { ...opts, boss: room > width ? { ...opts.boss, width: room } : null }
          : opts || {};
        const p = seamParams(useType, { width, thickness: T }, { ...useOpts, type: useType });
        const note = !capped ? null
          : room > width
            ? `pad capped to ${room.toFixed(1)} mm by the neighbouring rail (wanted ${wanted.toFixed(1)})`
            : 'no room to pad between the neighbouring rails';
        return p.ok
          ? { at, width, plain: false, params: p, why: note }
          : { at, width, plain: true, params: p, why: p.why || 'stock too thin for a seam joint' };
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
      // Centred on the SOLID, not the origin - `span` is reckoned from the
      // model's own size, so laying it out from u = 0 only covers the model
      // when the model sits near the origin. Measured on a 100 mm slab at
      // x = 350..450 against a span of 400: the cutter reached x = 400, the
      // material beyond it was in neither half, and the two "halves" came back
      // still welded together across the seam.
      const backing = [[-span, -span], [span, -span], [span, 0], [-span, 0]];
      let aSide = cs(backing, uMid, 0);
      let bSide = cs(backing, uMid, 0);
      let pad = null;
      const add = (target, poly, at, grow) => {
        const piece = cs(poly, at, grow);
        const merged = target.add(piece);
        target.delete(); piece.delete();
        return merged;
      };
      // Root each tab a hair INSIDE the backing rather than flush against it.
      //
      // tabPolygon starts on the seam line, exactly where the backing halfspace
      // ends, so the union of the two is a tangency rather than an overlap and
      // whether it welds is down to the angle's floating-point luck. Measured on
      // four rails at 30 degrees: three of the four tabs came out as separate
      // lumps of exactly the tab's own volume - detached from the rails they
      // belong to, which is both debris and a joint that holds nothing. Grid
      // cuts happened to survive it, which is why it only surfaced once seams
      // could point anywhere.
      const root = (poly) => poly.map(([x, y]) => [x, y <= 1e-9 ? -0.01 : y]);
      for (const t of tabs) {
        if (t.plain) continue;
        aSide = add(aSide, root(tabPolygon(t.params)), t.at, 0);
        bSide = add(bSide, root(tabPolygon(t.params)), t.at, t.params.clearance);
        const bossPoly = bossPolygon(t.params);
        if (!bossPoly) continue;
        const bcs = cs(bossPoly, t.at, 0);
        // extrude() then translate() is two allocations, not one.
        const flat = Manifold.extrude(bcs, T);
        const slab = flat.translate([0, 0, bb.min[2]]);
        flat.delete();
        bcs.delete();
        if (!pad) { pad = slab; continue; }
        const merged = forceEval(pad.add(slab));
        pad.delete(); slab.delete();
        pad = merged;
      }

      const stockSolid = pad ? forceEval(m.add(pad)) : m;

      // The cap above only knows about other tabs. A pad also reaches 12 mm or
      // more ALONG the seam, where it can run into something the seam never
      // crossed - a rail at right angles, a fillet, the next spoke round. If
      // padding has merged lumps that were separate, the cut would silently
      // weld two parts into one, so check the topology is what it was and
      // refuse if it is not. Cheap next to the booleans, and it is the only
      // check that sees geometry the tab list cannot describe.
      if (pad) {
        const after = seamSection(stockSolid, fr).lumps.length;
        if (after !== lumps.length) {
          aSide.delete(); bSide.delete(); pad.delete(); stockSolid.delete();
          throw new Error(`padding the seam merged ${lumps.length} lumps into ${after} - `
            + 'the joints would weld parts the plan keeps separate');
        }
      }

      const flatA = Manifold.extrude(aSide, T + 4);
      const flatB = Manifold.extrude(bSide, T + 4);
      const cutA = flatA.translate([0, 0, bb.min[2] - 2]);
      const cutB = flatB.translate([0, 0, bb.min[2] - 2]);
      flatA.delete(); flatB.delete();
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
      // `hi` is the n.x >= d side, which is what csg.splitOne calls `aId`. The
      // frame now carries the normal's own direction rather than folding its
      // sign into an axis index, so this needs no case analysis: the tab always
      // rides on the other half.
      let [A, B] = [hi, lo];
      if (rollBack) {
        const ra = forceEval(A.transform(rollBack)), rb = forceEval(B.transform(rollBack));
        A.delete(); B.delete();
        A = ra; B = rb;
      }
      if (rolled) rolled.delete();
      const aId = arena.retain(arena.track(A));
      const bId = arena.retain(arena.track(B));
      arena.release(solidId);
      return {
        aId, bId,
        maleOn: 'B',
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

  /**
   * How much two solids agree.
   *
   * There was no way to boolean two arbitrary handles, so questions of the form
   * "is this the same shape as that" - does the model match itself turned by a
   * sector, do these two halves actually mate - could only be guessed at from
   * bounding boxes and volumes. The symmetric difference answers them directly.
   */
  async 'csg.compare'({ aId, bId }) {
    arena.beginScope();
    try {
      const A = arena.M(aId), B = arena.M(bId);
      const both = forceEval(A.intersect(B));
      const aOnly = forceEval(A.subtract(B));
      const bOnly = forceEval(B.subtract(A));
      const r = {
        aVolume: A.volume(), bVolume: B.volume(),
        sharedMm3: both.volume(), aOnlyMm3: aOnly.volume(), bOnlyMm3: bOnly.volume(),
      };
      r.symDiffMm3 = r.aOnlyMm3 + r.bOnlyMm3;
      r.agreement = r.aVolume ? r.sharedMm3 / r.aVolume : 0;
      both.delete(); aOnly.delete(); bOnly.delete();
      return r;
    } finally { arena.endScope(); }
  },

  /**
   * Force a model onto its own symmetry.
   *
   * Measured on the EEDX wheel at its exact volume centroid, the area around
   * the axis repeats to within 4.61% at a half turn, 5.18% at a quarter and
   * 6.81% at an eighth - and the error GROWS with the order, which is what
   * happens when the arms are not at perfectly regular angles rather than when
   * one of them is wrong. A model that is nearly symmetric cannot be split into
   * identical parts no matter how good the planner is, because the parts are
   * not identical in the source.
   *
   * So take one sector and use it eight times. The result is exactly N-fold by
   * construction. This CHANGES THE MODEL - it is a repair, not a view - so the
   * caller has to ask for it, and the returned volume delta says how much moved.
   */
  async 'csg.symmetrize'({ solidId, order, centre }) {
    const N = Math.round(order);
    if (!(N >= 4)) throw new Error('symmetrising needs an order of 4 or more - a sector has to be a wedge');
    const { Manifold } = ctx();
    arena.beginScope();
    try {
      const src = arena.M(solidId);
      const before = src.volume();
      const [cx, cy] = centre;
      const at = forceEval(src.translate([-cx, -cy, 0]));       // axis to the origin
      const th = (2 * Math.PI) / N;

      // One wedge: y >= 0 intersected with "angle <= th". Both are halfspaces
      // through the axis, which is why this needs th <= 90 degrees, i.e. N >= 4.
      // Cut the wedge WIDER than a sector, so neighbouring copies overlap.
      //
      // A wedge of exactly 2*pi/N abuts its neighbour on a shared plane, and
      // unioning solids across an exactly coincident face is where booleans go
      // wrong: the first attempt came back with 57 non-manifold edges and a
      // flipped one, closed:false, and would not split at all. An overlap of a
      // couple of degrees costs nothing and is still exactly N-fold - rotating
      // the set of copies by one sector permutes them, whatever their width.
      const over = Math.min(th / 4, 3 * Math.PI / 180);
      const cutA = at.splitByPlane([Math.sin(over), Math.cos(over), 0], 0)[0];
      const wedge = forceEval(cutA.splitByPlane([Math.sin(th), -Math.cos(th), 0], 0)[0]);
      cutA.delete();
      at.delete();
      if (wedge.isEmpty()) { wedge.delete(); throw new Error('the sector came out empty - is the centre right?'); }

      const copies = [];
      for (let k = 0; k < N; k++) {
        copies.push(k === 0 ? wedge : wedge.rotate([0, 0, (k * 360) / N]));
      }
      let acc = copies[0];
      for (let k = 1; k < copies.length; k++) {
        const u = forceEval(acc.add(copies[k]));
        if (acc !== wedge) acc.delete();
        copies[k].delete();
        acc = u;
      }
      const out = forceEval(acc.translate([cx, cy, 0]));
      if (acc !== wedge) acc.delete();
      wedge.delete();

      const id = arena.retain(arena.track(out));
      return {
        solidId: id, order: N,
        volumeBefore: before, volumeAfter: out.volume(),
        movedMm3: Math.abs(out.volume() - before),
        movedPct: before ? Math.abs(out.volume() - before) / before * 100 : 0,
        bbox: out.boundingBox(),
      };
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

/**
 * The seam's own frame: n across the cut, u along it, z through the sheet.
 *
 * The requirement is that the sheet lies in XY and the cut goes straight down
 * through it - which means the seam normal is HORIZONTAL. It does not mean the
 * normal is an axis. Insisting on X or Y was a convenience of indexing, and it
 * ruled out every radial cut, which is exactly what a wheel wants: sixteen
 * spokes can only be cut alike by sixteen planes at sixteen angles.
 *
 * u = n x z, which makes (u, n, z) right-handed for every n. That is worth
 * saying because the axis-indexed version was NOT: for an X-normal seam it
 * built a left-handed frame, silently mirrored every polygon, and the fix was a
 * special case that reversed the ring. Choosing the basis properly removes both
 * the mirror and the special case.
 */
function seamFrame(plane) {
  const L = Math.hypot(plane.n[0], plane.n[1], plane.n[2]) || 1;
  const n = [plane.n[0] / L, plane.n[1] / L, plane.n[2] / L];
  if (Math.abs(n[2]) > 1e-3) {
    throw new Error('profiled cuts need a seam that runs straight down through a sheet lying in XY');
  }
  // Scaling the normal to unit length scales the offset with it, or the plane
  // moves.
  return { n, u: [n[1], -n[0], 0], d: plane.d / L };
}

const unit3 = (v) => {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
};

/** Seam-local (x across the rail from `at`, y along the normal) -> world XY. */
const seamPoint = ({ n, u, d }, at, x, y) => [
  n[0] * (d + y) + u[0] * (at + x),
  n[1] * (d + y) + u[1] * (at + x),
];

/** How far along u a set of world points reaches. */
function uRange(fr, verts) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const t = verts[i] * fr.u[0] + verts[i + 1] * fr.u[1];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return [lo, hi];
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
 *
 * The probe is centred on the SOLID, not on the origin. A span reckoned from
 * the model's own size but laid out from u = 0 covers the model only when the
 * model happens to sit near the origin: measured on a 100 mm slab at
 * x = 350..450, the probe reached x = 400 and reported one lump 50 mm wide for
 * material that is 100 mm wide. The EEDX wheel sits at x = 3193..4160 against
 * a span of 3869, so 291 mm of its rim would have gone unseen.
 */
function seamSection(m, fr) {
  const { Manifold, CrossSection } = ctx();
  const bb = m.boundingBox();
  const T = bb.max[2] - bb.min[2];
  const uMid = (bb.min[0] + bb.max[0]) / 2 * fr.u[0] + (bb.min[1] + bb.max[1]) / 2 * fr.u[1];
  const span = 4 * Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
  const probe = 0.5;
  const ring = [[-span, -probe / 2], [span, -probe / 2], [span, probe / 2], [-span, probe / 2]]
    .map(([x, y]) => seamPoint(fr, uMid, x, y));
  const rect = new CrossSection([ring], 'Positive');
  // extrude() and translate() each allocate; only the translated one is kept,
  // so the intermediate has to be released by hand or it leaks for the session.
  const flat = Manifold.extrude(rect, T + 4);
  const slab = flat.translate([0, 0, bb.min[2] - 2]);
  flat.delete();
  rect.delete();
  const sec = forceEval(m.intersect(slab));
  slab.delete();
  const lumps = [];
  for (const c of sec.decompose()) {
    if (!c.isEmpty()) {
      // Project the real vertices, not the bounding box. An AABB is exact only
      // when u is a world axis; on a radial seam it reports a rail wider than
      // it is, and a tab sized from that overhangs the material it sits in.
      const mesh = c.getMesh();
      const [lo, hi] = uRange(fr, mesh.vertProperties);
      const b = c.boundingBox();
      if (Number.isFinite(lo) && hi > lo) {
        lumps.push({
          at: (lo + hi) / 2, width: hi - lo, uLo: lo, uHi: hi,
          zLo: b.min[2], zHi: b.max[2],
        });
      }
    }
    c.delete();
  }
  sec.delete();
  lumps.sort((p, q) => p.at - q.at);
  return { u: fr.u, n: fr.n, thickness: T, lumps };
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
