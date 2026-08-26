/**
 * Stamping a joint pair into two real pieces.
 *
 * The joint solids are built in a canonical frame - footprint centred at the
 * origin, mating plane at z = 0, male below-and-through, female above - and
 * moved into place with one rigid transform per site. The recipe at each face:
 *
 *   zone = the S x S x (2T) prism around each site, crossing the plane
 *   A' = (A - zones) + female solids       A is the +n piece
 *   B' = (B - zones) + male solids
 *
 * Clearing the zone from BOTH pieces before adding the halves back is the whole
 * trick: it is what lets the male reach above the plane into what was A's
 * territory, and the female reach below it into B's, without either addition
 * overlapping leftover material. All N sites on a face batch into four booleans
 * per piece total.
 *
 * Containment - the joint staying inside the part - is guaranteed by the site
 * selection (margin inside the contact region, solid at three depths both
 * sides) and then audited: the volume of each half clipped against its piece
 * must be nearly all of it. A loud audit failure beats a silently truncated
 * joint that fails on the printer.
 */
import { ctx, forceEval } from './manifoldCtx.js';
import { makeJoint, params } from './joint.js';

/**
 * Column-major 4x4 from an orthonormal frame. Manifold's transform() takes
 * exactly this layout, which also happens to be THREE.Matrix4.elements.
 */
export function frameMatrix(u, w, n, origin) {
  return [
    u[0], u[1], u[2], 0,
    w[0], w[1], w[2], 0,
    n[0], n[1], n[2], 0,
    origin[0], origin[1], origin[2], 1,
  ];
}

/**
 * @param {Manifold} A  piece on the +n side of the plane
 * @param {Manifold} B  piece on the -n side
 * @param {object} placement  from placeJoints(): {S, sites, frame}
 * @param {object} opts  {fit, maleOn: 'A'|'B'}
 * @returns {{A: Manifold, B: Manifold, audit, meta}}   caller owns the returns
 */
export function stampJoints(A, B, placement, opts = {}) {
  const { Manifold } = ctx();
  const { S, sites, frame } = placement;
  const fit = opts.fit || {};
  const maleOn = opts.maleOn || 'B';
  const p = params(S, fit);

  // In the canonical joint frame the male occupies z<0 side (its block spans
  // [-T, 0] plus protrusions to hb) and the female the z>0 side... actually the
  // male block spans [-T, hb] and the female [-depth, T]. We want the male's
  // block to live in the piece that carries it. With maleOn = 'B' (the -n
  // side), the joint's +z axis must point INTO A, i.e. along +n; with
  // maleOn = 'A', flip the frame so +z points along -n.
  const flip = maleOn === 'A';
  const nDir = flip ? frame.n.map((v) => -v) : frame.n.slice();
  const uDir = frame.u.slice();
  // Recompute w so the frame stays right-handed after a flip.
  const wDir = cross(nDir, uDir).map((v, i) => v);
  const wFixed = cross(nDir, uDir);
  const uFixed = cross(wFixed, nDir);

  const { male, female } = makeJoint(S, fit);
  const zone = Manifold.cube([S, S, 2 * (p.T + 1)], true);

  const males = [], females = [], zones = [];
  for (const s of sites) {
    const M = frameMatrix(unit(uFixed), unit(wFixed), unit(nDir), s.world);
    males.push(male.transform(M));
    females.push(female.transform(M));
    zones.push(zone.transform(M));
  }
  male.delete(); female.delete(); zone.delete();

  const zoneAll = Manifold.union(zones);
  zones.forEach((z) => z.delete());
  const maleAll = Manifold.union(males);
  males.forEach((m) => m.delete());
  const femaleAll = Manifold.union(females);
  females.forEach((f) => f.delete());

  // Audit before mutating: each stamped solid must be (almost) entirely inside
  // the union of the two pieces, or the site selection lied.
  const both = Manifold.union([A, B]);
  const inM = Manifold.intersection([maleAll, both]);
  const inF = Manifold.intersection([femaleAll, both]);
  const maleContained = inM.volume() / (maleAll.volume() || 1);
  const femaleContained = inF.volume() / (femaleAll.volume() || 1);
  inM.delete(); inF.delete(); both.delete();

  const carrierMale = maleOn === 'A' ? A : B;
  const carrierFemale = maleOn === 'A' ? B : A;

  const mCleared = Manifold.difference([carrierMale, zoneAll]);
  const fCleared = Manifold.difference([carrierFemale, zoneAll]);
  const mOut = forceEval(Manifold.union([mCleared, maleAll]));
  const fOut = forceEval(Manifold.union([fCleared, femaleAll]));
  mCleared.delete(); fCleared.delete();
  zoneAll.delete(); maleAll.delete(); femaleAll.delete();

  const audit = {
    maleContained, femaleContained,
    ok: maleContained > 0.98 && femaleContained > 0.98,
    maleStatus: mOut.status(), femaleStatus: fOut.status(),
  };

  return {
    A: maleOn === 'A' ? mOut : fOut,
    B: maleOn === 'A' ? fOut : mOut,
    audit,
    meta: { S, T: p.T, hb: p.hb, depth: p.depth, maleOn, siteCount: sites.length, axis: nDir },
  };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
