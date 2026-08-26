/** Analytic test solids, produced as unindexed triangle soup exactly like an STL. */

/** Axis-aligned box centred on the origin. 12 triangles, outward winding. */
export function boxSoup(sx = 10, sy = 10, sz = 10) {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const v = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const q = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const out = [];
  for (const [a, b, c, d] of q) { out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]); }
  return new Float32Array(out);
}

/**
 * Rectangular plate with one through hole down Z.
 *
 * Built as a quad strip between the hole ring and the rectangle outline, sampled
 * at the same angles, so both faces stay watertight and consistently wound. The
 * outline samples land exactly on the rectangle's sides, so the four side faces
 * are genuinely planar and merge into four regions.
 */
export function plateWithHole(sx = 40, sy = 30, sz = 8, r = 5, seg = 64) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const ring = [], out = [];
  for (let i = 0; i < seg; i++) {
    const a = ((i + 0.5) / seg) * Math.PI * 2;     // half-step keeps samples off the corners
    const dx = Math.cos(a), dy = Math.sin(a);
    const t = Math.min(Math.abs(dx) < 1e-12 ? Infinity : hx / Math.abs(dx),
                       Math.abs(dy) < 1e-12 ? Infinity : hy / Math.abs(dy));
    ring.push({ in: [Math.cos(a) * r, Math.sin(a) * r], out: [dx * t, dy * t] });
  }
  const tri = (p, q, s) => out.push(...p, ...q, ...s);

  for (let i = 0; i < seg; i++) {
    const A = ring[i], B = ring[(i + 1) % seg];
    const ai = [A.in[0], A.in[1]], bi = [B.in[0], B.in[1]];
    const ao = [A.out[0], A.out[1]], bo = [B.out[0], B.out[1]];
    // top, +Z out
    tri([...ai, hz], [...ao, hz], [...bo, hz]);
    tri([...ai, hz], [...bo, hz], [...bi, hz]);
    // bottom, -Z out
    tri([...ai, -hz], [...bo, -hz], [...ao, -hz]);
    tri([...ai, -hz], [...bi, -hz], [...bo, -hz]);
    // hole wall, normals pointing in at the axis
    tri([...ai, -hz], [...bi, hz], [...bi, -hz]);
    tri([...ai, -hz], [...ai, hz], [...bi, hz]);
    // outer wall, normals pointing away
    tri([...ao, -hz], [...bo, -hz], [...bo, hz]);
    tri([...ao, -hz], [...bo, hz], [...ao, hz]);
  }
  return new Float32Array(out);
}
