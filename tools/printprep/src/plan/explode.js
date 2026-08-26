/**
 * Exploded view: how far and which way each part moves.
 *
 * The split graph has parts as nodes and joints as edges, each joint carrying
 * its mating axis. A BFS from the root accumulates displacement along those
 * axes, so every part's first motion is disengagement along its own joint - no
 * interpenetration on the way out - and displacement compounds down the chain
 * so the assembly opens outward. Staggering by depth makes the outer joints
 * visibly let go before the inner ones move.
 */
export function explodeVectors(parts, joints, rootId = null) {
  if (!parts.length) return new Map();
  const root = rootId ?? parts.slice().sort((a, b) => b.volume - a.volume)[0].id;

  const adj = new Map(parts.map((p) => [p.id, []]));
  for (const j of joints) {
    adj.get(j.aId)?.push({ to: j.bId, axis: j.axis.map((v) => -v), j });
    adj.get(j.bId)?.push({ to: j.aId, axis: j.axis.slice(), j });
  }

  const dir = new Map([[root, [0, 0, 0]]]);
  const depth = new Map([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const q = queue.shift();
    for (const { to, axis, j } of adj.get(q) || []) {
      if (dir.has(to)) continue;
      const part = parts.find((p) => p.id === to);
      const ext = part ? extentAlong(part.size, axis) : 40;
      const step = Math.max(2.5 * (j.hb || 10), 0.15 * ext, 12);
      const base = dir.get(q);
      dir.set(to, [base[0] + axis[0] * step, base[1] + axis[1] * step, base[2] + axis[2] * step]);
      depth.set(to, depth.get(q) + 1);
      queue.push(to);
    }
  }
  // Disconnected parts (no joints) drift radially so they do not sit inside the pile.
  let k = 0;
  for (const p of parts) {
    if (dir.has(p.id)) continue;
    const a = (k++ * 2.399963);       // golden angle
    dir.set(p.id, [Math.cos(a) * 40, Math.sin(a) * 40, 10]);
    depth.set(p.id, 1);
  }
  return new Map(parts.map((p) => [p.id, { dir: dir.get(p.id), depth: depth.get(p.id) || 0 }]));
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
