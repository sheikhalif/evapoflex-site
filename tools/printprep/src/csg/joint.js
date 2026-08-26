/**
 * The EVF support-free snap joint.
 *
 * A direct port of evf_joint.py onto manifold's JavaScript binding. The Python
 * original uses trimesh with the manifold3d engine, so this runs the same
 * kernel on the same construction and is expected to be numerically identical,
 * not merely similar - the test suite pins volume, genus and the six-direction
 * overhang audit against the Python output at several sizes.
 *
 * The design, in short, because the code below only makes sense with it in hand:
 *
 *   waffle face   A field of 45 degree pyramids standing in for a flat mating
 *                 face. A genuinely flat shoulder is a 90 degree ceiling when
 *                 the part prints upside down, and the usual fix - sloping the
 *                 whole face at 45 degrees - drops the corners by half the face
 *                 width. Pyramids stay within one tooth depth of the mean plane
 *                 and lock shear and yaw by form.
 *   centre boss   Tapered diamond section with a flat top. The flat is legal
 *                 only because this is the tallest feature, so it lands on the
 *                 build plate when the part is inverted. It locates X, Y and
 *                 yaw, and enters first, squaring the parts up before anything
 *                 snaps. The female relieves the space above it so the flat
 *                 never touches and all location stays on the four flanks.
 *   two balls     Octahedral ball-and-socket snaps on one diagonal, retention
 *                 only, on clearance shafts so they never argue with the boss
 *                 about position. One is larger, which keys the pair to a single
 *                 orientation for free.
 *
 * Diamond sections everywhere is not decoration. A vertical wall is only
 * printable if it faces 45 degrees in plan; a wall sloped at 45 degrees may face
 * any direction. A rotated square satisfies both at once.
 *
 * What scales with size and what does not is the other half of the design. Loads
 * scale, so the boss and the feature heights scale. Clearances are set by the
 * printer, not the joint, so they do not. Snap interference is strain limited,
 * so it is clamped.
 */
import { ctx } from './manifoldCtx.js';

/** Everything derives from the face size. */
export function params(size = 30, opts = {}) {
  const { thickness = null, tol = 0.15, bossFit = 0.10, shaftFit = 0.30, blind = false } = opts;
  const S = Number(size);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const pitch = clamp(S / 6, 3, 6);          // 3 mm is about seven extrusions
  const depth = pitch / 2;                    // 45 degree teeth

  const bb = 0.26 * S, bt = 0.20 * S;         // boss base and top half-width
  const q = 0.30 * S;                         // ball centres, on one diagonal
  const r1 = clamp(0.10 * S, 1.6, 6.0);
  const r2 = r1 * 1.18;                       // the odd one out keys orientation
  const hs = 0.22 * S;                        // ball seat height

  // Interference is what retains, so it is specified directly and the bulge is
  // built on top of the shaft clearance. Under 0.30 mm the printer cannot
  // resolve it; over 0.80 mm the socket wall yields instead of flexing. Strain
  // limited, so it does not scale linearly.
  const snap = (r) => {
    const interference = clamp(0.15 * r, 0.30, 0.80);
    return [shaftFit + interference, interference];
  };
  const [e1, i1] = snap(r1);
  const [e2, i2] = snap(r2);

  const top = Math.max(hs + e1 + r1, hs + e2 + r2);
  const hb = top + Math.max(1.0, 0.12 * S);   // sized from the balls, not the face

  // The boss cavity has to clear the boss. Roofing it at 45 degrees costs
  // another 0.6 boss-widths of depth, which is a lot of block, so the default is
  // a through hole with the boss top recessed 2 mm inside it.
  const rel = Math.max(0.5, 0.02 * S);
  const roof = bt + bossFit + 0.8;
  const T = thickness ? Number(thickness)
    : Math.max(0.45 * S, blind ? hb + rel + roof + 1.0 : hb + 2.0, 8.0);

  const w1 = r1 - e1, w2 = r2 - e2;
  return {
    S, T, pitch, depth, bb, bt, hb, q, r1, r2, e1, e2, i1, i2, w1, w2, hs,
    tol, bossFit, shaftFit, blind: !!blind, rel,
    thinShaft: Math.min(w1, w2) * 2 < 1.6,
  };
}

