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
import { planSplit, manualTree } from '../plan/split.js';
import { placeJoints } from '../plan/jointSites.js';
import { protrusionBound, fitsWithJoints, fitPoints } from '../plan/fitTest.js';
import { buildNormalHist } from '../geom/normalHist.js';
import { rankOrientations } from '../plan/orient.js';
import { selectChains } from '../csg/chamfer.js';
import { convexHull } from '../geom/hull2d.js';

const parts = new Map();      // id -> analysed part
const staged = new Map();     // id -> raw soup, held only long enough to site joints

const TRI_LIMIT = 2_000_000;

/** Indexed mesh -> unindexed soup, the form every section routine wants. */
function soupFromIndexed(vertProperties, triVerts) {
  const soup = new Float32Array(triVerts.length * 3);
  for (let i = 0; i < triVerts.length; i++) {
    const v = triVerts[i] * 3;
    soup[i * 3] = vertProperties[v];
    soup[i * 3 + 1] = vertProperties[v + 1];
    soup[i * 3 + 2] = vertProperties[v + 2];
  }
  return soup;
}

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

  /**
   * Park a component's raw mesh for seam work.
   *
   * Joint siting needs sections through both sides of a seam, but nothing else
   * an analysis provides - no BVH, no regions, no feature edges. Those cost
   * real time per part and the geometry is about to change anyway when the
   * joints are stamped into it, so the full analysis waits until after
   * stamping and this holds just the soup.
   */
  async 'geom.stage'({ id, vertProperties, triVerts }) {
    staged.set(id, soupFromIndexed(vertProperties, triVerts));
    return { ok: true };
  },

  async 'geom.unstage'({ ids }) { for (const id of ids) staged.delete(id); return true; },

  /**
   * Site the joints on ONE seam, between two real post-cut components.
   *
   * This deliberately runs after the booleans rather than during the plan. The
   * planner works on pieces clipped out of a proxy: they are open where earlier
   * cuts passed, so sections through them do not close and the contact region
   * has to be reconstructed by masking the root against a list of halfspaces.
   * A component that came back from Manifold is a closed solid, so its sections
   * are simply true - what the section says is material IS material, including
   * everywhere a neighbouring cut took some away. That removes the guesswork
   * that used to leave outer seams unjointed.
   */
  async 'geom.seamJoints'({ aId, bId, plane, sMin, sMax, fit, nozzle, avoid }) {
    const soupA = staged.get(aId) || (parts.has(aId) ? soupOf(parts.get(aId).m) : null);
    const soupB = staged.get(bId) || (parts.has(bId) ? soupOf(parts.get(bId).m) : null);
    if (!soupA || !soupB) throw new Error('seam side not staged');
    const report = {};
    const p = placeJoints(soupA, soupB, plane, {
      nozzle: nozzle ?? 0.4, fit, sMax, sMin, avoid: avoid || [], report,
    });
    if (!p) return { placed: null, why: report.why || 'no joint fits this face' };
    return {
      placed: {
        S: p.S, T: p.T, sites: p.sites, frame: p.frame,
        areaMm2: p.areaMm2, lobeCount: p.lobeCount,
        hb: p.params.hb, depth: p.params.depth,
      },
    };
  },

  /** Register an already-analysed mesh (a part that came back from a boolean). */
  async 'geom.adopt'({ id, name, vertProperties, triVerts }, ctx) {
    const soup = soupFromIndexed(vertProperties, triVerts);
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

  /**
   * The whole split plan: beam search on a decimated proxy, then joint
   * placement on every plane. Returns pure data - planes with tree ids, and a
   * placement per plane - for the main thread to execute against the CSG
   * worker.
   */
  /**
   * Rotational symmetry about the Z axis: how many times the model repeats.
   *
   * The point of finding it is that a symmetric object should come apart into
   * repeats of ONE part, not into a bagful of one-offs. The planner cuts an
   * axis-aligned grid, and a grid can only ever be four-fold symmetric, so a
   * sixteen-spoke wheel cut on one comes out as sixteen different pieces -
   * measured on the EEDX wheel, 24 parts of 20 distinct shapes, 16 of them
   * one-offs. Cutting on the model's own symmetry instead makes them repeats.
   *
   * Detection is an area-weighted histogram of where material sits around the
   * axis, compared against itself rotated by one sector. That is cheap, needs
   * no correspondence between triangles, and degrades sensibly: a nearly
   * symmetric model scores nearly symmetric rather than passing or failing on
   * one stray vertex.
   */
  async 'geom.symmetry'({ id, tol = 0.06 }) {
    const e = parts.get(id);
    if (!e) throw new Error('unknown part');
    const soup = soupOf(e.m);
    const BINS = 1440;                       // a quarter-degree; divides by 16
    const hist = new Float64Array(BINS);

    // Area-weighted centroid in XY. On anything with a symmetry axis this IS
    // the axis, and taking it from the bounding box instead would put it off
    // centre the moment the model is not framed symmetrically.
    let cx = 0, cy = 0, wsum = 0;
    const tri = [];
    for (let i = 0; i < soup.length; i += 9) {
      const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
      const bx = soup[i + 3], by = soup[i + 4], bz = soup[i + 5];
      const gx = soup[i + 6], gy = soup[i + 7], gz = soup[i + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = gx - ax, vy = gy - ay, vz = gz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const area = 0.5 * Math.hypot(nx, ny, nz);
      if (!(area > 0)) continue;
      const mx = (ax + bx + gx) / 3, my = (ay + by + gy) / 3;
      cx += mx * area; cy += my * area; wsum += area;
      tri.push(mx, my, area);
    }
    if (!wsum) return { order: 1, why: 'no area' };
    cx /= wsum; cy /= wsum;

    let rMax = 0;
    for (let i = 0; i < tri.length; i += 3) {
      const dx = tri[i] - cx, dy = tri[i + 1] - cy;
      const r = Math.hypot(dx, dy);
      if (r > rMax) rMax = r;
      let b = Math.floor((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * BINS);
      if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
      hist[b] += tri[i + 2];
    }
    const total = hist.reduce((a, b) => a + b, 0) || 1;

    // How well does the model sit on top of itself after one sector's turn?
    const errAt = (shift) => {
      let err = 0;
      for (let i = 0; i < BINS; i++) err += Math.abs(hist[i] - hist[(i + shift) % BINS]);
      return err / total;
    };
    const scores = [];
    let order = 1;
    for (let N = 2; N <= 64; N++) {
      if (BINS % N) continue;               // only orders the bins can express
      const err = errAt(BINS / N);
      scores.push({ N, err: +err.toFixed(4) });
      if (err < tol) order = N;             // keep the largest that holds
    }

    // Where to put the cuts: the offset within one sector whose N rays cross
    // the least material. On a spoked wheel that is the gap between spokes,
    // which is where a cut belongs - through air rather than through a spoke.
    let phase = 0;
    if (order > 1) {
      const step = BINS / order;
      let best = Infinity;
      for (let o = 0; o < step; o++) {
        let m = 0;
        for (let k = 0; k < order; k++) m += hist[(o + k * step) % BINS];
        if (m < best) { best = m; phase = o; }
      }
    }
    return {
      order, centre: [cx, cy], rMax, phaseRad: -Math.PI + (phase + 0.5) * 2 * Math.PI / BINS,
      err: order > 1 ? +errAt(BINS / order).toFixed(4) : null,
      scores: scores.filter((s) => s.err < 0.25).slice(0, 12),
    };
  },

  async 'geom.plan'({ id, bed, sMax, fit, nozzle, manualPlanes }, ctx) {
    const e = parts.get(id);
    if (!e) throw new Error('unknown part');
    // The search runs on the full welded soup. The earlier proxy - a random
    // area-weighted triangle sample - was fine for extents and overhangs but
    // fatal for the objective: sections of a randomly-holed soup do not close,
    // their loop areas collapse, and every candidate plane gets rejected. The
    // planner's own passes are linear in triangle count, so up to the 2M-tri
    // import cap the full soup costs seconds, and it is CORRECT.
    const proxy = soupOf(e.m);
    ctx.progress('search', 0.1);

    // How much room to reserve for a joint boss standing proud of a cut face.
    //
    // A square joint of side S needs S/sqrt(2) + margin of clearance from the
    // face's edge in every direction, so a face only t thick can host one at
    // all when t >= 2*(sMin/sqrt(2) + margin) - about 20 mm for the 12 mm
    // minimum joint. Reserving the worst-case boss on a part thinner than that
    // is reserving room for something that can never be stamped: on the 10 mm
    // EEDX wheel it shrank every printable slab from 252 mm to 193 mm and asked
    // for a 5 x 5 grid where 4 x 4 does the job.
    const mSize = [0, 1, 2].map((i) => e.m.bbox.max[i] - e.m.bbox.min[i]);
    const jointMargin = Math.max(1.5, 2 * (nozzle ?? 0.4));
    const thinnest = Math.min(...mSize);
    const canJoint = thinnest >= 2 * (12 / Math.SQRT2 + jointMargin);
    const prot = canJoint ? protrusionBound(sMax ?? 25, fit) : 0;
    const analysis = { regions: e.reg.regions, totalArea: e.reg.regions.reduce((s, r) => s + r.area, 0) };

    let plan;
    if (manualPlanes && manualPlanes.length) {
      // The user placed the planes; build the same tree shape by applying each
      // plane to every piece it crosses, in order.
      plan = manualTree(proxy, manualPlanes);
    } else {
      plan = planSplit(proxy, analysis, { bed, protrusion: prot, sMax, budgetMs: 45000 });
    }
    ctx.progress('joints', 0.6);

    const placements = [];
    for (const pl of plan.planes) {
      const a = plan.all.get(pl.aId);
      const b = plan.all.get(pl.bId);
      if (!a || !b || pl.jointless) { placements.push(null); continue; }
      placements.push(placeJoints(a.soup, b.soup, pl, {
        nozzle: nozzle ?? 0.4, fit, sMax,
        rootSoup: proxy, hsA: a.halfspaces, hsB: b.halfspaces,
      }));
    }
    // The search judged bed fit against a worst-case joint protrusion. Now the
    // real placements are known: a seam that took no joint protrudes nothing,
    // and a seam that took an S = 15 joint protrudes that joint's boss, not a
    // hypothetical 25 mm one. Re-judge every final piece against what will
    // actually be stamped, so "does not fit" means exactly that.
    const keyOf = (n, d) => n.map((v) => v.toFixed(3)).join(',') + '|' + d.toFixed(2);
    const protByPlane = new Map();
    plan.planes.forEach((pl, i) => {
      protByPlane.set(keyOf(pl.n, pl.d), placements[i] ? placements[i].params.hb + 0.5 : 0);
    });
    let allFit = true;
    for (const piece of plan.pieces) {
      for (const f of piece.cutFaces) {
        if (!f.plane) continue;
        const pr = protByPlane.get(keyOf(f.plane.n, f.plane.d));
        if (pr !== undefined) { f.jointless = pr === 0; f.prot = pr; }
      }
      piece.fit = fitsWithJoints(fitPoints(piece.soup), piece.cutFaces, bed, prot, 2);
      if (!piece.fit) allFit = false;
    }
    const strip = (list) => list.map((p) => ({ n: p.n, d: p.d, parentId: p.parentId, aId: p.aId, bId: p.bId, jointless: !!p.jointless }));
    return {
      // The alternatives the search found, so the caller can offer a choice
      // rather than presenting one answer as though it were the only one.
      options: (plan.options || []).map((o) => ({
        label: o.label, pieces: o.pieces, distinct: o.distinct,
        simplicity: o.simplicity, strength: o.strength, planes: strip(o.planes),
      })),
      chosen: plan.chosen || null,
      planes: strip(plan.planes),
      placements: placements.map((p) => p && {
        S: p.S, T: p.T, sites: p.sites, frame: p.frame, areaMm2: p.areaMm2,
        hb: p.params.hb, depth: p.params.depth,
      }),
      log: plan.log,
      fits: allFit,
      pieceCount: plan.pieces.length,
    };
  },

  /** Orientation ranking for an analysed part. */
  async 'geom.orient'({ id, bed, jointAxes, cutNormals, joints }) {
    const e = parts.get(id);
    if (!e) throw new Error('unknown part');
    const hist = buildNormalHist(e.m.normal, e.m.area);
    const size = [0, 1, 2].map((i) => e.m.bbox.max[i] - e.m.bbox.min[i]);
    const totalArea = e.m.area.reduce((s, a) => s + a, 0);
    const ranked = rankOrientations({
      m: e.m, hist, size, totalArea,
      analysis: { regions: e.reg.regions, cylinders: e.cylinders },
      jointAxes: jointAxes || [], cutNormals: cutNormals || [], joints: joints || [],
    }, bed);
    return ranked.map((r) => ({
      up: r.up, why: r.why, score: r.exact,
      unsupportedMm2: Math.round(r.unsupportedMm2 * 10) / 10,
      worstDeg: Math.round(r.worstDeg * 10) / 10,
      contactMm2: Math.round(r.contactMm2), height: Math.round(r.height * 10) / 10,
      needsSupport: r.needsSupport,
    }));
  },

  /** Chamfer chain selection - the pure-geometry half of auto-chamfer. */
  async 'geom.chamferSelect'({ id, opts }) {
    const e = parts.get(id);
    if (!e) throw new Error('unknown part');
    const { chains, dropped } = selectChains(
      e.feat.chains, e.feat.edges, e.m.verts, e.m.tris, e.m.normal, e.reg.regions, opts || {});
    return {
      dropped,
      chains: chains.map((c) => ({ c: c.c, length: Math.round(c.length * 10) / 10, segments: c.segments })),
    };
  },

  /** Convex footprint of the part in a given orientation, for packing. */
  async 'geom.footprint'({ id, up }) {
    const e = parts.get(id);
    if (!e) throw new Error('unknown part');
    const ref = Math.abs(up[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = unit3(cross3(up, ref)), v = cross3(up, u);
    const { verts } = e.m;
    const pts = [];
    const stride = Math.max(1, Math.floor(verts.length / 3 / 800)) * 3;
    for (let i = 0; i < verts.length; i += stride) {
      pts.push([
        verts[i] * u[0] + verts[i + 1] * u[1] + verts[i + 2] * u[2],
        verts[i] * v[0] + verts[i + 1] * v[1] + verts[i + 2] * v[2],
      ]);
    }
    let minH = Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      const h = verts[i] * up[0] + verts[i + 1] * up[1] + verts[i + 2] * up[2];
      if (h < minH) minH = h;
    }
    return { hull: convexHull(pts), u, v, minH };
  },

  async 'geom.free'({ id }) { parts.delete(id); staged.delete(id); return true; },
  async 'geom.stats'() { return { parts: parts.size }; },
});

function soupOf(m) {
  const out = new Float32Array(m.tris.length * 3);
  for (let i = 0; i < m.tris.length; i++) {
    const v = m.tris[i] * 3;
    out[i * 3] = m.verts[v]; out[i * 3 + 1] = m.verts[v + 1]; out[i * 3 + 2] = m.verts[v + 2];
  }
  return out;
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

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
