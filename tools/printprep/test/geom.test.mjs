import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weld } from '../src/geom/weld.js';
import { buildTopology } from '../src/geom/topology.js';
import { extractRegions, regionBoundary } from '../src/geom/regions.js';
import { extractFeatures } from '../src/geom/features.js';
import { BVH } from '../src/geom/bvh.js';
import { fitPrimitives } from '../src/geom/primfit.js';
import { boxSoup, plateWithHole } from './fixtures.mjs';

function analyse(soup) {
  const w = weld(soup);
  const topo = buildTopology(w.verts, w.tris);
  const m = { ...w, ...topo };
  const reg = extractRegions(m);
  const feat = extractFeatures(m, reg);
  const bvh = new BVH(w.verts, w.tris);
  const cyls = fitPrimitives(m, reg, bvh);
  return { m, reg, feat, bvh, cyls };
}

test('a box welds to 8 vertices and 12 triangles', () => {
  const w = weld(boxSoup(10, 10, 10));
  assert.equal(w.verts.length / 3, 8);
  assert.equal(w.tris.length / 3, 12);
  assert.equal(w.degenerate, 0);
});

test('a box is closed, consistently wound and manifold', () => {
  const w = weld(boxSoup());
  const t = buildTopology(w.verts, w.tris);
  assert.equal(t.boundaryEdges, 0);
  assert.equal(t.nonManifoldEdges, 0);
  assert.equal(t.flippedEdges, 0);
  assert.equal(t.edgeCount, 18);            // Euler: 8 - 18 + 12 = 2
});

test('a box has 6 planar regions and 12 convex 90 degree feature edges', () => {
  const { reg, feat } = analyse(boxSoup());
  assert.equal(reg.regions.length, 6);
  assert.equal(reg.shells.length, 6);
  assert.equal(feat.edges.length, 12);
  for (const e of feat.edges) {
    assert.ok(Math.abs(e.angle - 90) < 1e-3, `angle ${e.angle}`);
    assert.equal(e.convex, true, 'a box has no concave edges');
  }
});

test('each box region has one 4-vertex boundary loop', () => {
  const { m, reg } = analyse(boxSoup());
  for (const r of reg.regions) {
    const loops = regionBoundary(m, r, reg.triRegion);
    assert.equal(loops.length, 1);
    assert.equal(loops[0].length, 4);
  }
});

test('a plate with a hole yields one through cylinder of the right radius and axis', () => {
  const { cyls } = analyse(plateWithHole(40, 30, 8, 5, 64));
  assert.equal(cyls.length, 1, 'exactly one cylindrical shell');
  const c = cyls[0];
  assert.ok(Math.abs(c.radius - 5) < 0.05, `radius ${c.radius}`);
  assert.ok(Math.abs(Math.abs(c.axis[2]) - 1) < 1e-3, `axis ${c.axis}`);
  assert.equal(c.isHole, true);
  assert.equal(c.through, true);
  assert.ok(Math.abs(c.extent - 8) < 1e-3, `extent ${c.extent}`);
});

test('welding survives duplicated and jittered corners', () => {
  const soup = boxSoup();
  const jit = Float32Array.from(soup, (v) => v + (Math.random() - 0.5) * 1e-6);
  const w = weld(jit);
  assert.equal(w.verts.length / 3, 8);
});

test('the plate fixture is itself closed and consistently wound', () => {
  const w = weld(plateWithHole());
  const t = buildTopology(w.verts, w.tris);
  assert.equal(t.boundaryEdges, 0);
  assert.equal(t.nonManifoldEdges, 0);
  assert.equal(t.flippedEdges, 0);
});

test('the plate reads as 7 surfaces: top, bottom, 4 sides and one bore', () => {
  const { reg } = analyse(plateWithHole());
  assert.equal(reg.shells.length, 7);
  const faces = reg.regions.filter((r) => r.area > 100);
  assert.equal(faces.length, 6, 'top, bottom and four sides');
  const top = faces.find((r) => r.n[2] > 0.99);
  // 40 x 30 minus a 5 mm hole
  assert.ok(Math.abs(top.area - (40 * 30 - Math.PI * 25)) < 3, `top area ${top.area}`);
});

test('the bore is drawn as a smooth surface, not 64 facets', () => {
  const { feat, reg } = analyse(plateWithHole());
  // The only feature edges should be the silhouettes: the two hole rims, the
  // four vertical corners, and the top and bottom outlines. Nothing from the
  // 5.6 degree seams between bore facets.
  const shallow = feat.edges.filter((e) => e.angle < 20);
  assert.equal(shallow.length, 0, `${shallow.length} tessellation edges leaked into the overlay`);
  assert.ok(feat.edges.length < 300, `${feat.edges.length} feature edges is too many`);
  assert.ok(reg.shells.find((s) => s.kind === 'cylindrical' || s.triCount === 128));
});
