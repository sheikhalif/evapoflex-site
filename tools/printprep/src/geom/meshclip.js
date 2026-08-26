/**
 * Split a triangle soup by a plane, cheaply and approximately.
 *
 * This is the search-time cutter. The real cut is manifold's splitByPlane,
 * exact and watertight, run once on the decided tree; this one runs hundreds of
 * times inside the beam search, on the proxy mesh, where all that matters is
 * that bounding boxes, hull points, areas and overhang histograms come out
 * about right. It clips triangles against the plane and does not cap the cut -
 * an open shell measures the same as a capped one for every quantity the
 * objective reads.
 */

/** @returns {{a: Float32Array, b: Float32Array}} soups on the +n and -n sides */
export function clipSoup(soup, n, d) {
  const nTri = soup.length / 9;
  const a = [], b = [];
  const pd = (i) => soup[i] * n[0] + soup[i + 1] * n[1] + soup[i + 2] * n[2] - d;

  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const dv = [pd(o), pd(o + 3), pd(o + 6)];
    const pos = dv.filter((x) => x >= 0).length;
    if (pos === 3) { pushTri(a, soup, o); continue; }
    if (pos === 0) { pushTri(b, soup, o); continue; }

    // Split: gather the polygon on each side by walking the triangle's edges.
    const P = [], Q = [];
    for (let k = 0; k < 3; k++) {
      const i = o + k * 3, j = o + ((k + 1) % 3) * 3;
      const di = dv[k], dj = dv[(k + 1) % 3];
      const pi = [soup[i], soup[i + 1], soup[i + 2]];
      (di >= 0 ? P : Q).push(pi);
      if ((di >= 0) !== (dj >= 0)) {
        const s = di / (di - dj);
        const x = [
          soup[i] + s * (soup[j] - soup[i]),
          soup[i + 1] + s * (soup[j + 1] - soup[i + 1]),
          soup[i + 2] + s * (soup[j + 2] - soup[i + 2]),
        ];
        P.push(x); Q.push(x);
      }
    }
    fan(a, P); fan(b, Q);
  }
  return { a: new Float32Array(a), b: new Float32Array(b) };
}

function pushTri(out, soup, o) { for (let i = 0; i < 9; i++) out.push(soup[o + i]); }
function fan(out, poly) {
  for (let i = 1; i + 1 < poly.length; i++) out.push(...poly[0], ...poly[i], ...poly[i + 1]);
}

/** Axis-aligned bounds of a soup. */
export function soupBounds(soup) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = soup[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** Surface area of a soup. */
export function soupArea(soup) {
  let area = 0;
  for (let o = 0; o < soup.length; o += 9) {
    const ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
    const vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return area;
}

/**
 * Down-sample a soup to roughly targetTris by area-weighted random selection.
 * Good enough for a search proxy: it preserves the area distribution, which is
 * what the overhang and orientation estimates read.
 */
export function decimateSoup(soup, targetTris, seed = 42) {
  const nTri = soup.length / 9;
  if (nTri <= targetTris) return soup;
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const keepProb = targetTris / nTri;
  const out = [];
  for (let t = 0; t < nTri; t++) {
    if (rand() < keepProb) for (let i = 0; i < 9; i++) out.push(soup[t * 9 + i]);
  }
  return new Float32Array(out);
}
