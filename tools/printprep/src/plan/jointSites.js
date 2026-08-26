/**
 * Where the joints go on a cut face, how big they are, and which side gets the
 * male half.
 *
 * The workhorse is a pair of distance fields on the section plane.
 *
 * The first is of the contact region itself, eroded by the margin: an axis-free
 * square of side S fits centred at c exactly when D(c) >= S/sqrt(2), so one
 * transform answers "largest joint anywhere", "best sites" and "any joint at
 * all" by lookup.
 *
 * The second is of the SOLID region - the cells that remain material at several
 * depths into both pieces. A joint needs T millimetres of block behind the face
 * on both sides, and a single slice at depth T would miss a cavity at T/2, so
 * the mask is the AND of slices at T/3, 2T/3 and T into each piece. Ray tests
 * would sample one line and miss a void two millimetres to the side; boolean
 * probe volumes would cost hundreds of milliseconds per candidate. The mask
 * answers for every site at once for the price of six sections.
 */
import { sectionLoops } from '../geom/slice2d.js';
import { rasterize, rasterizeOnto, distanceField, andMask, cellCentre } from '../geom/raster.js';
import { params } from '../csg/joint.js';

const SQRT2 = Math.SQRT2;

/**
 * @param {Float32Array} soupA  piece on the +n side (as unindexed soup)
 * @param {Float32Array} soupB  piece on the -n side
 * @param {{n, d}} plane
 * @param {object} opts  {sMin, sMax, margin, fit, nozzle}
 * @returns {null | {sites, S, T, frame, lobes}}
 */
export function placeJoints(soupA, soupB, plane, opts = {}) {
  const sMin = opts.sMin ?? 12, sMax = opts.sMax ?? 25;
  const margin = opts.margin ?? Math.max(1.5, 2 * (opts.nozzle ?? 0.4));
  const { n, d } = plane;

  // Contact = a slice just inside A intersected with one just inside B. Slicing
  // exactly at the plane is degenerate - the cut faces lie in it.
  //
  // When a rootSoup is supplied, every section is taken through the CLOSED root
  // and masked down to each side's halfspaces on the raster. Slicing the
  // pieces' own soups only works while the section plane crosses none of their
  // earlier cut faces - clipped soups are open there, the loops do not close,
  // and the rasteriser sees garbage. One cut in, that is fine; a
  // grandchild piece with a perpendicular earlier cut is exactly where joints
  // used to quietly fail to place.
  const eps = 0.05;
  const root = opts.rootSoup || null;
  const hsA = opts.hsA || [], hsB = opts.hsB || [];
  const sliceSide = (side, off) => {
    if (!root) return sectionOf(side === 'A' ? soupA : soupB, n, off);
    return sectionOf(root, n, off);
  };
  const maskBy = (grid, sec, hs) => {
    if (!root || !hs.length) return grid;
    const { mask, w, h, x0, y0, cell } = grid;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!mask[k]) continue;
      const x = x0 + (i + 0.5) * cell, y = y0 + (j + 0.5) * cell;
      const px = sec.u[0] * x + sec.w[0] * y + sec.n[0] * sec.d;
      const py = sec.u[1] * x + sec.w[1] * y + sec.n[1] * sec.d;
      const pz = sec.u[2] * x + sec.w[2] * y + sec.n[2] * sec.d;
      for (const hsp of hs) {
        // The plane being jointed is among the halfspaces; the slice offset
        // already handles it, so allow a little slack rather than erasing the
        // whole section.
        if ((hsp.n[0] * px + hsp.n[1] * py + hsp.n[2] * pz - hsp.d) * hsp.sign < -0.6) { mask[k] = 0; break; }
      }
    }
    return grid;
  };

  const secA = sliceSide('A', d + eps);
  const secB = sliceSide('B', d - eps);
  if (!secA.loops.length || !secB.loops.length) return null;

  const cell = Math.max(0.4, Math.sqrt(Math.max(secA.area, 1)) / 160);
  const gridA = maskBy(rasterize(secA.loops, { cell, pad: 4 }), secA, hsA);
  if (!gridA.mask.length) return null;
  const gridB = maskBy({ ...gridA, mask: rasterizeOnto(remapLoops(secB, secA), gridA).mask }, secB, hsB);
  const contact = andMask(gridA, gridB);

  // Erode by the margin via the distance field: a cell is usable if it is at
  // least `margin` inside the contact region.
  const fld = distanceField(contact);
  let maxD = 0;
  for (let i = 0; i < fld.d.length; i++) if (fld.d[i] > maxD) maxD = fld.d[i];
  // S0 is only an upper bound from the contact face. The final size is chosen
  // jointly with the material-behind field below - sizing from the contact
  // alone once made a wheel hub offer an 18.5 mm joint whose solid field
  // topped out a hair under it, and the placement returned nothing instead of
  // a slightly smaller joint that fit fine.
  const S0 = quantize(Math.min(sMax, SQRT2 * (maxD - margin)), 0.5);
  if (S0 < sMin) return null;

  let P = params(S0, opts.fit || {});
  let T = P.T;

  // Material-behind mask: solid at T/3, 2T/3 and T into both pieces.
  let solid = contact;
  for (const frac of [1 / 3, 2 / 3, 1]) {
    const sa = sliceSide('A', d + T * frac);
    const sb = sliceSide('B', d - T * frac);
    if (!sa.loops.length || !sb.loops.length) return null;
    solid = andMask(solid, maskBy({ ...gridA, mask: rasterizeOnto(remapLoops(sa, secA), gridA).mask }, sa, hsA));
    solid = andMask(solid, maskBy({ ...gridA, mask: rasterizeOnto(remapLoops(sb, secA), gridA).mask }, sb, hsB));
  }
  const solidFld = distanceField(solid);

  // The size the face really supports: at the best cell, the joint must fit
  // the margin-eroded contact AND the solid-at-depth field. The slices above
  // were taken at S0's (deeper) block thickness, so shrinking S only makes
  // them conservative.
  let bestJoint = 0;
  for (let k = 0; k < fld.d.length; k++) {
    const j = Math.min(fld.d[k] - margin, solidFld.d[k]);
    if (j > bestJoint) bestJoint = j;
  }
  const S = Math.min(S0, quantize(SQRT2 * bestJoint, 0.5));
  if (S < sMin) return null;
  P = params(S, opts.fit || {});
  T = P.T;

  // Candidate cells: joint fits the eroded contact AND the solid mask.
  const need = S / SQRT2 + margin;
  const needSolid = S / SQRT2;
  const cand = [];
  for (let j = 0; j < fld.h; j++) {
    for (let i = 0; i < fld.w; i++) {
      const k = j * fld.w + i;
      if (fld.d[k] >= need && solidFld.d[k] >= needSolid) cand.push(k);
    }
  }
  if (!cand.length) return null;

  // Connected lobes of the contact region - each needs at least one joint or
  // that island of the interface is unbonded.
  const lobes = labelLobes(contact);

  // How many joints: by area, clamped 1..4, at least one per lobe with sites.
  const areaMm2 = contact.mask.reduce((s, v) => s + v, 0) * cell * cell;
  let N = Math.max(1, Math.min(4, Math.floor(areaMm2 / (6 * S * S))));
  const lobesWithCand = new Set(cand.map((k) => lobes.label[k]));
  N = Math.max(N, lobesWithCand.size);

  // Farthest-point placement on the distance field, seeded at the deepest cell.
  const sites = [];
  const cellXY = (k) => cellCentre(fld, k % fld.w, (k / fld.w) | 0);
  let pool = cand.slice();
  const lobesCovered = new Set();
  while (sites.length < N && pool.length) {
    let best = -1, bestScore = -Infinity;
    for (const k of pool) {
      const [x, y] = cellXY(k);
      let dm = Infinity;
      for (const s of sites) dm = Math.min(dm, Math.hypot(x - s.x, y - s.y));
      // Prefer uncovered lobes strongly, then deep + spread.
      const lobeBonus = lobesCovered.has(lobes.label[k]) ? 0 : 1000;
      const score = lobeBonus + solidFld.d[k] + 0.5 * (sites.length ? dm : 0);
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best < 0) break;
    const [x, y] = cellXY(best);
    sites.push({ x, y, cellIndex: best, lobe: lobes.label[best] });
    lobesCovered.add(lobes.label[best]);
    pool = pool.filter((k) => {
      const [px, py] = cellXY(k);
      return Math.hypot(px - x, py - y) >= 1.6 * S;
    });
  }
  if (!sites.length) return null;

  return {
    S, T, params: P,
    sites: sites.map((s) => ({ ...s, world: toWorld(secA, s.x, s.y, d) })),
    frame: { n, d, u: secA.u, w: secA.w },
    areaMm2, lobeCount: lobes.count, maxD,
  };
}

