/**
 * Polygon rasterising and an exact Euclidean distance transform.
 *
 * This is the engine behind joint placement, and it is worth explaining why a
 * distance field rather than something more direct.
 *
 * The question at every cut face is "where on this face can I put a square joint
 * of side S so that it is entirely inside the material, with margin?" - asked
 * hundreds of times, for several candidate sizes, on a shape that is an
 * arbitrary polygon with holes. A distance transform answers all of it at once,
 * because an axis-free square of side S fits centred at c exactly when
 * D(c) >= S/sqrt(2), where D is the distance to the nearest boundary. So one
 * O(n) pass gives the largest joint at every point, the best site, and whether
 * the face can take a joint at all, from a single array lookup.
 *
 * The transform is Felzenszwalb-Huttenlocher: exact, two passes of 1-D lower
 * envelopes of parabolas, linear in the number of cells. Not an approximation
 * with a 3x3 chamfer mask - the error in those is a few percent, and a few
 * percent of a joint's clearance is the whole clearance.
 */

/**
 * Scanline-rasterise a set of polygons with the even-odd rule.
 * @param {number[][][]} polys  array of loops, each an array of [x, y]
 * @returns {{mask: Uint8Array, w: number, h: number, x0: number, y0: number, cell: number}}
 */
export function rasterize(polys, { cell = 0.5, pad = 2 } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const loop of polys) for (const [x, y] of loop) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!isFinite(x0)) return { mask: new Uint8Array(0), w: 0, h: 0, x0: 0, y0: 0, cell };
  x0 -= pad * cell; y0 -= pad * cell; x1 += pad * cell; y1 += pad * cell;
  const w = Math.max(1, Math.ceil((x1 - x0) / cell));
  const h = Math.max(1, Math.ceil((y1 - y0) / cell));
  const mask = new Uint8Array(w * h);

  // Sample at cell centres. Crossings are counted with a half-open rule on y so
  // a vertex exactly on a scanline is counted once, not twice or zero times.
  const xs = [];
  for (let j = 0; j < h; j++) {
    const y = y0 + (j + 0.5) * cell;
    xs.length = 0;
    for (const loop of polys) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % n];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.ceil((xs[k] - x0) / cell - 0.5);
      let i1 = Math.floor((xs[k + 1] - x0) / cell - 0.5);
      if (i0 < 0) i0 = 0;
      if (i1 >= w) i1 = w - 1;
      for (let i = i0; i <= i1; i++) mask[j * w + i] = 1;
    }
  }
  return { mask, w, h, x0, y0, cell };
}

/**
 * Exact Euclidean distance, in millimetres, from every set cell to the nearest
 * unset cell. Cells outside the shape get 0.
 */
export function distanceField(grid) {
  const { mask, w, h, cell } = grid;
  const INF = 1e20;
  const f = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = mask[i] ? INF : 0;

  const col = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const out = new Float64Array(Math.max(w, h));

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = f[y * w + x];
    edt1d(col, h, v, z, out);
    for (let y = 0; y < h; y++) f[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) col[x] = f[y * w + x];
    edt1d(col, w, v, z, out);
    for (let x = 0; x < w; x++) f[y * w + x] = out[x];
  }

  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = Math.sqrt(f[i]) * cell;
  return { d, w, h, x0: grid.x0, y0: grid.y0, cell };
}

/** Lower envelope of parabolas, one row or column. */
function edt1d(f, n, v, z, out) {
  let k = 0;
  v[0] = 0; z[0] = -1e20; z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    out[q] = dq * dq + f[v[k]];
  }
}

export const at = (fld, i, j) => fld.d[j * fld.w + i];
export const cellCentre = (fld, i, j) => [fld.x0 + (i + 0.5) * fld.cell, fld.y0 + (j + 0.5) * fld.cell];

/** Intersect two masks defined on the same grid. */
export function andMask(a, b) {
  const m = new Uint8Array(a.mask.length);
  for (let i = 0; i < m.length; i++) m[i] = a.mask[i] & b.mask[i];
  return { ...a, mask: m };
}

/** Rasterise onto a grid that already exists, so masks can be combined. */
export function rasterizeOnto(polys, grid) {
  const { w, h, x0, y0, cell } = grid;
  const mask = new Uint8Array(w * h);
  const xs = [];
  for (let j = 0; j < h; j++) {
    const y = y0 + (j + 0.5) * cell;
    xs.length = 0;
    for (const loop of polys) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % n];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.ceil((xs[k] - x0) / cell - 0.5), i1 = Math.floor((xs[k + 1] - x0) / cell - 0.5);
      if (i0 < 0) i0 = 0;
      if (i1 >= w) i1 = w - 1;
      for (let i = i0; i <= i1; i++) mask[j * w + i] = 1;
    }
  }
  return { mask, w, h, x0, y0, cell };
}
