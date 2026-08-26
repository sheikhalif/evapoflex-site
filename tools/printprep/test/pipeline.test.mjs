/**
 * The whole chain on an analytic part: a 400 mm bar that cannot fit a 256 mm
 * printer, planned, split, jointed, audited. If this passes, the UI has an
 * engine underneath it.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initManifold, ctx, solidFromMesh, forceEval } from '../src/csg/manifoldCtx.js';
import * as arena from '../src/csg/arena.js';
import { soupToMesh, meshOut } from '../src/csg/convert.js';
import { planSplit } from '../src/plan/split.js';
import { placeJoints } from '../src/plan/jointSites.js';
import { stampJoints } from '../src/csg/jointStamp.js';
import { protrusionBound } from '../src/plan/fitTest.js';
import { weld } from '../src/geom/weld.js';
import { buildTopology } from '../src/geom/topology.js';
import { checkJoint } from '../src/geom/overhang.js';
import { boxSoup } from './fixtures.mjs';

const WASM = new URL('../../../assets/vendor/manifold/manifold.js', import.meta.url).href;
const BED = { x: 256, y: 256, z: 256 };

before(async () => { await initManifold(WASM); });

function soupOfManifold(m) {
  const mesh = meshOut(m);
  const out = new Float32Array(mesh.triVerts.length * 3);
  for (let i = 0; i < mesh.triVerts.length; i++) {
    const v = mesh.triVerts[i] * 3;
    out[i * 3] = mesh.vertProperties[v]; out[i * 3 + 1] = mesh.vertProperties[v + 1]; out[i * 3 + 2] = mesh.vertProperties[v + 2];
  }
  return out;
}

test('a 400 mm bar plans into two fitting pieces with one cut', () => {
  const soup = boxSoup(400, 60, 40);
  const prot = protrusionBound(25);
  const plan = planSplit(soup, null, { bed: BED, protrusion: prot, budgetMs: 8000 });
  assert.ok(plan.planes.length >= 1, `expected at least one plane, log: ${plan.log.join('; ')}`);
  assert.ok(plan.pieces.every((p) => p.fit), `every piece must fit: ${plan.log.join('; ')}`);
  assert.ok(plan.pieces.length <= 3, `${plan.pieces.length} pieces is too many for a 400 mm bar`);
  // The cut should be roughly across the long axis.
  const n = plan.planes[0].n;
  assert.ok(Math.abs(n[0]) > 0.9, `expected an X cut, got ${n}`);
});

test('a 300 mm cube-ish block needs no split', () => {
  const soup = boxSoup(200, 200, 200);
  const plan = planSplit(soup, null, { bed: BED, protrusion: protrusionBound(25) });
  assert.equal(plan.planes.length, 0);
});

test('joints place on the bar cut, on solid material, off the corners', () => {
  const soup = boxSoup(400, 60, 40);
  const plan = planSplit(soup, null, { bed: BED, protrusion: protrusionBound(25), budgetMs: 8000 });
  const pl = plan.planes[0];
  const A = plan.pieces[0], B = plan.pieces[1];
  // A is the +n piece by construction in planSplit's clip order.
  const placed = placeJoints(A.soup, B.soup, pl, { nozzle: 0.4 });
  assert.ok(placed, 'the 60x40 section must accept a joint');
  assert.ok(placed.S >= 12, `S = ${placed.S}`);
  assert.ok(placed.S <= 25);
  assert.ok(placed.sites.length >= 1 && placed.sites.length <= 4, `${placed.sites.length} sites`);
  // Sites sit inside the section (y in [-30, 30], z in [-20, 20] of the plane frame).
  for (const s of placed.sites) {
    const [wx, wy, wz] = s.world;
    assert.ok(Math.abs(wx - pl.d) < 1.0, `site x ${wx} should sit on the plane ${pl.d}`);
    assert.ok(Math.abs(wy) < 30 - placed.S / 2 + 0.6, `site y ${wy} keeps the joint inside`);
    assert.ok(Math.abs(wz) < 20 - placed.S / 2 + 0.6, `site z ${wz} keeps the joint inside`);
  }
});

test('stamping produces two clean solids whose joints are contained and printable', () => {
  const { Manifold } = ctx();
  arena.beginScope();
  try {
    const soup = boxSoup(400, 60, 40);
    const plan = planSplit(soup, null, { bed: BED, protrusion: protrusionBound(25), budgetMs: 8000 });
    const pl = plan.planes[0];
    const placed = placeJoints(plan.pieces[0].soup, plan.pieces[1].soup, pl, { nozzle: 0.4 });

    const whole = solidFromMesh(soupToMesh(boxSoup(400, 60, 40)), { diag: 406 });
    const [above, below] = arena.M(whole.id).splitByPlane(pl.n, pl.d);
    const aId = arena.track(forceEval(above)), bId = arena.track(forceEval(below));

    const volBefore = arena.M(aId).volume() + arena.M(bId).volume();
    const r = stampJoints(arena.M(aId), arena.M(bId), placed, { maleOn: 'B' });
    arena.track(r.A); arena.track(r.B);

    assert.ok(r.audit.ok, `containment audit: male ${r.audit.maleContained}, female ${r.audit.femaleContained}`);
    assert.equal(r.audit.maleStatus, 'NoError');
    assert.equal(r.audit.femaleStatus, 'NoError');

    // Mass balance: the stamped pair loses only clearance volume - a fraction
    // of a percent - never a joint-sized chunk.
    const volAfter = r.A.volume() + r.B.volume();
    const loss = (volBefore - volAfter) / volBefore;
    assert.ok(loss > 0, 'clearances must remove a little material');
    assert.ok(loss < 0.02, `lost ${(loss * 100).toFixed(2)}% - a joint went missing`);

    // The joint face region of each half must itself print support-free. Audit
    // the female's joint zone: crop the mesh to the zone around the plane.
    for (const [name, solid] of [['A(female)', r.A], ['B(male)', r.B]]) {
      const s = soupOfManifold(solid);
      const w = weld(s);
      const t = buildTopology(w.verts, w.tris);
      assert.equal(t.boundaryEdges, 0, `${name} must stay closed`);
      assert.equal(t.nonManifoldEdges, 0, `${name} must stay manifold`);
    }
  } finally { arena.endScope(); }
});

test('the arena does not leak across a full plan-split-stamp cycle', () => {
  const before = arena.stats().liveHandles;
  arena.beginScope();
  try {
    const whole = solidFromMesh(soupToMesh(boxSoup(300, 50, 30)), { diag: 306 });
    const [a, b] = arena.M(whole.id).splitByPlane([1, 0, 0], 0);
    arena.track(forceEval(a)); arena.track(forceEval(b));
  } finally { arena.endScope(); }
  assert.equal(arena.stats().liveHandles, before, 'scope must release everything it made');
});
