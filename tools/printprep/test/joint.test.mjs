/**
 * The joint port is held to equality with the Python original, not similarity.
 * Both drive the same manifold kernel through the same sequence of hulls and
 * booleans, so any real difference means the port has drifted.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initManifold } from '../src/csg/manifoldCtx.js';
import { makeJoint, params } from '../src/csg/joint.js';
import { weld } from '../src/geom/weld.js';
import { buildTopology } from '../src/geom/topology.js';
import { checkJoint } from '../src/geom/overhang.js';

const REF = JSON.parse(readFileSync(new URL('./reference/evf_joint.json', import.meta.url)));
const WASM = new URL('../../../assets/vendor/manifold/manifold.js', import.meta.url).href;

before(async () => { await initManifold(WASM); });

function soupOf(m) {
  const mesh = m.getMesh();
  const out = new Float32Array(mesh.triVerts.length * 3);
  for (let i = 0; i < mesh.triVerts.length; i++) {
    const v = mesh.triVerts[i] * mesh.numProp;
    out[i * 3] = mesh.vertProperties[v];
    out[i * 3 + 1] = mesh.vertProperties[v + 1];
    out[i * 3 + 2] = mesh.vertProperties[v + 2];
  }
  return out;
}

function audit(m) {
  const w = weld(soupOf(m));
  return checkJoint({ ...w, ...buildTopology(w.verts, w.tris) });
}

for (const S of Object.keys(REF)) {
  const size = Number(S);

  test(`joint ${S} mm: derived parameters match the Python`, () => {
    const p = params(size);
    for (const [k, v] of Object.entries(REF[S].params)) {
      assert.ok(Math.abs(p[k] - v) < 1e-5, `${k}: ${p[k]} vs ${v}`);
    }
  });

  test(`joint ${S} mm: both halves match the Python geometry`, () => {
    const { male, female } = makeJoint(size);
    try {
      for (const [name, m] of [['male', male], ['female', female]]) {
        const r = REF[S][name];
        const relV = Math.abs(m.volume() - r.volume) / r.volume;
        const relA = Math.abs(m.surfaceArea() - r.area) / r.area;
        assert.ok(relV < 1e-5, `${name} volume ${m.volume()} vs ${r.volume} (rel ${relV})`);
        assert.ok(relA < 1e-5, `${name} area ${m.surfaceArea()} vs ${r.area} (rel ${relA})`);
        const b = m.boundingBox();
        for (let i = 0; i < 3; i++) {
          assert.ok(Math.abs(b.min[i] - r.bmin[i]) < 1e-4, `${name} bmin[${i}] ${b.min[i]} vs ${r.bmin[i]}`);
          assert.ok(Math.abs(b.max[i] - r.bmax[i]) < 1e-4, `${name} bmax[${i}] ${b.max[i]} vs ${r.bmax[i]}`);
        }
        assert.equal(m.status(), 'NoError', `${name} is not a clean solid`);
        // The male is a ball; the female is a torus, because the boss cavity is
        // a through hole by default. That through hole is deliberate - roofing
        // it over at 45 degrees costs another 0.6 boss-widths of block - and it
        // doubles as a seating check you can see from the back.
        assert.equal(m.genus(), name === 'male' ? 0 : 1, `${name} genus`);
      }
    } finally { male.delete(); female.delete(); }
  });

  test(`joint ${S} mm: prints without support in all six directions`, () => {
    const { male, female } = makeJoint(size);
    try {
      for (const [name, m] of [['male', male], ['female', female]]) {
        const r = REF[S][name];
        const c = audit(m);
        assert.equal(c.unsupported_mm2, r.unsupported, `${name} unsupported area`);
        assert.equal(c.worst_overhang_deg, r.worst, `${name} worst overhang`);
        assert.ok(Math.abs(c.bridged_mm2 - r.bridged) < 0.01, `${name} bridged ${c.bridged_mm2} vs ${r.bridged}`);
        assert.ok(c.pass, `${name} should need no support anywhere`);
      }
    } finally { male.delete(); female.delete(); }
  });
}

test('the male protrudes above the mating plane and the female reaches below it', () => {
  // The fact the split planner has to respect: a cut piece's printed bounding
  // box is not its cut bounding box. The male's boss stands hb proud of the
  // mating plane, and the female reaches down into the male's waffle valleys,
  // stopping tol short of their floor.
  const p = params(20);
  const { male, female } = makeJoint(20);
  try {
    assert.ok(Math.abs(male.boundingBox().max[2] - p.hb) < 1e-4,
      `male should reach ${p.hb} above z=0, reaches ${male.boundingBox().max[2]}`);
    assert.ok(Math.abs(female.boundingBox().min[2] - (-p.depth + p.tol)) < 1e-4,
      `female should reach ${-p.depth + p.tol} below z=0, reaches ${female.boundingBox().min[2]}`);
  } finally { male.delete(); female.delete(); }
});

test('the fit stops move clearance, and the envelope follows the shaft fit', () => {
  const std = params(20, { tol: 0.15, bossFit: 0.10, shaftFit: 0.30 });
  const tight = params(20, { tol: 0.05, bossFit: 0.06, shaftFit: 0.20 });
  assert.equal(std.S, tight.S, 'the face size is set by the part, not the fit');
  assert.equal(std.pitch, tight.pitch);
  assert.equal(std.bb, tight.bb, 'the boss section is a load dimension');
  assert.equal(std.q, tight.q);
  assert.equal(std.i1, tight.i1, 'snap interference is strain limited, not fit driven');

  // But the ball seat sits on top of the shaft clearance, so a looser fit does
  // push the boss and the block a little taller. The planner must therefore read
  // hb and T from the joint it is actually going to stamp, not from a constant.
  assert.ok(tight.hb < std.hb, 'a tighter shaft fit gives a shorter boss');
  assert.ok(std.hb - tight.hb < 0.15, `the envelope shift stays small: ${std.hb - tight.hb}`);
  assert.ok(std.T >= tight.T);
});

test('a joint smaller than 12 mm has too few waffle teeth to trust', () => {
  // pitch clamps at 3 mm, so below S = 12 there are under four teeth per side
  // while the clearance stays at its absolute printer-driven value. The planner
  // refuses faces under this size rather than discovering it at stamp time.
  assert.equal(params(8).pitch, 3);
  assert.ok(8 / params(8).pitch < 4);
  assert.ok(12 / params(12).pitch >= 4);
});
