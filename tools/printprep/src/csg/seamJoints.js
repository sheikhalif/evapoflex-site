/**
 * Seam-profile joints: dovetails and puzzle tabs for sheet stock.
 *
 * The EVF snap joint in joint.js stamps a boss and sockets onto a flat cut
 * FACE. That needs a face with room in it - about 20 mm square for the smallest
 * useful joint - and the EEDX wheel does not have one anywhere: its rails are
 * 5 to 6.5 mm wide and 10 mm thick, so the largest joint that will sit on a cut
 * face there is 1.5 mm. Stamping is the wrong move on thin stock.
 *
 * So these joints are not stamped on the cut - they ARE the cut. The seam stops
 * being a straight line across the rail and becomes a profile with a tab on it,
 * extruded through the full thickness. That buys three things at once:
 *
 *   strength   The joint uses the whole 10 mm thickness instead of whatever
 *              fits inside a 6 mm face, and the tab's own flanks carry the
 *              tension that would otherwise need glue.
 *   printing   A profile extruded through the thickness is all vertical walls
 *              when the part lies flat: no overhangs anywhere, at any size.
 *   assembly   The parts drop together along the thickness and are then locked
 *              in the plane of the sheet by form.
 *
 * WHAT LOCKS WHAT. Take the rail running along n, its width across u, its
 * thickness along z. A tab whose flanks widen as they leave the seam cannot be
 * pulled back out along n - that is the tension the structure actually sees.
 * Sideways along u it is trapped by the socket walls. That leaves z, the
 * direction it was assembled along, and nothing about the profile resists it -
 * which is what the detent balls are for.
 *
 * THE 45 DEGREE RULE, again. joint.js keeps every sloped wall at 45 degrees so
 * the part prints in six directions. The same rule applies here but in a
 * different plane: the profile's own flanks are vertical when the sheet lies
 * flat, whatever their plan angle, so flat printing is free. Printing the rail
 * ON EDGE - thickness horizontal - turns those flanks into overhangs at the
 * flank angle. At 45 degrees they are still printable; past that they are not.
 * Hence the default. The rounded puzzle head cannot honour it near its equator,
 * so it is flagged as flat-only and the dovetail is the orientation-free one.
 */
import { ctx } from './manifoldCtx.js';
import { dstack } from './joint.js';

const box = (x, y, z, c = [0, 0, 0]) => ctx().Manifold.cube([x, y, z], true).translate(c);
const uni = (...s) => ctx().Manifold.union(s.flat());
const sub = (a, b) => a.subtract(b);
const int = (a, b) => a.intersect(b);

/**
 * Everything derives from the stock the seam is cut in.
 *
 * @param {string} type          'dovetail' | 'puzzle'
 * @param {{width:number, thickness:number}} stock  the rail at the seam
 * @param {object} opts
 *   flankDeg   dovetail flank angle from the rail axis. 45 keeps the joint
 *              printable on edge as well as flat.
 *   sideWall   material left either side of the tab. Below about 3 extrusions
 *              the socket wall splits instead of gripping.
 *   reach      tab length as a fraction of the stock width.
 *   clearance  total gap between tab and socket, per side.
 *   detent     ball-and-socket count on the tab flanks, 0 to disable.
 */
