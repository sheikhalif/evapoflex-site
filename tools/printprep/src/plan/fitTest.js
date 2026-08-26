/**
 * Does a piece fit the printer - with its joints on?
 *
 * The joint changes the answer: the male half stands hb proud of the split
 * plane and the female reaches below it, so a piece that fits by its cut
 * bounding box can stop fitting the moment its joints are stamped. During the
 * search the joints do not exist yet, so the test inflates each cut face's
 * boundary outward along its normal by the worst protrusion the chosen joint
 * family can produce. That bound can only over-estimate, which gives the search
 * a one-way guarantee: anything it accepts, the exact post-stamp audit can only
 * confirm.
 */
import { params } from '../csg/joint.js';

/** The largest protrusion any joint up to maxS can add on either side of a cut. */
export function protrusionBound(maxS = 25, fit = {}) {
  const p = params(maxS, fit);
  return Math.max(p.hb, p.depth) + 0.2;      // + a breath of slack
}

/**
 * Candidate "up" directions for fitting: the box diagonals matter less than the
 * axes, so try axes first and only then diagonals.
 */
const FIT_DIRS = (() => {
  const dirs = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const l = Math.hypot(x, y, z);
    dirs.push([x / l, y / l, z / l]);
  }
  return dirs;
})();

/**
 * @param {number[][]} pts        hull points of the piece (cut geometry)
 * @param {{n: number[], boundary: number[][]}[]} cutFaces  outward normals + boundary points
 * @param {{x,y,z}} bed
 * @returns {null | {up: number[], size: number[]}} a direction in which it fits
 */
export function fitsWithJoints(pts, cutFaces, bed, prot, margin = 2) {
  const all = pts.slice();
  for (const f of cutFaces) for (const p of f.boundary) {
    all.push([p[0] + f.n[0] * prot, p[1] + f.n[1] * prot, p[2] + f.n[2] * prot]);
  }
  for (const up of FIT_DIRS) {
    const size = extentUnder(all, up);
    // Height along `up` is bounded by bed.z; the two lateral extents must fit
    // the plate. Lateral extents come out sorted so x/y assignment is free.
    if (size.h <= bed.z - margin &&
        Math.min(size.a, size.b) <= Math.min(bed.x, bed.y) - 2 * margin &&
        Math.max(size.a, size.b) <= Math.max(bed.x, bed.y) - 2 * margin) {
      return { up, size: [size.a, size.b, size.h] };
    }
  }
  return null;
}

/** Extents of a point set with `up` as height; lateral extents via 16-angle sweep. */
function extentUnder(pts, up) {
  const ref = Math.abs(up[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(up, ref)), v = cross(up, u);
  let h0 = Infinity, h1 = -Infinity;
  const uu = [], vv = [];
  for (const p of pts) {
    const h = p[0] * up[0] + p[1] * up[1] + p[2] * up[2];
    if (h < h0) h0 = h;
    if (h > h1) h1 = h;
    uu.push(p[0] * u[0] + p[1] * u[1] + p[2] * u[2]);
    vv.push(p[0] * v[0] + p[1] * v[1] + p[2] * v[2]);
  }
  // The part can be yawed on the plate, so the lateral footprint is the minimum
  // over rotations - approximated at 16 angles, which is within a percent or
  // two of the calipers optimum and needs no hull.
  let best = null;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI;
    const c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < uu.length; i++) {
      const x = uu[i] * c - vv[i] * s, y = uu[i] * s + vv[i] * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const w = x1 - x0, hgt = y1 - y0;
    if (!best || w * hgt < best.a * best.b) best = { a: w, b: hgt };
  }
  return { a: best.a, b: best.b, h: h1 - h0 };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Sample a soup down to a few hundred hull-ish points for the fit test. */
export function fitPoints(soup, budget = 400) {
  const nTri = soup.length / 9;
  const stride = Math.max(1, Math.floor(nTri / budget));
  const pts = [];
  for (let t = 0; t < nTri; t += stride) pts.push([soup[t * 9], soup[t * 9 + 1], soup[t * 9 + 2]]);
  // Always include the extremes along each axis, or a sparse sample can shave
  // the true bounding box and pass a piece that does not fit.
  for (let k = 0; k < 3; k++) {
    let loI = 0, hiI = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < soup.length; i += 3) {
      if (soup[i + k] < lo) { lo = soup[i + k]; loI = i; }
      if (soup[i + k] > hi) { hi = soup[i + k]; hiI = i; }
    }
    pts.push([soup[loI], soup[loI + 1], soup[loI + 2]], [soup[hiI], soup[hiI + 1], soup[hiI + 2]]);
  }
  return pts;
}
