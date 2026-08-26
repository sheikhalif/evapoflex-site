/**
 * Area-weighted histogram of face normals over directions.
 *
 * Ranking ~200 candidate print orientations by looping over half a million
 * triangles each is 1e8 dot products. Binning the surface area by normal
 * direction once - here into a 16x32 spherical grid, ~512 bins - collapses each
 * candidate to ~512 operations, which is what makes the orientation panel
 * interactive rather than a progress bar.
 *
 * A grid over (theta, phi) has uneven bin solid angles, but that is harmless
 * here: the histogram is a weighted SUM over bins, not a density estimate, so
 * bin shape only affects the ~2 degree quantisation of the 45 degree threshold,
 * which is inside the tolerance of "about 45 degrees" anyway.
 */

const NT = 16, NP = 32;          // theta rows, phi columns

export function buildNormalHist(normal, area) {
  const h = new Float32Array(NT * NP);
  const dirs = binDirs();
  const nTri = area.length;
  for (let t = 0; t < nTri; t++) {
    const x = normal[t * 3], y = normal[t * 3 + 1], z = normal[t * 3 + 2];
    const theta = Math.acos(Math.max(-1, Math.min(1, z)));
    let phi = Math.atan2(y, x);
    if (phi < 0) phi += 2 * Math.PI;
    const it = Math.min(NT - 1, (theta / Math.PI * NT) | 0);
    const ip = Math.min(NP - 1, (phi / (2 * Math.PI) * NP) | 0);
    h[it * NP + ip] += area[t];
  }
  return { h, dirs };
}

function binDirs() {
  const dirs = new Float32Array(NT * NP * 3);
  for (let it = 0; it < NT; it++) {
    const theta = (it + 0.5) / NT * Math.PI;
    for (let ip = 0; ip < NP; ip++) {
      const phi = (ip + 0.5) / NP * 2 * Math.PI;
      const k = (it * NP + ip) * 3;
      dirs[k] = Math.sin(theta) * Math.cos(phi);
      dirs[k + 1] = Math.sin(theta) * Math.sin(phi);
      dirs[k + 2] = Math.cos(theta);
    }
  }
  return dirs;
}

/**
 * Fast overhang estimate: total area whose normal points more than 45 degrees
 * below the horizon for build direction `up`. No plate exclusion, no bridging -
 * this is the coarse tier; the exact audit runs on the shortlist only.
 */
export function estimateOverhang(hist, up) {
  const { h, dirs } = hist;
  const limit = -Math.SQRT1_2;
  let s = 0;
  for (let b = 0; b < h.length; b++) {
    if (h[b] === 0) continue;
    const d = dirs[b * 3] * up[0] + dirs[b * 3 + 1] * up[1] + dirs[b * 3 + 2] * up[2];
    if (d < limit) s += h[b];
  }
  return s;
}

/** Projected shadow area on the plate: sum a_b * |n_b . up| / 2 over the closed surface. */
export function estimateShadow(hist, up) {
  const { h, dirs } = hist;
  let s = 0;
  for (let b = 0; b < h.length; b++) {
    if (h[b] === 0) continue;
    s += h[b] * Math.abs(dirs[b * 3] * up[0] + dirs[b * 3 + 1] * up[1] + dirs[b * 3 + 2] * up[2]);
  }
  return s / 2;
}
