/**
 * Mesh analysis worker. No WASM here - just typed arrays - so several of these
 * can run at once and none of them ever waits behind a boolean.
 *
 * It owns, per part: the welded mesh, its topology, its regions and features,
 * and its BVH. Those stay resident for the session because picking, overhang
 * scoring and containment audits all query them repeatedly, and rebuilding a
 * BVH on every click is not affordable.
 */
import { serve } from './rpc.js';
import { parseSTL } from '../geom/stl.js';
import { weld } from '../geom/weld.js';
import { buildTopology } from '../geom/topology.js';
import { extractRegions, regionBoundary } from '../geom/regions.js';
import { extractFeatures } from '../geom/features.js';
import { fitPrimitives } from '../geom/primfit.js';
import { BVH } from '../geom/bvh.js';
import { overhangAudit } from '../geom/overhang.js';

const parts = new Map();      // id -> analysed part

const TRI_LIMIT = 2_000_000;

function analyse(soup, id, name, ctx) {
  ctx?.progress('weld', 0.1);
  const w = weld(soup);
  ctx?.progress('topology', 0.3);
  const topo = buildTopology(w.verts, w.tris);
  const m = { ...w, ...topo };
  ctx?.progress('surfaces', 0.5);
  const reg = extractRegions(m);
  ctx?.progress('edges', 0.7);
  const feat = extractFeatures(m, reg);
  ctx?.progress('index', 0.85);
  const bvh = new BVH(w.verts, w.tris);
  ctx?.progress('primitives', 0.95);
  const cylinders = fitPrimitives(m, reg, bvh);

  const entry = { id, name, m, reg, feat, bvh, cylinders };
  parts.set(id, entry);
  return entry;
}

/** Flat-shaded render mesh: one normal per triangle, so faces read as faces. */
function renderMesh(m) {
  const nTri = m.area.length;
  const pos = new Float32Array(nTri * 9);
  const nrm = new Float32Array(nTri * 9);
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = m.tris[t * 3 + k] * 3, o = t * 9 + k * 3;
      pos[o] = m.verts[v]; pos[o + 1] = m.verts[v + 1]; pos[o + 2] = m.verts[v + 2];
      nrm[o] = m.normal[t * 3]; nrm[o + 1] = m.normal[t * 3 + 1]; nrm[o + 2] = m.normal[t * 3 + 2];
    }
  }
  return { pos, nrm };
}

function summary(e) {
  const { m, reg, feat, cylinders } = e;
  const size = [0, 1, 2].map((i) => m.bbox.max[i] - m.bbox.min[i]);
  return {
    id: e.id, name: e.name,
    triCount: m.area.length, vertCount: m.verts.length / 3,
    bbox: m.bbox, size, diag: m.diag,
    surfaces: reg.shells.length,
    faces: reg.regions.filter((r) => r.area > 0.5).length,
    featureEdges: feat.edges.length,
    holes: cylinders.filter((c) => c.isHole).length,
    health: {
      boundaryEdges: m.boundaryEdges,
      nonManifoldEdges: m.nonManifoldEdges,
      flippedEdges: m.flippedEdges,
      degenerateDropped: m.degenerate,
      closed: m.boundaryEdges === 0 && m.nonManifoldEdges === 0 && m.flippedEdges === 0,
    },
  };
}

