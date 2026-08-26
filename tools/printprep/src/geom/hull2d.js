/** 2D convex hull, minimum-area enclosing rectangle, and exact overlap tests. */

/** Andrew's monotone chain. Returns a counter-clockwise hull without duplicates. */
export function convexHull(points) {
  if (points.length < 3) return points.slice();
  const p = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area enclosing rectangle by rotating calipers.
 *
 * The optimum always has one side flush with a hull edge, which is what makes
 * this exact rather than a search: try every edge, keep the best.
 */
export function minAreaRect(hull) {
  if (hull.length < 3) {
    const xs = hull.map((p) => p[0]), ys = hull.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    return { angle: 0, w, h, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2, area: w * h };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [px, py] of hull) {
      const x = px * c - py * s, y = px * s + py * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      best = {
        angle: ang, w: x1 - x0, h: y1 - y0, area,
        cx: mx * Math.cos(ang) - my * Math.sin(ang),
        cy: mx * Math.sin(ang) + my * Math.cos(ang),
      };
    }
  }
  return best;
}

/** Separating-axis test for two convex polygons. Touching counts as clear. */
export function convexOverlap(A, B, gap = 0) {
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      let nx = -(b[1] - a[1]), ny = b[0] - a[0];
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of A) { const d = x * nx + y * ny; if (d < a0) a0 = d; if (d > a1) a1 = d; }
      for (const [x, y] of B) { const d = x * nx + y * ny; if (d < b0) b0 = d; if (d > b1) b1 = d; }
      if (a1 + gap <= b0 || b1 + gap <= a0) return false;
    }
  }
  return true;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export function translatePoly(poly, dx, dy) { return poly.map(([x, y]) => [x + dx, y + dy]); }

export function rotatePoly(poly, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return poly.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}