export function seamParams(type, stock, opts = {}) {
  const rawW = Number(stock.width), T = Number(stock.thickness);
  const {
    flankDeg = 45, sideWall = 1.2, reach = 0.9, clearance = 0.18,
    detent = 1, detentR = 0.45, nozzle = 0.4, bridgeMm = 2.0,
    boss = null, pillars = 0, pillarR = null,
  } = opts;

  // A boss pads the rail locally so the seam has stock to be a joint in.
  //
  // On the EEDX rails - 6 mm wide - the best tab available grips 0.9 mm, which
  // is not a joint, it is a suggestion. Widening the rail to 18 mm for 25 mm
  // either side of the seam costs a few grams and takes the grip to 5.6 mm. The
  // pad tapers back to the rail at 45 degrees in the PLANE OF THE SHEET, so it
  // is a vertical wall printed flat and a 45 degree wall printed on edge -
  // free in both, and no step for a crack to start at.
  const bossW = boss
    ? Math.max(rawW, boss.width ?? (Math.max(3 * rawW, 18) + (pillars > 0 ? 6 : 0)))
    : rawW;
  const bossL = boss ? (boss.length ?? Math.max(4 * rawW, 24)) : 0;
  const W = bossW;

  // The head is the widest part of the tab and it has to leave a socket wall
  // either side, so the head width - not the neck - is what the stock caps.
  // The tab and the pillars are competing for the same width, so the split has
  // to be made here rather than letting the tab take everything and leaving the
  // pillars nowhere to stand. The tab keeps the middle; the posts get the
  // shoulders. Without pillars the tab takes the lot, as before.
  const usable = Math.max(nozzle * 3, W - 2 * sideWall);
  const headMax = pillars > 0 ? Math.max(nozzle * 3, 0.56 * usable) : usable;
  const minNeck = nozzle * 2.5;                        // three extrusions, near enough

  let neck, head, R = 0, centre = 0, L;
  if (type === 'puzzle') {
    // Round head on a straight neck. R is set by the stock; the neck follows.
    R = headMax / 2;
    neck = Math.max(minNeck, 0.62 * headMax);          // a waist, not a pinch
    centre = R;                                        // head centre one radius up
    head = 2 * R;
    L = centre + R;
  } else {
    // Head width, neck width and tab length are one constraint, not three:
    // head = neck + 2*L*tan(flank). The stock fixes the head and the flank
    // angle is a printing decision, so the free choice is the neck - and it has
    // to be a PROPORTION of the head, not just above the nozzle floor. Solving
    // for the thinnest legal neck instead made every dovetail a spike: on 25 mm
    // stock it returned a 22.6 mm head on a 1 mm neck, which is a tab that
    // snaps off in the fingers rather than a joint.
    const t = Math.tan(flankDeg * Math.PI / 180);
    head = headMax;
    neck = Math.max(minNeck, (opts.neckRatio ?? 0.5) * head);
    L = Math.min(reach * W, (head - neck) / (2 * t));
  }

  const tabL = L;

  // Pillars: round posts standing through the full thickness, on the male's
  // shoulder either side of the tab, entering matching bores in the female.
  //
  // They have to be prismatic along the thickness like everything else here.
  // The parts come together along z, so a post pointing along the rail could
  // never enter its bore - it would have to be threaded in sideways, which is
  // the motion the tab exists to prevent. Standing them up along z instead
  // makes them part of the same drop-together assembly, and they are integral
  // to the part, not hardware.
  //
  // What they add is stiffness, not retention: the tab's undercut holds the
  // seam shut against tension, while a pair of posts a long way either side of
  // it carries the couple that would otherwise hinge the joint open.
  // Size the post to the shoulder it has to stand on, rather than sizing it
  // first and then testing whether it fits - those were two different numbers
  // and the test could never pass.
  const pillarGap = 1.2;                                 // wall between post and tab
  const pillarSpan = (W - 2 * sideWall - head) / 2;      // free shoulder each side
  const pr = pillarR ?? Math.min(2.2, (pillarSpan - pillarGap) / 2);
  const pillarFit = pillars > 0 && pr >= nozzle * 2;
  const pillarAt = pillarFit ? head / 2 + pillarGap / 2 + pr : 0;
  const pillarDepth = pillarFit ? Math.max(1.5, Math.min(0.55 * tabL + 1.2, 4 + pr)) : 0;

  return {
    type, W, T, rawW, neck, head, R, centre, tabL, clearance, sideWall, flankDeg,
    boss: boss ? { width: bossW, length: bossL, ramp: (bossW - rawW) / 2 } : null,
    pillars: pillarFit ? pillars : 0, pillarR: pr, pillarAt, pillarDepth,
    detent: detent > 0 && T >= 4 ? detent : 0,
    detentR: Math.min(detentR, 0.14 * T, 0.28 * neck),
    // Straight talk about what the stock can support.
    ok: W - 2 * sideWall >= nozzle * 3 && neck >= minNeck - 1e-6 && tabL >= 0.8,
    why: W - 2 * sideWall < nozzle * 3 ? `stock only ${W.toFixed(1)} mm wide - no room for a tab`
       : neck < minNeck - 1e-6 ? 'neck would be thinner than three extrusions'
       : tabL < 0.8 ? `flank angle leaves only ${tabL.toFixed(1)} mm of engagement - lower it or widen the stock` : null,
    // How much undercut there is to resist pull-out: the head's overhang each
    // side of the neck. This, not the tab length, is what holds the seam shut.
    grip: (head - neck) / 2,
    bridgeMm,
    // Which build directions stay support-free - and it depends on SIZE, not
    // just on shape.
    //
    // A dovetail flank is a plane at `flankDeg` to the rail, so at 45 degrees
    // or less it is printable whichever way up the part goes. The puzzle's
    // round head turns back on itself near the neck and that undercut is a true
    // overhang when the rail is printed on edge - but only if it is long enough
    // to matter. Measured: at 60 x 20 mm stock the puzzle wants 203 mm2 of
    // support on edge; at 25 x 10 and 6 x 10 it wants none, because the
    // undercut is shorter than a bridge and the slicer just spans it.
    orientations: (type !== 'puzzle' && flankDeg <= 45.001) || (head - neck) / 2 < bridgeMm
      ? ['flat', 'flat-inverted', 'on-edge', 'on-end']
      : ['flat', 'flat-inverted'],
  };
}

