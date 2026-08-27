/**
 * Bringing up manifold inside a worker, and the small amount of hygiene that
 * keeps it honest.
 *
 * Two things are worth stating up front because both cause confusing failures
 * much later:
 *
 * 1. CSG in manifold 3.x is lazy. add/subtract/intersect build a deferred tree
 *    and cost nothing; the work happens on the first eager call - getMesh,
 *    volume, status, hull. That is a feature, until a loop builds a tree of
 *    thousands of nodes and evaluating it all at once spikes the heap into a
 *    crash. Hence forceEval(): call it every few dozen operations in any batch.
 *
 * 2. A mesh that fails to become a manifold does not throw on every path. It can
 *    come back with a non-OK status and then quietly produce garbage through
 *    every subsequent boolean. So status is checked at construction, once, and
 *    the failure is reported with what is actually wrong.
 */
import { track } from './arena.js';

let wasm = null;

export async function initManifold(manifoldUrl) {
  if (wasm) return wasm;
  const mod = await import(/* @vite-ignore */ manifoldUrl);
  wasm = await mod.default();
  wasm.setup();
  return wasm;
}

export function ctx() {
  if (!wasm) throw new Error('manifold not initialised');
  return wasm;
}

/**
 * Build a Manifold from a raw triangle soup or an indexed mesh, escalating the
 * weld tolerance if the first attempt is not 2-manifold.
 *
 * This mirrors manifold's own importer: try as-is, then merge, then merge at a
 * looser tolerance. It is a vertex welder, not a mesh repairer - it will not
 * fill a hole or fix a flipped triangle - so if all three rungs fail the honest
 * answer is to say what is broken, not to press on.
 */
export function solidFromMesh({ vertProperties, triVerts, numProp = 3 }, { diag = 0 } = {}) {
  const { Manifold, Mesh } = ctx();
  const attempts = [0, 0, Math.max(1e-4, 1e-4 * diag), Math.max(1e-3, 1e-3 * diag)];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const mesh = new Mesh({ numProp, vertProperties, triVerts });
    if (attempts[i] > 0) mesh.tolerance = attempts[i];
    if (i > 0) mesh.merge();
    try {
      let m = new Manifold(mesh);
      const status = m.status();
      if (status === 'NoError' && !m.isEmpty()) {
        // An inside-out solid is closed and consistently wound - just wound the
        // wrong way round, which Manifold reports as a NEGATIVE volume and is
        // otherwise perfectly happy to boolean with. Two of this repo's own five
        // sample models are like this (fork-bracket-300 at -3,480,000 mm3 and
        // bracket-300 at -3,444,000), and the tool imported both without a word
        // and then reported their parts' volumes as negative. Worse, every
        // volume-based check downstream - "did the joint add material?" among
        // them - reads backwards on an inverted solid. Flip it once, here.
        let flipped = false;
        if (m.volume() < 0) {
          const rev = new Uint32Array(triVerts.length);
          for (let t = 0; t < triVerts.length; t += 3) {
            rev[t] = triVerts[t + 2]; rev[t + 1] = triVerts[t + 1]; rev[t + 2] = triVerts[t];
          }
          const fixMesh = new Mesh({ numProp, vertProperties, triVerts: rev });
          if (attempts[i] > 0) { fixMesh.tolerance = attempts[i]; fixMesh.merge(); }
          const fm = new Manifold(fixMesh);
          if (fm.status() === 'NoError' && !fm.isEmpty() && fm.volume() > 0) {
            m.delete(); m = fm; flipped = true;
          } else { fm.delete(); }
        }
        return { id: track(m), tolerance: attempts[i], volume: m.volume(), genus: m.genus(), flipped };
      }
      lastErr = status;
      m.delete();
    } catch (e) {
      lastErr = e?.code || e?.message || String(e);
    }
  }
  const err = new Error(
    'This mesh is not a closed solid, so it cannot be split or jointed. ' +
    (lastErr ? `Manifold reports: ${lastErr}. ` : '') +
    'Repair it in your CAD tool or a mesh repair tool and re-import.');
  err.code = 'not_manifold';
  throw err;
}

/** Collapse the lazy CSG tree. Cheap to call, expensive to forget. */
export function forceEval(m) { m.volume(); return m; }

/** Batched union that never lets the deferred tree grow unbounded. */
export function unionAll(list, batch = 48) {
  const { Manifold } = ctx();
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  let acc = null;
  for (let i = 0; i < list.length; i += batch) {
    const chunk = list.slice(i, i + batch);
    const part = Manifold.union(acc ? [acc, ...chunk] : chunk);
    forceEval(part);
    acc = part;
  }
  return acc;
}

/** Batched difference, same reasoning. */
export function subtractAll(base, cutters, batch = 48) {
  const { Manifold } = ctx();
  let acc = base;
  for (let i = 0; i < cutters.length; i += batch) {
    acc = Manifold.difference([acc, ...cutters.slice(i, i + batch)]);
    forceEval(acc);
  }
  return acc;
}