// ------------------------------------------------------------------ primitives

const hull = (pts) => ctx().Manifold.hull(pts);
const box = (sx, sy, sz, c = [0, 0, 0]) => ctx().Manifold.cube([sx, sy, sz], true).translate(c);
const uni = (...m) => ctx().Manifold.union(m.flat());
const dif = (a, b) => ctx().Manifold.difference([a, b]);
const int = (a, b) => ctx().Manifold.intersection([a, b]);

/**
 * One convex hull through a stack of diamond cross-sections [[halfWidth, z], ...].
 * Every sloped wall this produces faces 45 degrees in plan, which is what makes
 * the whole joint printable in six directions.
 */
export function dstack(levels, cx = 0, cy = 0) {
  const p = [];
  for (const [h, z] of levels) p.push([cx + h, cy, z], [cx - h, cy, z], [cx, cy + h, z], [cx, cy - h, z]);
  return hull(p);
}

/** A slab with a 45 degree sawtooth top running along one axis. */
function sawtooth(pitch, depth, half, floor, axis) {
  const solids = [box(2 * half + 4, 2 * half + 4, Math.abs(floor) - depth + 1, [0, 0, (floor - depth) / 2 - 0.5])];
  const n = Math.ceil((2 * half) / pitch) + 2;
  const L = half + 3;
  for (let k = -n; k <= n; k++) {
    const c = k * pitch;
    const tri = [[c - pitch / 2, -depth], [c + pitch / 2, -depth], [c, 0]];
    const pts = [];
    for (const s of [-L, L]) for (const [t, z] of tri) pts.push(axis === 'x' ? [s, t, z] : [t, s, z]);
    solids.push(hull(pts));
  }
  return uni(solids);
}

/** Two crossed sawtooths intersect to a field of pyramids. */
export function waffle(pitch, depth, half, floor, lift = 0) {
  let w = int(sawtooth(pitch, depth, half, floor, 'x'), sawtooth(pitch, depth, half, floor, 'y'));
  if (lift) w = w.translate([0, 0, lift]);
  return int(w, box(2 * half, 2 * half, 400, [0, 0, 200 + floor - 40]));
}

function ball(cx, cy, r, e, hs, floor) {
  const w = r - e;
  return uni(
    dstack([[w, floor - 1.0], [w, hs]], cx, cy),
    dstack([[w, hs], [r, hs + e], [0.3, hs + e + r - 0.3]], cx, cy),
  );
}

/**
 * Socket: a clearance bore plus the chamber the ball snaps into.
 *
 * The chamber's entry cone is continued downward until it is strictly narrower
 * than the bore, so their junction leaves no ledge. A ledge there would be a
 * flat ceiling in the inverted build direction, which is the one thing this
 * joint exists to avoid.
 */
function socket(cx, cy, r, e, hs, floor, fit, relief) {
  const w = r - e;
  const bore = dstack([[w + fit, floor - 4.0], [w + fit, hs + 0.15]], cx, cy);
  const zlo = hs + e - (r + fit) + 0.3;
  const chamber = dstack([
    [0.3, zlo], [r + fit, hs + e], [r + fit, hs + e + relief], [0.3, hs + e + relief + r + fit],
  ], cx, cy);
  return uni(bore, chamber);
}

/**
 * The two halves, mated about z = 0 with the footprint centred on the origin.
 *
 * Male spans z from -T up to hb, so it protrudes above the mating plane.
 * Female spans z from -depth up to T, so it reaches below it to fill the male's
 * waffle valleys. Both facts matter to the caller: a piece's printed bounding
 * box is not its cut bounding box.
 */