/**
 * The tab outline, closed, in seam coordinates: u across the rail, n along it.
 * The seam line is n = 0 and the tab sticks out into +n.
 */
export function tabPolygon(p) {
  const pts = [];
  if (p.type === 'puzzle') {
    const a = p.neck / 2, R = p.R, hc = p.centre;
    const inner = Math.sqrt(Math.max(0, R * R - a * a));
    const y1 = hc - inner;                     // where the neck meets the head
    pts.push([-a, 0], [a, 0], [a, y1]);
    const start = Math.atan2(y1 - hc, a);
    const end = Math.PI - start;
    const steps = 28;
    for (let i = 0; i <= steps; i++) {
      const th = start + (end - start) * (i / steps);
      pts.push([R * Math.cos(th), hc + R * Math.sin(th)]);
    }
    pts.push([-a, y1]);
  } else {
    const a = p.neck / 2, b = p.head / 2, L = p.tabL;
    pts.push([-a, 0], [a, 0], [b, L], [-b, L]);
  }
  return pts;
}

/** The full seam path across the rail, tab included - the cut the splitter makes. */
export function seamPath(p) {
  const half = p.W / 2 + 0.5;
  const tab = tabPolygon(p);
  return [[-half, 0], ...tab, [half, 0]];
}

function crossSection(poly) {
  const { CrossSection } = ctx();
  return new CrossSection([poly], 'Positive');
}

/**
 * The local pad that gives a thin rail something to be a joint in: full boss
 * width across the seam, tapering back to the rail at 45 degrees each end.
 * Both halves get it before the cut, so the pad is continuous across the seam
 * and the joint sits in the middle of solid material.
 */
export function bossPolygon(p) {
  if (!p.boss) return null;
  const w = p.rawW / 2, b = p.boss.width / 2, h = p.boss.length / 2, r = p.boss.ramp;
  return [
    [-w, -h], [w, -h], [b, -h + r], [b, h - r], [w, h], [-w, h], [-b, h - r], [-b, -h + r],
  ];
}

/** Pillar posts as a single solid, optionally grown for the bore side. */
function pillarSolid(p, grow = 0) {
  if (!p.pillars) return null;
  const { Manifold } = ctx();
  const r = p.pillarR + grow;
  const posts = [];
  for (const s of [-1, 1]) {
    const cyl = Manifold.cylinder(p.T + 2, r, r, 24, false).translate([s * p.pillarAt, p.pillarDepth / 2, -1]);
    posts.push(cyl);
    if (p.pillars < 2) break;
  }
  return uni(posts);
}

/** Tab prism, optionally grown by `grow` mm all round (the socket side). */
function tabSolid(p, grow = 0) {
  const { Manifold } = ctx();
  let cs = crossSection(tabPolygon(p));
  if (grow) cs = cs.offset(grow, 'Miter', 2, 0);
  const m = Manifold.extrude(cs, p.T + 2);
  cs.delete();
  return m.translate([0, 0, -1]);
}

