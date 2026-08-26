/**
 * Exploded view: how far and which way each part moves.
 *
 * The graph has parts as nodes and SEAMS as edges - every place two parts meet,
 * whether or not a snap joint fitted there. Driving it off joints alone left
 * glue seams as non-edges, so their parts were treated as unrelated and got
 * scattered on a golden angle: the one arrangement guaranteed to look arbitrary
 * and to put parts through each other.
 *
 * A BFS from the largest part accumulates displacement along the seam normals,
 * so every part's first motion is straight out of its own seam - no sliding
 * along a mating face - and displacement compounds down the chain so the
 * assembly opens outward rather than everything sliding one way together.
 *
 * Adjacent parts separate by construction: a seam plane has one part on each
 * side, so any positive step along its normal pulls them apart. Parts that are
 * NOT adjacent have no such guarantee - two prongs of a fork explode along the
 * same axis and stay exactly as overlapped as they started - so a relaxation
 * pass at the end pushes any overlapping non-adjacent pair apart until the view
 * shows every part in the clear.
 */

const GAP = 8;              // mm of daylight to leave between parts when fully pulled

export function explodeVectors(parts, seams, rootId = null) {
  if (!parts.length) return new Map();
  const byId = new Map(parts.map((p) => [p.id, p]));
  const root = rootId ?? parts.slice().sort((a, b) => b.volume - a.volume)[0].id;

  const adj = new Map(parts.map((p) => [p.id, []]));
  const adjacent = new Set();
  for (const s of seams) {
    if (!byId.has(s.aId) || !byId.has(s.bId)) continue;
    // The seam normal points from B into A, so A leaves along +n and B along -n.
    adj.get(s.aId).push({ to: s.bId, axis: s.axis.map((v) => -v), seam: s });
    adj.get(s.bId).push({ to: s.aId, axis: s.axis.slice(), seam: s });
    adjacent.add(pairKey(s.aId, s.bId));
  }

  const dir = new Map([[root, [0, 0, 0]]]);
  const depth = new Map([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const q = queue.shift();
    for (const { to, axis, seam } of adj.get(q) || []) {
      if (dir.has(to)) continue;
      const part = byId.get(to);
      const ext = part ? extentAlong(part.size, axis) : 40;
      // Far enough to clear the male boss with room to see it, and far enough
      // that a big part does not look merely nudged.
      const step = Math.max(2.5 * (seam.hb || 10), 0.2 * ext, 14);
      const base = dir.get(q);
      dir.set(to, [base[0] + axis[0] * step, base[1] + axis[1] * step, base[2] + axis[2] * step]);
      depth.set(to, depth.get(q) + 1);
      queue.push(to);
    }
  }

  // Parts with no seam at all - a model that arrived as several bodies, or an
  // island that touches nothing - drift outward from the assembly centre so
  // they sit beside the pile rather than inside it.
  const centre = assemblyCentre(parts);
  let k = 0;
  for (const p of parts) {
    if (dir.has(p.id)) continue;
    const c = boxCentre(p.bbox) || centre;
    let v = [c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]];
    let L = Math.hypot(v[0], v[1], v[2]);
    if (L < 1e-6) {                       // dead centre: fan on the golden angle
      const a = k++ * 2.399963;
      v = [Math.cos(a), Math.sin(a), 0.25]; L = Math.hypot(v[0], v[1], v[2]);
    }
    const reach = 0.6 * Math.max(...p.size) + GAP;
    dir.set(p.id, [v[0] / L * reach, v[1] / L * reach, v[2] / L * reach]);
    depth.set(p.id, 1);
  }

  separate(parts, dir, adjacent);

  return new Map(parts.map((p) => [p.id, { dir: dir.get(p.id), depth: depth.get(p.id) || 0 }]));
}

/**
 * Push overlapping non-adjacent parts apart, at full extension.
 *
 * Only pairs that do NOT share a seam are touched: parts that do share one have
 * already been separated along their mating axis by the BFS, and shoving them
 * sideways here would make a joint that is meant to read as "these two pull
 * straight apart" look sheared instead.
 */
function separate(parts, dir, adjacent, iterations = 40) {
  const boxes = parts.filter((p) => p.bbox);
  if (boxes.length < 2) return;
  for (let it = 0; it < iterations; it++) {
    let worst = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (adjacent.has(pairKey(a.id, b.id))) continue;
        const da = dir.get(a.id) || [0, 0, 0], db = dir.get(b.id) || [0, 0, 0];
        const pen = penetration(a.bbox, da, b.bbox, db);
        if (!pen) continue;
        worst = Math.max(worst, pen.depth);
        // Split the correction between the two, along the least-overlapped
        // axis: that is the cheapest direction out and keeps the motion
        // readable as "these came apart", not "these swapped places".
        const push = pen.depth / 2;
        const ax = pen.axis;
        da[ax] -= push * pen.sign;
        db[ax] += push * pen.sign;
      }
    }
    if (worst < 0.01) break;
  }
}

/**
 * Overlap of two boxes after their offsets, or null if they are clear.
 * Returns the axis with the SHALLOWEST overlap - the shortest way out - and how
 * far apart they need to move along it, including the daylight gap.
 */
function penetration(ba, da, bb, db) {
  let bestAxis = -1, bestDepth = Infinity, bestSign = 1;
  for (let k = 0; k < 3; k++) {
    const aMin = ba.min[k] + da[k], aMax = ba.max[k] + da[k];
    const bMin = bb.min[k] + db[k], bMax = bb.max[k] + db[k];
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin) + GAP;
    if (overlap <= 0) return null;              // a clear axis means clear boxes
    if (overlap < bestDepth) {
      bestDepth = overlap;
      bestAxis = k;
      // Sign points from a towards b, so a retreats and b advances.
      bestSign = (aMin + aMax) <= (bMin + bMax) ? 1 : -1;
    }
  }
  return bestAxis < 0 ? null : { axis: bestAxis, depth: bestDepth, sign: bestSign };
}

/** Eased, staggered offset at animation time T in [0, 1]. */
export function explodeOffset(entry, T, maxDepth) {
  const start = 0.12 * entry.depth;
  const span = Math.max(0.25, 1 - 0.12 * (maxDepth || 1));
  const local = Math.min(1, Math.max(0, (T - start) / span));
  const eased = local * local * (3 - 2 * local);
  return entry.dir.map((v) => v * eased);
}

function extentAlong(size, axis) {
  return Math.abs(size[0] * axis[0]) + Math.abs(size[1] * axis[1]) + Math.abs(size[2] * axis[2]);
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function boxCentre(bb) {
  if (!bb) return null;
  return [0, 1, 2].map((k) => (bb.min[k] + bb.max[k]) / 2);
}

function assemblyCentre(parts) {
  const c = [0, 0, 0];
  let n = 0;
  for (const p of parts) {
    const b = boxCentre(p.bbox);
    if (!b) continue;
    c[0] += b[0]; c[1] += b[1]; c[2] += b[2]; n++;
  }
  return n ? c.map((v) => v / n) : [0, 0, 0];
}