function sectionOf(soup, n, d) {
  const nPts = soup.length / 3;
  const tris = new Uint32Array(nPts);
  for (let i = 0; i < nPts; i++) tris[i] = i;
  return sectionLoops(soup, tris, n, d);
}

/**
 * Sections at different offsets have parallel frames but their loops are
 * expressed with the same (u, w) axes - only the origin along n differs, which
 * projection ignores. So loops transfer between grids directly as long as both
 * sections share u and w; sectionLoops derives the frame purely from n, so they
 * do.
 */
function remapLoops(sec, ref) { return sec.loops; }

function toWorld(sec, x, y, d) {
  return [
    sec.u[0] * x + sec.w[0] * y + sec.n[0] * d,
    sec.u[1] * x + sec.w[1] * y + sec.n[1] * d,
    sec.u[2] * x + sec.w[2] * y + sec.n[2] * d,
  ];
}

const quantize = (v, q) => Math.floor(v / q) * q;

/** 4-connected labelling of the set cells. */
function labelLobes(grid) {
  const { mask, w, h } = grid;
  const label = new Int32Array(w * h).fill(-1);
  let count = 0;
  const stack = [];
  for (let seed = 0; seed < w * h; seed++) {
    if (!mask[seed] || label[seed] !== -1) continue;
    const id = count++;
    stack.length = 0; stack.push(seed); label[seed] = id;
    while (stack.length) {
      const k = stack.pop();
      const i = k % w, j = (k / w) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const kk = jj * w + ii;
        if (mask[kk] && label[kk] === -1) { label[kk] = id; stack.push(kk); }
      }
    }
  }
  return { label, count };
}

/**
 * Which piece gets the male half.
 *
 * The male's boss and balls protrude, and protrusions print cleanly pointing up
 * and badly pointing down - so the male belongs on the piece that will print
 * this face most nearly facing upward. Ties go to the smaller piece: if a snap
 * ever breaks, the cheaper reprint should be the one carrying the fragile bits.
 */
export function assignMale(faceNormalOutwardA, upA, upB, volA, volB) {
  // Score: how "up" does the cut face point on each piece, in that piece's
  // chosen print orientation? Piece A's cut face points along -n_outward_A when
  // printed with up = upA.
  const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const scoreA = d(faceNormalOutwardA.map((v) => -v), upA);
  const scoreB = d(faceNormalOutwardA, upB);
  if (Math.abs(scoreA - scoreB) < 0.2) return volA <= volB ? 'A' : 'B';
  return scoreA > scoreB ? 'A' : 'B';
}