/**
 * Detent balls on the tab flanks.
 *
 * Diamonds, not spheres, and for the reason joint.js gives: a sphere sitting on
 * a vertical wall overhangs its own equator, while a diamond's every face is at
 * 45 degrees and prints in any direction. They sit at mid-thickness so the tab
 * enters freely and snaps at the end of its travel.
 */
function detents(p, grow = 0) {
  if (!p.detent) return null;
  const r = p.detentR + grow;
  const z = p.T / 2;
  const solids = [];
  const at = p.type === 'puzzle' ? p.centre : p.tabL * 0.62;
  const halfWidth = p.type === 'puzzle'
    ? Math.sqrt(Math.max(0, p.R * p.R - (at - p.centre) * (at - p.centre)))
    : (p.neck + (p.head - p.neck) * (at / p.tabL)) / 2;
  for (const s of [-1, 1]) {
    solids.push(dstack([[0.1, z - r], [r, z], [0.1, z + r]], s * halfWidth, at));
  }
  return uni(solids);
}

/**
 * One mating pair in a bar of stock, for printing and trying by hand.
 * Returns two solids meeting at the seam, with the clearance already applied to
 * the socket only - the flat shoulders either side of the tab still touch, so
 * the joint locates on the tab and seats on the shoulders.
 */
export function makeSeamPair(type, stock, opts = {}) {
  const p = seamParams(type, stock, opts);
  if (!p.ok) throw new Error(p.why || 'stock too small for a seam joint');
  const armLen = opts.armLen ?? Math.max(18, 3 * p.W);
  const { Manifold } = ctx();

  // The bar is the RAIL's width; the boss pads it locally at the seam.
  const railW = p.boss ? p.rawW : p.W;
  const bossPoly = bossPolygon(p);
  const bossSolid = bossPoly
    ? (() => { const cs = crossSection(bossPoly); const m = Manifold.extrude(cs, p.T); cs.delete(); return m; })()
    : null;
  const bar = (yc) => {
    const plain = box(railW, armLen, p.T, [0, yc, p.T / 2]);
    if (!bossSolid) return plain;
    // Keep only the half of the pad that belongs to this side of the seam.
    const half = box(4 * p.W, armLen, p.T + 2, [0, yc, p.T / 2]);
    return uni(plain, int(bossSolid, half));
  };
  const tab = tabSolid(p, 0);
  const socket = tabSolid(p, p.clearance);

  // Male: the bar behind the seam, plus the tab, plus its detent balls. The
  // balls are trimmed to the thickness so they cannot poke out of the faces.
  const slab = box(4 * p.W, 4 * armLen, p.T, [0, 0, p.T / 2]);
  let male = uni(bar(-armLen / 2), int(tab, slab));
  const balls = detents(p, 0);
  if (balls) male = uni(male, int(balls, slab));

  // Female: the bar in front of the seam, less the socket and its dimples.
  let female = sub(bar(armLen / 2), socket);
  const dimples = detents(p, p.clearance);
  if (dimples) female = sub(female, dimples);

  // Pillars stand on the male and bore into the female. Trimmed to the slab so
  // a post can never stand proud of either face.
  const posts = pillarSolid(p, 0);
  if (posts) {
    male = uni(male, int(posts, slab));
    const bores = pillarSolid(p, p.clearance / 2);
    female = sub(female, bores);
    posts.delete(); bores.delete();
  }

  tab.delete(); socket.delete(); slab.delete();
  if (bossSolid) bossSolid.delete();
  return { male, female, params: p };
}

/**
 * A coupon: every variant asked for, laid out side by side, male and female
 * separated so they print as loose parts and can be tried by hand.
 */
export function makeSeamCoupon(variants, stock, opts = {}) {
  const gap = opts.gap ?? 6;
  const parts = [];
  let x = 0;
  const made = [];
  for (const v of variants) {
    const { male, female, params: p } = makeSeamPair(v.type, stock, { ...opts, ...v });
    const pitch = p.W + gap;
    parts.push(male.translate([x, 0, 0]));
    parts.push(female.rotate([0, 0, 180]).translate([x, -(gap + 2), 0]));
    made.push({ ...v, params: p, x });
    x += pitch;
  }
  return { solid: uni(parts), variants: made };
}
