/**
 * Recognising primitives in a shell: is this a flat face, a bore, a cone, or
 * something freeform?
 *
 * The discriminator is the area-weighted covariance of the face normals,
 * C = sum(a_i * n_i n_i^T). One 3x3 symmetric eigensolve per shell tells you
 * almost everything:
 *
 *   one large eigenvalue, two near zero   the normals all point one way: planar
 *   two large, one near zero              the normals sweep a great circle, so
 *                                         the surface is swept about an axis
 *   all three comparable                  the normals cover the sphere: freeform
 *
 * For the swept case the axis is the eigenvector of the *smallest* eigenvalue -
 * the one direction no normal has a component along. A cylinder's mean normal is
 * zero (they cancel around the barrel); a cone's is not, and its size gives the
 * half-angle.
 */

/** Eigen-decomposition of a symmetric 3x3, closed form. Returns values descending. */
export function eigenSym3(m) {
  const [a, b, c, d, e, f] = [m[0], m[1], m[2], m[4], m[5], m[8]];   // xx xy xz yy yz zz
  const p1 = b * b + c * c + e * e;
  let eig;
  if (p1 === 0) {
    eig = [a, d, f];
  } else {
    const q = (a + d + f) / 3;
    const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1;
    const p = Math.sqrt(p2 / 6) || 1e-30;
    const B = [(a - q) / p, b / p, c / p, b / p, (d - q) / p, e / p, c / p, e / p, (f - q) / p];
    const detB = B[0] * (B[4] * B[8] - B[5] * B[7]) - B[1] * (B[3] * B[8] - B[5] * B[6]) + B[2] * (B[3] * B[7] - B[4] * B[6]);
    const r = Math.min(1, Math.max(-1, detB / 2));
    const phi = Math.acos(r) / 3;
    const e1 = q + 2 * p * Math.cos(phi);
    const e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
    eig = [e1, 3 * q - e1 - e3, e3];
  }
  eig.sort((x, y) => y - x);
  return { values: eig, vectors: eig.map((l) => eigenVector(m, l)) };
}

/** Null-space vector of (M - lambda I), by the largest cross product of its rows. */
function eigenVector(m, lambda) {
  const r = [
    [m[0] - lambda, m[1], m[2]],
    [m[3], m[4] - lambda, m[5]],
    [m[6], m[7], m[8] - lambda],
  ];
  let best = null, bestLen = -1;
  for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) {
    const v = cross(r[i], r[j]);
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  if (bestLen < 1e-12) return [0, 0, 1];
  return [best[0] / bestLen, best[1] / bestLen, best[2] / bestLen];
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/**
 * Classify every shell and fit cylinders where they exist.
 * Mutates `shells` in place with .kind, .axis, .radius, .center, .extent,
 * .isHole, .through, .residual.
 */
export function fitPrimitives(m, reg, bvh, opts = {}) {
  const { verts, tris, normal, area } = m;
  const cylinders = [];
  const shellTris = groupTrisByShell(reg.triShell, shellCount(reg.shells));

  for (const s of reg.shells) {
    const list = shellTris[s.id];
    if (!list || list.length === 0) { s.kind = 'freeform'; continue; }

    const C = new Float64Array(9);
    let aTot = 0, mn = [0, 0, 0];
    for (const t of list) {
      const w = area[t], n = [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]];
      aTot += w;
      for (let i = 0; i < 3; i++) { mn[i] += n[i] * w; for (let j = 0; j < 3; j++) C[i * 3 + j] += w * n[i] * n[j]; }
    }
    for (let i = 0; i < 9; i++) C[i] /= aTot;
    for (let i = 0; i < 3; i++) mn[i] /= aTot;
    const { values, vectors } = eigenSym3(C);
    const [l1, l2, l3] = values;

    if (l2 < 0.02 * l1) { s.kind = 'planar'; s.n = vectors[0]; continue; }
    if (l3 > 0.15 * l1) { s.kind = 'freeform'; continue; }

    // Swept about vectors[2]. Cylinder if the mean normal is (nearly) zero.
    const axis = vectors[2];
    const meanLen = Math.hypot(mn[0], mn[1], mn[2]);
    const fit = fitCylinder(verts, tris, normal, area, list, axis, m.diag, opts);
    if (!fit) { s.kind = meanLen > 0.25 ? 'conical' : 'freeform'; s.axis = axis; continue; }

    Object.assign(s, fit, { kind: fit.coverage >= 0.9 ? 'cylindrical' : 'round' });
    if (s.kind === 'cylindrical' && bvh) {
      s.through = isThroughHole(bvh, fit);
      cylinders.push(s);
    }
  }
  return cylinders;
}

function shellCount(shells) { return shells.length; }

function groupTrisByShell(triShell, nShell) {
  const out = Array.from({ length: nShell }, () => []);
  for (let t = 0; t < triShell.length; t++) if (triShell[t] >= 0) out[triShell[t]].push(t);
  return out;
}

/**
 * Kasa algebraic circle fit on the projected points, then two Gauss-Newton steps
 * on the true geometric residual. Kasa alone biases the radius when the arc is
 * short, and short arcs are exactly the fillets we need to tell apart from bores.
 */
