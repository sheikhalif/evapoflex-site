/**
 * Auto-Arrange: laying the parts out on as few plates as possible.
 *
 * Parts group by settings first - layer height, material, temperatures must
 * match to share a plate - and each group packs independently. Within a group:
 * min-area rectangle per footprint, MAXRECTS best-short-side-fit over the
 * rect's two natural rotations, then a push-together pass that slides each part
 * toward the others until true convex polygons touch. Rectangle packing wastes
 * roughly 40% on L-shaped parts; the push-together recovers most of it without
 * a no-fit-polygon implementation.
 *
 * On this printer (CoreXY, fixed bed) position has no effect on ringing, so the
 * objective is purely fewest plates, then the tightest cluster on the last one.
 */
import { convexHull, minAreaRect, convexOverlap, rotatePoly, translatePoly } from '../geom/hull2d.js';

/**
 * @param {object[]} items  [{id, footprint: [[x,y]...] convex, settingsKey}]
 * @param {{x, y}} bed  usable plate, mm
 * @param {object} opts  {gap, exclude: [[x,y]...] }
 * @returns {plates: [{settingsKey, placements: [{id, x, y, rot}]}]}
 */
export function autoArrange(items, bed, opts = {}) {
  const gap = opts.gap ?? 4;
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.settingsKey)) groups.set(it.settingsKey, []);
    groups.get(it.settingsKey).push(it);
  }

  const plates = [];
  for (const [settingsKey, group] of groups) {
    const orders = sortOrders(group);
    let best = null;
    for (const order of orders) {
      const p = packGroup(order, bed, gap, opts.exclude);
      const score = p.length * 1e9 + lastPlateSpan(p);
      if (!best || score < best.score) best = { plates: p, score };
    }
    for (const pl of best.plates) plates.push({ settingsKey, ...pl });
  }
  return { plates };
}

function sortOrders(group) {
  const byArea = group.slice().sort((a, b) => rectOf(b).area - rectOf(a).area);
  const byLong = group.slice().sort((a, b) => longSide(b) - longSide(a));
  const byWide = group.slice().sort((a, b) => rectOf(b).w - rectOf(a).w);
  const orders = [byArea, byLong, byWide];
  // Seeded shuffles for variety; deterministic so a re-run reproduces the plan.
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 3; k++) {
    const o = group.slice();
    for (let i = o.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [o[i], o[j]] = [o[j], o[i]]; }
    orders.push(o);
  }
  return orders;
}

const rectCache = new WeakMap();
function rectOf(it) {
  if (!rectCache.has(it)) rectCache.set(it, minAreaRect(convexHull(it.footprint)));
  return rectCache.get(it);
}
const longSide = (it) => Math.max(rectOf(it).w, rectOf(it).h);

function packGroup(order, bed, gap, exclude) {
  const plates = [];
  for (const it of order) {
    let placed = false;
    for (const plate of plates) {
      if (tryPlace(plate, it, bed, gap, exclude)) { placed = true; break; }
    }
    if (!placed) {
      const plate = { placements: [], polys: [] };
      plates.push(plate);
      if (!tryPlace(plate, it, bed, gap, exclude)) {
        // Cannot even fit alone: record it as unplaceable rather than dropping it.
        plate.placements.push({ id: it.id, x: bed.x / 2, y: bed.y / 2, rot: 0, tooBig: true });
      }
    }
  }
  return plates;
}

/** MAXRECTS-lite: scan positions on a coarse grid, best-short-side-fit, then push toward the crowd. */
function tryPlace(plate, it, bed, gap, exclude) {
  const hull = convexHull(it.footprint);
  const rect = minAreaRect(hull);
  const rots = [-rect.angle, -rect.angle + Math.PI / 2];
  if (plate.placements.length === 0) rots.push(0, Math.PI / 4);

  const step = 4;
  let best = null;
  for (const rot of rots) {
    const poly0 = rotatePoly(hull, rot);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const w = x1 - x0, h = y1 - y0;
    if (w + 2 * gap > bed.x || h + 2 * gap > bed.y) continue;
    for (let py = gap - y0; py + y0 + h <= bed.y - gap + 0.01; py += step) {
      for (let px = gap - x0; px + x0 + w <= bed.x - gap + 0.01; px += step) {
        const poly = translatePoly(poly0, px, py);
        if (collides(plate, poly, gap) || hitsExclude(poly, exclude, gap)) continue;
        // Best-short-side: prefer snug against what is already there (low x+y).
        const score = px + py;
        if (!best || score < best.score) best = { rot, px, py, poly, score };
        break;      // first fit in this row is the leftmost - move to next row
      }
    }
  }
  if (!best) return false;

  // Push toward the centroid of the placed parts (or the plate centre first).
  const target = plate.placements.length
    ? centroidOfPlacements(plate)
    : [bed.x / 2, bed.y / 2];
  let poly = best.poly, px = best.px, py = best.py;
  for (let iter = 0; iter < 200; iter++) {
    const c = polyCentroid(poly);
    const dx = target[0] - c[0], dy = target[1] - c[1];
    const l = Math.hypot(dx, dy);
    if (l < 1) break;
    const nx = px + dx / l, ny = py + dy / l;
    const cand = translatePoly(rotatePoly(convexHull(it.footprint), best.rot), nx, ny);
    if (collides(plate, cand, gap) || outOfBed(cand, bed, gap) || hitsExclude(cand, exclude, gap)) break;
    poly = cand; px = nx; py = ny;
  }

  plate.polys.push(poly);
  plate.placements.push({ id: it.id, x: px, y: py, rot: best.rot });
  return true;
}

function collides(plate, poly, gap) {
  for (const other of plate.polys) if (convexOverlap(poly, other, gap)) return true;
  return false;
}
function outOfBed(poly, bed, gap) {
  for (const [x, y] of poly) if (x < gap || y < gap || x > bed.x - gap || y > bed.y - gap) return true;
  return false;
}
function hitsExclude(poly, exclude, gap) {
  if (!exclude || !exclude.length) return false;
  return convexOverlap(poly, exclude, gap / 2);
}
function polyCentroid(poly) {
  let x = 0, y = 0;
  for (const [px, py] of poly) { x += px; y += py; }
  return [x / poly.length, y / poly.length];
}
function centroidOfPlacements(plate) {
  let x = 0, y = 0, n = 0;
  for (const poly of plate.polys) { const c = polyCentroid(poly); x += c[0]; y += c[1]; n++; }
  return [x / n, y / n];
}
function lastPlateSpan(plates) {
  if (!plates.length) return 0;
  const last = plates[plates.length - 1];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of last.polys) for (const [x, y] of poly) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return (x1 - x0) + (y1 - y0);
}