serve({
  /** Parse and analyse an STL. Returns everything the viewer needs to draw it. */
  async 'geom.load'({ buffer, id, name }, ctx) {
    ctx.progress('parse', 0.02);
    const { positions, triCount, name: stlName } = parseSTL(buffer);
    if (triCount === 0) { const e = new Error('That file contains no triangles.'); e.code = 'empty'; throw e; }
    if (triCount > TRI_LIMIT) {
      const e = new Error(
        `${triCount.toLocaleString()} triangles is past what this tool will analyse (${TRI_LIMIT.toLocaleString()}). ` +
        'Export the STL at a coarser tolerance - past a few hundred thousand triangles the extra ones are smaller ' +
        'than the nozzle anyway.');
      e.code = 'too_big';
      throw e;
    }
    const e = analyse(positions, id, name || stlName || 'model', ctx);
    const r = renderMesh(e.m);
    ctx.transfer([r.pos.buffer, r.nrm.buffer, e.feat.segs.buffer.slice(0)]);
    return {
      summary: summary(e),
      render: { pos: r.pos, nrm: r.nrm },
      edges: e.feat.segs,
      cylinders: e.cylinders.map((c) => ({
        axis: c.axis, radius: c.radius, center: c.center, extent: c.extent,
        isHole: c.isHole, through: c.through, shellId: c.id,
      })),
    };
  },

  /** Register an already-analysed mesh (a part that came back from a boolean). */
  async 'geom.adopt'({ id, name, vertProperties, triVerts }, ctx) {
    const soup = new Float32Array(triVerts.length * 3);
    for (let i = 0; i < triVerts.length; i++) {
      const v = triVerts[i] * 3;
      soup[i * 3] = vertProperties[v]; soup[i * 3 + 1] = vertProperties[v + 1]; soup[i * 3 + 2] = vertProperties[v + 2];
    }
    const e = analyse(soup, id, name, ctx);
    const r = renderMesh(e.m);
    ctx.transfer([r.pos.buffer, r.nrm.buffer, e.feat.segs.buffer.slice(0)]);
    return { summary: summary(e), render: { pos: r.pos, nrm: r.nrm }, edges: e.feat.segs };
  },

  /**
   * Raycast, resolved all the way to a semantic feature. The viewer gets back
   * a plane it can snap a split to, or a hole axis it can align an orientation
   * to - never a bare triangle index.
   */
  async 'geom.pick'({ id, origin, dir }) {
    const e = parts.get(id);
    if (!e) return null;
    const hit = e.bvh.raycast(origin, dir);
    if (!hit) return null;
    const shellId = e.reg.triShell[hit.tri];
    const shell = e.reg.shells[shellId];
    if (shell && (shell.kind === 'cylindrical' || shell.kind === 'round') && shell.axis) {
      return {
        kind: 'cylinder', point: hit.point, distance: hit.t, shellId,
        axis: shell.axis, radius: shell.radius, center: shell.center,
        extent: shell.extent, isHole: shell.isHole, through: !!shell.through,
      };
    }
    const region = e.reg.regions[e.reg.triRegion[hit.tri]];
    return {
      kind: 'plane', point: hit.point, distance: hit.t, shellId,
      regionId: region.id, n: region.n, d: region.d, area: region.area,
      centroid: region.centroid,
      loop: outlineOf(e, region),
    };
  },

  /** Overhang audit in one build direction. Used by the orientation panel. */
  async 'geom.overhang'({ id, dir, opts }) {
    const e = parts.get(id);
    if (!e) return null;
    const r = overhangAudit(e.m, dir, opts);
    return {
      unsupportedMm2: r.unsupportedMm2, bridgedMm2: r.bridgedMm2, worstDeg: r.worstDeg,
      patchCount: r.patches.length,
      tris: r.patches.filter((p) => !p.bridgeable).flatMap((p) => p.tris),
    };
  },

  async 'geom.free'({ id }) { parts.delete(id); return true; },
  async 'geom.stats'() { return { parts: parts.size }; },
});

/** Region boundary as a flat coordinate array, outer loop only. */
function outlineOf(e, region) {
  const loops = regionBoundary(e.m, region, e.reg.triRegion);
  if (!loops.length) return null;
  const loop = loops[0];
  const out = new Float32Array(loop.length * 3);
  for (let i = 0; i < loop.length; i++) {
    const v = loop[i] * 3;
    out[i * 3] = e.m.verts[v]; out[i * 3 + 1] = e.m.verts[v + 1]; out[i * 3 + 2] = e.m.verts[v + 2];
  }
  return out;
}