function fitCylinder(verts, tris, normal, area, list, axis, diag, opts = {}) {
  const up = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(axis, up)), v = cross(axis, u);

  const seen = new Set(), P = [];
  let hmin = Infinity, hmax = -Infinity;
  for (const t of list) {
    for (let k = 0; k < 3; k++) {
      const vi = tris[t * 3 + k];
      if (seen.has(vi)) continue;
      seen.add(vi);
      const p = [verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]];
      P.push([dot(p, u), dot(p, v)]);
      const h = dot(p, axis);
      if (h < hmin) hmin = h;
      if (h > hmax) hmax = h;
    }
  }
  if (P.length < 8) return null;

  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of P) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = P.length;
  const A = [sxx - sx * sx / n, sxy - sx * sy / n, sxy - sx * sy / n, syy - sy * sy / n];
  const B = [(sxz - sx * sz / n) / 2, (syz - sy * sz / n) / 2];
  const det = A[0] * A[3] - A[1] * A[2];
  if (Math.abs(det) < 1e-12) return null;
  let cx = (B[0] * A[3] - A[1] * B[1]) / det;
  let cy = (A[0] * B[1] - B[0] * A[2]) / det;
  let r = Math.sqrt(Math.max(0, sz / n - 2 * cx * sx / n - 2 * cy * sy / n + cx * cx + cy * cy));

  for (let iter = 0; iter < 2; iter++) {
    let g0 = 0, g1 = 0, g2 = 0, h00 = 0, h11 = 0, h22 = n, h01 = 0, h02 = 0, h12 = 0;
    for (const [x, y] of P) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r, ux = -dx / d, uy = -dy / d;
      g0 += res * ux; g1 += res * uy; g2 += -res;
      h00 += ux * ux; h11 += uy * uy; h01 += ux * uy; h02 += -ux; h12 += -uy;
    }
    const s = solve3([h00, h01, h02, h01, h11, h12, h02, h12, h22], [-g0, -g1, -g2]);
    if (!s) break;
    cx += s[0]; cy += s[1]; r += s[2];
  }
  if (!(r > 0) || r > diag) return null;

  let sse = 0;
  const bins = new Uint8Array(36);
  for (const [x, y] of P) {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
    sse += (d - r) ** 2;
    bins[Math.min(35, Math.floor((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * 36))] = 1;
  }
  const residual = Math.sqrt(sse / n);
  const tol = opts.cylTol ?? Math.max(0.05, 0.01 * r);
  if (residual > tol) return null;

  let filled = 0;
  for (let i = 0; i < 36; i++) filled += bins[i];
  const coverage = filled / 36;
  if (coverage < 0.4) return null;

  // Hole or boss: do the surface normals point at the axis or away from it?
  let radialSum = 0;
  for (const t of list) {
    const cxx = centroidOf(verts, tris, t);
    const rel = [cxx[0], cxx[1], cxx[2]];
    const rx = dot(rel, u) - cx, ry = dot(rel, v) - cy;
    const rl = Math.hypot(rx, ry) || 1;
    const nn = [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]];
    radialSum += area[t] * ((rx / rl) * dot(nn, u) + (ry / rl) * dot(nn, v));
  }

  const center = [
    u[0] * cx + v[0] * cy + axis[0] * (hmin + hmax) / 2,
    u[1] * cx + v[1] * cy + axis[1] * (hmin + hmax) / 2,
    u[2] * cx + v[2] * cy + axis[2] * (hmin + hmax) / 2,
  ];
  return { axis, radius: r, center, extent: hmax - hmin, hmin, hmax, coverage, residual, isHole: radialSum < 0 };
}

function centroidOf(verts, tris, t) {
  const o = [0, 0, 0];
  for (let k = 0; k < 3; k++) { const v = tris[t * 3 + k] * 3; o[0] += verts[v] / 3; o[1] += verts[v + 1] / 3; o[2] += verts[v + 2] / 3; }
  return o;
}

/**
 * A hole is "through" if a probe just outside each end of its axis extent, held
 * at half its radius off the axis, is outside the solid. Blind holes fail at one
 * end. Ray parity through the BVH answers it in microseconds.
 */
function isThroughHole(bvh, fit) {
  const { axis, center, radius, extent } = fit;
  const up = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(axis, up));
  const half = extent / 2 + Math.max(0.5, radius * 0.2);
  for (const s of [-1, 1]) {
    const p = [0, 1, 2].map((i) => center[i] + axis[i] * s * half + u[i] * radius * 0.5);
    if (bvh.pointInside(p)) return false;
  }
  return true;
}

function unit(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function solve3(A, b) {
  const M = [A[0], A[1], A[2], b[0], A[3], A[4], A[5], b[1], A[6], A[7], A[8], b[2]];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r * 4 + c]) > Math.abs(M[piv * 4 + c])) piv = r;
    if (Math.abs(M[piv * 4 + c]) < 1e-14) return null;
    if (piv !== c) for (let k = 0; k < 4; k++) { const t = M[c * 4 + k]; M[c * 4 + k] = M[piv * 4 + k]; M[piv * 4 + k] = t; }
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r * 4 + c] / M[c * 4 + c];
      for (let k = c; k < 4; k++) M[r * 4 + k] -= f * M[c * 4 + k];
    }
  }
  return [M[3] / M[0], M[7] / M[5], M[11] / M[10]];
}
