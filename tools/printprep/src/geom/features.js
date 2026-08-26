/**
 * Feature edges: the lines that actually get drawn, and the candidates for
 * chamfering.
 *
 * An edge counts as a feature if it is a boundary, if its dihedral angle exceeds
 * the threshold, or if it separates two different planar regions. Everything
 * else is tessellation and is not drawn - that is the whole difference between a
 * model that reads as a solid and one that reads as a triangle mess.
 */
import { dihedralDeg, edgeIsConvex } from './topology.js';

/**
 * @returns {{
 *   segs: Float32Array,       // 6 floats per edge, ready for THREE.LineSegments
 *   edges: {t:number,k:number,va:number,vb:number,angle:number,convex:boolean|null,len:number}[],
 *   chains: {edges:number[], convex:boolean, angle:number, length:number}[]
 * }}
 */
export function extractFeatures(m, reg, opts = {}) {
  const featureDeg = opts.featureDeg ?? reg.featureDeg ?? 25;
  const { verts, tris, normal, triAdj } = m;
  const nTri = normal.length / 3;
  const edges = [];
  const seen = new Set();                       // one entry per undirected edge

  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const va = tris[t * 3 + k], vb = tris[t * 3 + (k + 1) % 3];
      const key = va < vb ? va * 4294967296 + vb : vb * 4294967296 + va;
      if (seen.has(key)) continue;
      const o = triAdj[t * 3 + k];
      let angle, convex = null;
      if (o < 0) {
        angle = 180;                            // a boundary edge is always drawn
      } else {
        angle = dihedralDeg(normal, triAdj, t, k);
        // A region boundary is only a feature if it also crosses a shell
        // boundary. Within one smooth shell, region boundaries are just the
        // facets of a tessellated curve - drawing those is exactly the
        // triangulated-mesh look this is here to avoid.
        const sameShell = reg.triShell[o] === reg.triShell[t];
        if (angle < featureDeg && sameShell) continue;
        convex = edgeIsConvex(verts, tris, normal, triAdj, t, k);
      }
      seen.add(key);
      const a = va * 3, b = vb * 3;
      edges.push({
        t, k, o, va, vb, angle, convex,
        len: Math.hypot(verts[b] - verts[a], verts[b + 1] - verts[a + 1], verts[b + 2] - verts[a + 2]),
        regA: reg.triRegion[t], regB: o < 0 ? -1 : reg.triRegion[o],
      });
    }
  }

  const segs = new Float32Array(edges.length * 6);
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i].va * 3, b = edges[i].vb * 3;
    segs[i * 6] = verts[a]; segs[i * 6 + 1] = verts[a + 1]; segs[i * 6 + 2] = verts[a + 2];
    segs[i * 6 + 3] = verts[b]; segs[i * 6 + 4] = verts[b + 1]; segs[i * 6 + 5] = verts[b + 2];
  }

  return { segs, edges, chains: chainEdges(edges) };
}

/**
 * Group feature edges into chains that follow one real feature.
 *
 * Two edges only join if they share a vertex, agree on convexity, have similar
 * dihedral angles, and separate the *same pair of regions*. That last condition
 * is what stops a chain running around a corner onto an unrelated edge, which
 * matters because the chamfer sizes itself once per chain.
 */
export function chainEdges(edges, opts = {}) {
  const angleTol = opts.angleTol ?? 8;          // degrees
  const byVert = new Map();
  edges.forEach((e, i) => {
    for (const v of [e.va, e.vb]) {
      let b = byVert.get(v);
      if (!b) byVert.set(v, (b = []));
      b.push(i);
    }
  });

  const pairKey = (e) => (e.regA < e.regB ? `${e.regA}:${e.regB}` : `${e.regB}:${e.regA}`);
  const used = new Uint8Array(edges.length);
  const chains = [];

  const stepFrom = (vert, fromIdx) => {
    const cands = byVert.get(vert) || [];
    const a = edges[fromIdx];
    let best = -1;
    for (const j of cands) {
      if (used[j] || j === fromIdx) continue;
      const b = edges[j];
      if (b.convex !== a.convex) continue;
      if (Math.abs(b.angle - a.angle) > angleTol) continue;
      if (pairKey(b) !== pairKey(a)) continue;
      if (best >= 0) return -1;                 // junction: stop, do not guess
      best = j;
    }
    return best;
  };

  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const chain = [i];
    for (const dir of [0, 1]) {
      let cur = i, vert = dir === 0 ? edges[i].vb : edges[i].va;
      for (;;) {
        const nxt = stepFrom(vert, cur);
        if (nxt < 0) break;
        used[nxt] = 1;
        if (dir === 0) chain.push(nxt); else chain.unshift(nxt);
        vert = edges[nxt].va === vert ? edges[nxt].vb : edges[nxt].va;
        cur = nxt;
      }
    }
    const e0 = edges[chain[0]];
    chains.push({
      edges: chain,
      convex: e0.convex,
      angle: chain.reduce((s, j) => s + edges[j].angle, 0) / chain.length,
      length: chain.reduce((s, j) => s + edges[j].len, 0),
      regA: e0.regA, regB: e0.regB,
    });
  }
  return chains;
}