export function makeJoint(size = 30, opts = {}) {
  const p = params(size, opts);
  const { S, T } = p;
  const half = S / 2;
  const floor = -p.depth;

  const base = waffle(p.pitch, p.depth, half, -T);
  const boss = dstack([[p.bb, floor - 1.0], [p.bt, p.hb]]);
  const b1 = ball(p.q, p.q, p.r1, p.e1, p.hs, floor);
  const b2 = ball(-p.q, -p.q, p.r2, p.e2, p.hs, floor);
  const male = int(uni(base, boss, b1, b2), box(S, S, 400, [0, 0, 200 - T]));

  const cb = p.bossFit, rel = p.rel;
  let bossCav;
  if (p.blind) {
    // The taper runs past the boss top and a bicone roof closes it. The roof is
    // slightly wider than the taper so the junction leaves no ledge, and the
    // boss's flat top is left standing in clear air.
    const ztop = p.hb + rel, hroof = p.bt + cb + 0.8;
    bossCav = uni(
      dstack([[p.bb + cb, floor - 1.0], [p.bt + cb, ztop]]),
      dstack([[0.3, ztop + 0.6 - hroof + 0.3], [hroof, ztop + 0.6], [0.3, ztop + 0.6 + hroof - 0.3]]),
    );
  } else {
    // Through hole: no ceiling anywhere, and the recessed flat top is visible
    // from the back, which is a free check that the joint has seated.
    bossCav = uni(
      dstack([[p.bb + cb, floor - 1.0], [p.bt + cb, p.hb]]),
      dstack([[p.bt + cb + 0.15, p.hb - 2.0], [p.bt + cb + 0.15, T + 2.0]]),
    );
  }
  const s1 = socket(p.q, p.q, p.r1, p.e1, p.hs, floor, p.shaftFit, rel);
  const s2 = socket(-p.q, -p.q, p.r2, p.e2, p.hs, floor, p.shaftFit, rel);

  const fbox = box(S, S, T + p.depth, [0, 0, (T - p.depth) / 2]);
  let female = dif(fbox, waffle(p.pitch, p.depth, half, -T, p.tol));
  female = dif(female, uni(bossCav, s1, s2));

  return { male, female, params: p };
}

/**
 * The negative volumes the female half removes, and the block it adds, in the
 * joint's own frame. Stamping a joint into a real part needs these separately
 * from the finished female solid.
 */
export function femaleParts(size = 30, opts = {}) {
  const p = params(size, opts);
  const half = p.S / 2;
  const floor = -p.depth;
  const cb = p.bossFit, rel = p.rel;
  const bossCav = p.blind
    ? uni(
      dstack([[p.bb + cb, floor - 1.0], [p.bt + cb, p.hb + rel]]),
      dstack([[0.3, p.hb + rel + 0.6 - (p.bt + cb + 0.8) + 0.3], [p.bt + cb + 0.8, p.hb + rel + 0.6],
              [0.3, p.hb + rel + 0.6 + p.bt + cb + 0.8 - 0.3]]))
    : uni(
      dstack([[p.bb + cb, floor - 1.0], [p.bt + cb, p.hb]]),
      dstack([[p.bt + cb + 0.15, p.hb - 2.0], [p.bt + cb + 0.15, p.T + 2.0]]));
  return {
    params: p,
    negative: uni(
      waffle(p.pitch, p.depth, half, -p.T, p.tol),
      bossCav,
      socket(p.q, p.q, p.r1, p.e1, p.hs, floor, p.shaftFit, rel),
      socket(-p.q, -p.q, p.r2, p.e2, p.hs, floor, p.shaftFit, rel),
    ),
    /** The slab the female must gain below the mating plane to fill the male's valleys. */
    fill: box(p.S, p.S, p.depth, [0, 0, -p.depth / 2]),
  };
}
