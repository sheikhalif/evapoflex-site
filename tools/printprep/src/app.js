/**
 * The Print Prep application: orchestration and UI.
 *
 * Everything heavy happens in the two workers. This module owns the state, the
 * three.js stage, and the panels, and it moves typed arrays between the two.
 * The one structural rule it enforces: geometry analysis lives in the geom
 * worker, booleans live in the CSG worker, and this thread never blocks on
 * either.
 */
import * as THREE from 'three';
import { makeClient } from './workers/rpc.js';
import { PRINTERS, MATERIALS, QUALITIES, INFILL_PATTERNS, FIT_STOPS, DEFAULT_FIT, defaultProcess } from './core/presets.js';
import { createStage, buildBed, partColor, solidMaterial, edgeMaterial, ghostMaterial, jointMaterial, meshFromRender, meshFromIndexed, linesFromSegs, ACCENT } from './view/scene.js';
import { el, card, row, rowInfo, num, select, seg, checkbox, button, steppedSlider, toast, setProgress, download } from './ui/dom.js';
import { explodeVectors, explodeOffset } from './plan/explode.js';
import { autoArrange } from './plan/pack.js';
import { build3MF, orcaOverrides } from './csg/export3mf.js';
import { writeZip } from './csg/zip.js';
import { writeSTL } from './geom/stl.js';
import { frameMatrix } from './csg/jointStamp.js';

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export async function boot({ workerSources, baseUrl }) {
  // ---------------------------------------------------------------- workers
  const mkWorker = (src) => new Worker(
    URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  const geom = makeClient(mkWorker(workerSources.geom));
  const csg = makeClient(mkWorker(workerSources.csg));
  await csg.call('csg.init', { manifoldUrl: new URL('assets/vendor/manifold/manifold.js', baseUrl).href });

  // ---------------------------------------------------------------- state
  const state = {
    printerKey: 'elegoo-cc2',
    bed: { ...PRINTERS['elegoo-cc2'].bed },
    materialKey: 'PLA',
    proc: defaultProcess(),
    fitIdx: DEFAULT_FIT,
    sMax: 25,
    model: null,          // {geomId, csgId, name, summary, group}
    parts: [],            // see mkPart
    joints: [],           // {id, planeIdx, aPartId, bPartId, axis, S, hb, sites, frame, maleOn, swap}
    plan: null,           // last plan from geom.plan
    view: 'model',
    explodeT: 0,
    section: { on: false, axis: 'x', frac: 0.5 },
    selected: null,
    plates: [],
    seq: 1,
  };
  const fit = () => {
    const f = FIT_STOPS[state.fitIdx];
    return { tol: f.tol, bossFit: f.bossFit, shaftFit: f.shaftFit };
  };
  const printer = () => ({ ...PRINTERS[state.printerKey], bed: state.bed });
  const material = () => MATERIALS[state.materialKey];

  // ---------------------------------------------------------------- stage
  const stageEl = document.getElementById('stage');
  const stage = createStage(stageEl);
  buildBed(stage, state.bed, PRINTERS[state.printerKey].excludeArea);
  const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  const clipping = [];    // filled when section is on

  const say = (m, err) => toast(stageEl, m, err);

  // ---------------------------------------------------------------- panels
  const L = document.getElementById('pane-l');
  const R = document.getElementById('pane-r');
  buildLeftPanel();
  buildRightPanel();
  buildHud();
  buildDropZone();

  // ================================================================ import
  async function importSTL(file) {
    setProgress(0.05);
    try {
      const buffer = await file.arrayBuffer();
      clearAll();
      const id = `m${state.seq++}`;
      const r = await geom.call('geom.load', { buffer, id, name: file.name.replace(/\.stl$/i, '') }, {
        transfer: [buffer],
        onProgress: (p) => setProgress(0.05 + p.frac * 0.5),
      });
      // A solid in the CSG worker too - split and chamfer need it. Health
      // problems surface here, before the user has invested any planning.
      let csgId = null, csgError = null;
      try {
        const soup = renderToSoup(r.render);
        const s = await csg.call('csg.fromSoup', { positions: soup, diag: r.summary.diag }, { transfer: [soup.buffer] });
        csgId = s.solidId;
      } catch (e) { csgError = e.message; }

      const group = new THREE.Group();
      const mesh = meshFromRender(r.render, solidMaterial(0x8fa8bc, clipping));
      const edges = linesFromSegs(r.edges, edgeMaterial(clipping));
      group.add(mesh, edges);
      centreOnBed(group, r.summary.bbox);
      state.modelOffset = group.position.clone();
      stage.world.add(group);

      state.model = { geomId: id, csgId, csgError, name: r.summary.name || file.name, summary: r.summary, group, mesh, edges };
      stage.frameObject(shiftedBbox(r.summary.bbox, group.position));
      refreshModelCard();
      refreshActions();
      setProgress(1);
      const h = r.summary.health;
      if (!h.closed) {
        say(`Loaded with problems: ${h.boundaryEdges} open edges, ${h.nonManifoldEdges} non-manifold, ${h.flippedEdges} flipped. Splitting may refuse.`, true, 7000);
      } else {
        say(`${r.summary.name || file.name} - ${r.summary.triCount.toLocaleString()} triangles, ${fmtSize(r.summary.size)} mm`);
      }
    } catch (e) {
      setProgress(0);
      say(e.message, true);
    }
  }

  function renderToSoup(render) { return render.pos.slice(); }

  function centreOnBed(group, bbox) {
    // Model coordinates are arbitrary; the stage puts the part centred on the
    // plate, sitting on it.
    group.position.set(
      state.bed.x / 2 - (bbox.min[0] + bbox.max[0]) / 2,
      state.bed.y / 2 - (bbox.min[1] + bbox.max[1]) / 2,
      -bbox.min[2]);
  }
  const shiftedBbox = (b, p) => ({
    min: [b.min[0] + p.x, b.min[1] + p.y, b.min[2] + p.z],
    max: [b.max[0] + p.x, b.max[1] + p.y, b.max[2] + p.z],
  });

  function clearAll() {
    for (const p of state.parts) disposeGroup(p.group);
    if (state.model) disposeGroup(state.model.group);
    stage.world.clear();
    if (state.model?.csgId) csg.call('csg.release', { solidIds: [state.model.csgId] });
    csg.call('csg.release', { solidIds: state.parts.map((p) => p.csgId).filter(Boolean) });
    state.model = null; state.parts = []; state.joints = []; state.plan = null;
    state.plates = []; state.selected = null; state.view = 'model';
    refreshParts(); refreshModelCard(); refreshActions(); refreshSelected();
  }
  function disposeGroup(g) {
    g?.traverse((o) => { o.geometry?.dispose(); if (o.material?.dispose) o.material.dispose(); });
  }

  // ================================================================ split
  async function autoSplit(manualPlanes = null) {
    const m = state.model;
    if (!m) return;
    if (!m.csgId) { say(`Cannot split: ${m.csgError}`, true, 7000); return; }
    setProgress(0.05);
    try {
      const plan = await geom.call('geom.plan', {
        id: m.geomId, bed: state.bed, sMax: state.sMax, fit: fit(),
        nozzle: printer().nozzle, manualPlanes,
      }, { onProgress: (p) => setProgress(0.05 + p.frac * 0.3) });
      state.plan = { ...plan, manualPlanes };

      if (!plan.planes.length) {
        say('It already fits the printer - nothing to split.');
        setProgress(1);
        return;
      }
      if (!plan.fits) say(`Warning: ${plan.log.join(' / ')}`, true, 6000);
      await executePlan(plan);
      setProgress(1);
      say(`${state.parts.length} parts, ${state.joints.length} joint face${state.joints.length === 1 ? '' : 's'}. Check them in Ghost view.`);
    } catch (e) {
      setProgress(0);
      say(e.message, true, 7000);
    }
  }

  async function executePlan(plan) {
    const m = state.model;
    // Work on a copy so the original solid survives for a re-plan.
    const rootCopy = await csg.call('csg.transform', { solidId: m.csgId, matrix: IDENT16 });
    const idMap = new Map([[0, rootCopy.solidId]]);
    const parents = new Set(plan.planes.map((p) => p.parentId));

    setProgress(0.4);
    for (let i = 0; i < plan.planes.length; i++) {
      const pl = plan.planes[i];
      const r = await csg.call('csg.splitOne', { solidId: idMap.get(pl.parentId), plane: pl });
      if (r.aId == null) throw new Error('a planned cut missed the model - re-run Auto Split');
      idMap.set(pl.aId, r.aId);
      idMap.set(pl.bId, r.bId);
      setProgress(0.4 + 0.15 * (i + 1) / plan.planes.length);
    }

    // Stamp joints across every plane, between the leaf descendants that
    // actually contain the sites.
    const planeByParent = new Map(plan.planes.map((p) => [p.parentId, p]));
    const descend = (planId, pt) => {
      let cur = planId;
      for (;;) {
        const p = planeByParent.get(cur);
        if (!p) return cur;
        cur = (pt[0] * p.n[0] + pt[1] * p.n[1] + pt[2] * p.n[2] - p.d) >= 0 ? p.aId : p.bId;
      }
    };

    state.joints = [];
    for (let i = 0; i < plan.planes.length; i++) {
      const pl = plan.planes[i], placed = plan.placements[i];
      if (!placed) continue;
      const centroid = avg(placed.sites.map((s) => s.world));
      const aLeaf = descend(pl.aId, centroid);
      const bLeaf = descend(pl.bId, centroid);
      const maleOn = state.plan?.swaps?.[i] ? 'A' : 'B';
      const r = await csg.call('csg.stamp', {
        aId: idMap.get(aLeaf), bId: idMap.get(bLeaf),
        placement: placed, fit: fit(), maleOn,
      });
      if (!r.audit.ok) say(`Joint ${i + 1}: containment audit failed (${(r.audit.maleContained * 100).toFixed(1)}% / ${(r.audit.femaleContained * 100).toFixed(1)}%)`, true, 8000);
      idMap.set(aLeaf, r.aId);
      idMap.set(bLeaf, r.bId);
      state.joints.push({
        id: `j${i}`, planeIdx: i, aLeaf, bLeaf,
        axis: r.meta.axis, S: placed.S, hb: r.meta.hb ?? placed.hb, depth: placed.depth,
        sites: placed.sites, frame: placed.frame, maleOn, audit: r.audit,
      });
      setProgress(0.55 + 0.15 * (i + 1) / plan.planes.length);
    }

    // Materialise the leaves as parts.
    const leafIds = [...idMap.keys()].filter((k) => !parents.has(k) || !plan.planes.some((p) => p.parentId === k));
    const leaves = [...new Set(plan.planes.flatMap((p) => [p.aId, p.bId]))].filter((id) => !parents.has(id));
    if (state.model) state.model.group.visible = false;
    state.parts = [];
    let pi = 0;
    for (const leaf of leaves) {
      const csgId = idMap.get(leaf);
      const mesh = await csg.call('csg.mesh', { solidId: csgId });
      const gid = `p${state.seq++}`;
      const adopted = await geom.call('geom.adopt', {
        id: gid, name: `Part ${pi + 1}`,
        vertProperties: mesh.vertProperties, triVerts: mesh.triVerts,
      });
      const part = mkPart(gid, csgId, `Part ${pi + 1}`, adopted, pi);
      part.planLeaf = leaf;
      state.parts.push(part);
      stage.world.add(part.group);
      pi++;
      setProgress(0.7 + 0.25 * pi / leaves.length);
    }

    // Joint <-> part links, then joint preview solids for the ghost/exploded views.
    for (const j of state.joints) {
      j.aPartId = state.parts.find((p) => p.planLeaf === j.aLeaf)?.id;
      j.bPartId = state.parts.find((p) => p.planLeaf === j.bLeaf)?.id;
    }
    await buildJointPreviews();
    await orientAll();
    layoutPartsOnBed();
    refreshParts(); refreshActions();
    setView('model');
  }

  function mkPart(gid, csgId, name, adopted, index) {
    const color = partColor(index);
    const group = new THREE.Group();
    const mesh = meshFromRender(adopted.render, solidMaterial(color, clipping));
    const edges = linesFromSegs(adopted.edges, edgeMaterial(clipping));
    const ghost = meshFromRender(adopted.render, ghostMaterial(color, clipping));
    ghost.visible = false;
    ghost.renderOrder = 2;
    group.add(mesh, edges, ghost);
    return {
      id: gid, csgId, name, color, index,
      summary: adopted.summary, group, mesh, edges, ghost,
      volume: 0, orientation: null, orientCands: [],
      proc: null,        // per-part overrides; null = inherit globals
      home: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
    };
  }

  async function buildJointPreviews() {
    for (const j of state.joints) {
      const prev = await csg.call('csg.jointPreview', { S: j.S, fit: fit() });
      const flip = j.maleOn === 'A';
      const nDir = flip ? j.frame.n.map((v) => -v) : j.frame.n.slice();
      const wF = cross(nDir, j.frame.u), uF = cross(wF, nDir);
      j.siteMeshes = [];
      for (const s of j.sites) {
        const M = new THREE.Matrix4().fromArray(frameMatrix(unit(uF), unit(wF), unit(nDir), s.world));
        const malePart = state.parts.find((p) => p.id === (j.maleOn === 'A' ? j.aPartId : j.bPartId));
        const femalePart = state.parts.find((p) => p.id === (j.maleOn === 'A' ? j.bPartId : j.aPartId));
        const mm = meshFromIndexed(prev.male, jointMaterial(true));
        const fm = meshFromIndexed(prev.female, jointMaterial(false));
        mm.applyMatrix4(M); fm.applyMatrix4(M);
        mm.visible = fm.visible = false;
        mm.renderOrder = 1; fm.renderOrder = 1;
        malePart?.group.add(mm);
        femalePart?.group.add(fm);
        j.siteMeshes.push({ male: mm, female: fm });
      }
    }
  }

  // ================================================================ orientation
  async function orientAll() {
    for (const part of state.parts) {
      const jointAxes = state.joints
        .filter((j) => j.aPartId === part.id || j.bPartId === part.id)
        .map((j) => j.axis);
      const cutNormals = jointAxes.slice();
      const joints = state.joints
        .filter((j) => j.aPartId === part.id || j.bPartId === part.id)
        .flatMap((j) => j.sites.map((s) => ({ center: s.world, S: j.S })));
      try {
        part.orientCands = await geom.call('geom.orient', {
          id: part.id, bed: state.bed, jointAxes, cutNormals, joints,
        });
        part.orientation = part.orientCands[0] || null;
      } catch { part.orientCands = []; }
    }
  }

  /**
   * Rest pose: the parts ASSEMBLED, exactly where they were cut from the model,
   * at the model's own spot on the bed. Model and Ghost views show the thing
   * put together - that is what makes the joints inspectable - and Explode
   * pulls apart from here along the mating axes. Chosen print orientations
   * apply on the plates, not in this view.
   */
  function layoutPartsOnBed() {
    const off = state.modelOffset || new THREE.Vector3();
    for (const part of state.parts) {
      part.group.quaternion.identity();
      part.group.position.copy(off);
      part.home.pos.copy(part.group.position);
      part.home.quat.copy(part.group.quaternion);
    }
  }

  // ================================================================ chamfer
  async function autoChamfer() {
    const targets = state.parts.length
      ? state.parts.map((p) => ({ gid: p.id, csgId: p.csgId, part: p }))
      : state.model?.csgId ? [{ gid: state.model.geomId, csgId: state.model.csgId, part: null }] : [];
    if (!targets.length) return;
    setProgress(0.05);
    try {
      let total = 0, done = 0;
      for (const t of targets) {
        const sel = await geom.call('geom.chamferSelect', { id: t.gid, opts: {} });
        // Keep the cutters away from every joint: the waffle teeth are all 45
        // and 90 degree geometry and must not be "improved".
        const joints = state.joints.filter((j) =>
          j.aPartId === t.gid || j.bPartId === t.gid ||
          (t.part && (j.aPartId === t.part.id || j.bPartId === t.part.id)));
        const chains = sel.chains.filter((ch) => !nearAnyJoint(ch, joints));
        if (!chains.length) { done++; continue; }
        const r = await csg.call('csg.chamfer', { solidId: t.csgId, chains }, {
          onProgress: (p) => setProgress(0.1 + (done + p.frac) / targets.length * 0.7),
        });
        total += r.cutterCount;
        // The solid changed identity; refresh the handle and the meshes.
        if (t.part) {
          t.part.csgId = r.solidId;
          await refreshPartMesh(t.part);
        } else {
          state.model.csgId = r.solidId;
          const mesh = await csg.call('csg.mesh', { solidId: r.solidId });
          const gid = `m${state.seq++}`;
          const adopted = await geom.call('geom.adopt', { id: gid, name: state.model.name, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts });
          replaceModelRender(gid, adopted);
        }
        done++;
      }
      setProgress(1);
      say(total ? `Chamfered ${total} edge${total === 1 ? '' : 's'}.` : 'Nothing worth chamfering - no clean convex right angles found.');
    } catch (e) { setProgress(0); say(e.message, true, 6000); }
  }

  function nearAnyJoint(chain, joints) {
    if (!joints.length) return false;
    for (const seg of chain.segments) {
      for (const j of joints) for (const s of j.sites) {
        const d = Math.hypot(seg.p0[0] - s.world[0], seg.p0[1] - s.world[1], seg.p0[2] - s.world[2]);
        if (d < j.S * 1.2) return true;
      }
    }
    return false;
  }

  async function refreshPartMesh(part) {
    const mesh = await csg.call('csg.mesh', { solidId: part.csgId });
    const gid = `p${state.seq++}`;
    const adopted = await geom.call('geom.adopt', { id: gid, name: part.name, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts });
    geom.call('geom.free', { id: part.id });
    part.id = gid;
    part.summary = adopted.summary;
    part.mesh.geometry.dispose();
    part.mesh.geometry = meshFromRender(adopted.render, part.mesh.material).geometry;
    part.ghost.geometry.dispose();
    part.ghost.geometry = part.mesh.geometry;
    part.edges.geometry.dispose();
    part.edges.geometry = linesFromSegs(adopted.edges, part.edges.material).geometry;
  }

  function replaceModelRender(gid, adopted) {
    const m = state.model;
    geom.call('geom.free', { id: m.geomId });
    m.geomId = gid;
    m.summary = adopted.summary;
    m.mesh.geometry.dispose();
    m.mesh.geometry = meshFromRender(adopted.render, m.mesh.material).geometry;
    m.edges.geometry.dispose();
    m.edges.geometry = linesFromSegs(adopted.edges, m.edges.material).geometry;
  }

  // ================================================================ arrange
  async function arrange() {
    if (!state.parts.length) { say('Split first - arranging needs parts.'); return; }
    setProgress(0.2);
    try {
      const items = [];
      for (const part of state.parts) {
        const up = part.orientation?.up || [0, 0, 1];
        const fp = await geom.call('geom.footprint', { id: part.id, up });
        part.plateFrame = fp;    // {hull, u, v, minH}
        items.push({ id: part.id, footprint: fp.hull, settingsKey: settingsKeyOf(part) });
      }
      const excl = PRINTERS[state.printerKey].excludeArea;
      const r = autoArrange(items, { x: state.bed.x, y: state.bed.y }, { gap: 4, exclude: excl?.length ? excl : null });
      state.plates = r.plates;
      let tooBig = 0;
      for (const pl of state.plates) tooBig += pl.placements.filter((p) => p.tooBig).length;
      setProgress(1);
      setView('plates');
      say(`${state.plates.length} plate${state.plates.length === 1 ? '' : 's'}${tooBig ? ` - ${tooBig} part(s) do not fit and are marked red` : ''}.`);
      refreshExport();
    } catch (e) { setProgress(0); say(e.message, true); }
  }

  function settingsKeyOf(part) {
    const p = effectiveProc(part);
    return `${p.material}|${p.layerHeight}|${p.nozzleC}|${p.bedC}`;
  }
  function effectiveProc(part) {
    return { ...state.proc, material: state.materialKey, nozzleC: material().nozzleC, bedC: material().bedC, ...(part.proc || {}) };
  }

  /** Part-local -> plate transform for a placement, as a THREE.Matrix4. */
  function plateMatrix(part, placement) {
    const fp = part.plateFrame;
    const up = part.orientation?.up || [0, 0, 1];
    // Rows u, v, up: maps part space into the footprint frame.
    const F = new THREE.Matrix4().makeBasis(V3(fp.u), V3(fp.v), V3(up)).transpose();
    const yaw = new THREE.Matrix4().makeRotationZ(placement.rot);
    const T = new THREE.Matrix4().makeTranslation(placement.x, placement.y, -fp.minH);
    // T translates in plate space after yaw; -minH sits the part on z=0.
    const M = new THREE.Matrix4().multiplyMatrices(yaw, F);
    M.premultiply(new THREE.Matrix4().makeTranslation(placement.x, placement.y, 0));
    M.multiply(new THREE.Matrix4()); // no-op, clarity
    // z: after F, the part's lowest point is at minH; lift to 0.
    const Mz = new THREE.Matrix4().makeTranslation(0, 0, -fp.minH);
    return new THREE.Matrix4().multiplyMatrices(
      new THREE.Matrix4().makeTranslation(placement.x, placement.y, 0),
      new THREE.Matrix4().multiplyMatrices(yaw, new THREE.Matrix4().multiplyMatrices(Mz, F)));
  }

  // ================================================================ views
  function setView(mode) {
    state.view = mode;
    viewSeg.set(mode);
    const ghostOn = mode === 'ghost';
    const platesOn = mode === 'plates';

    if (state.model) state.model.group.visible = !state.parts.length && !platesOn;

    for (const part of state.parts) {
      part.mesh.visible = !ghostOn;
      part.edges.visible = !ghostOn && !platesOn;
      part.ghost.visible = ghostOn;
    }
    for (const j of state.joints) {
      for (const sm of j.siteMeshes || []) {
        sm.male.visible = ghostOn || mode === 'explode';
        sm.female.visible = ghostOn || mode === 'explode';
      }
    }
    explodeRow.style.display = mode === 'explode' ? '' : 'none';

    if (platesOn) applyPlateLayout();
    else restoreHomeLayout();
    if (mode === 'explode') animateExplode();
  }

  function applyPlateLayout() {
    if (!state.plates.length) { say('Run Auto-Arrange first.'); return; }
    // Plates side by side with a gutter.
    let ox = 0;
    state.plateOffsets = [];
    for (let i = 0; i < state.plates.length; i++) {
      state.plateOffsets.push(ox);
      ox += state.bed.x + 40;
    }
    state.plates.forEach((plate, pi) => {
      for (const pl of plate.placements) {
        const part = state.parts.find((p) => p.id === pl.id);
        if (!part) continue;
        const M = plateMatrix(part, pl);
        M.premultiply(new THREE.Matrix4().makeTranslation(state.plateOffsets[pi], 0, 0));
        part.group.matrixAutoUpdate = false;
        part.group.matrix.copy(M);
        if (pl.tooBig) part.mesh.material.color.set(0xb5432d);
      }
    });
  }

  function restoreHomeLayout() {
    for (const part of state.parts) {
      part.group.matrixAutoUpdate = true;
      part.group.position.copy(part.home.pos);
      part.group.quaternion.copy(part.home.quat);
      part.mesh.material.color.set(part.color);
    }
  }

  // Explode animation: drive T from the slider; offsets along mating axes.
  var explodeMap = null;
  function animateExplode() {
    const partsInfo = state.parts.map((p) => ({
      id: p.id, volume: p.summary?.bbox ? boxVol(p.summary.bbox) : 1,
      size: p.summary ? p.summary.size : [50, 50, 50],
    }));
    const jointsInfo = state.joints
      .filter((j) => j.aPartId && j.bPartId)
      .map((j) => ({ aId: j.aPartId, bId: j.bPartId, axis: j.axis, hb: j.hb }));
    explodeMap = explodeVectors(partsInfo, jointsInfo);
    applyExplode();
  }
  function applyExplode() {
    if (!explodeMap) return;
    const maxDepth = Math.max(1, ...[...explodeMap.values()].map((e) => e.depth));
    for (const part of state.parts) {
      const e = explodeMap.get(part.id);
      if (!e) continue;
      const off = explodeOffset(e, state.explodeT, maxDepth);
      part.group.position.set(part.home.pos.x + off[0], part.home.pos.y + off[1], part.home.pos.z + off[2]);
    }
  }

  // ================================================================ section
  function applySection() {
    clipping.length = 0;
    if (state.section.on) {
      const n = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[state.section.axis];
      const bb = worldBbox();
      const axis = { x: 0, y: 1, z: 2 }[state.section.axis];
      const lo = bb.min[axis], hi = bb.max[axis];
      const d = lo + (hi - lo) * state.section.frac;
      clipPlane.normal.set(n[0], n[1], n[2]);
      clipPlane.constant = d;
      clipping.push(clipPlane);
    }
    // Materials share the `clipping` array by reference; flag them dirty.
    for (const part of state.parts) {
      part.mesh.material.needsUpdate = true;
      part.ghost.material.needsUpdate = true;
    }
    if (state.model) state.model.mesh.material.needsUpdate = true;
  }
  function worldBbox() {
    const box = new THREE.Box3();
    for (const part of state.parts) box.expandByObject(part.group);
    if (state.model?.group.visible) box.expandByObject(state.model.group);
    if (box.isEmpty()) return { min: [0, 0, 0], max: [state.bed.x, state.bed.y, state.bed.z] };
    return { min: box.min.toArray(), max: box.max.toArray() };
  }

  // ================================================================ export
  async function doExport(selection) {
    if (!state.plates.length) { say('Run Auto-Arrange first.'); return; }
    setProgress(0.1);
    try {
      const files = [];
      const meshCache = new Map();
      const getMesh = async (part) => {
        if (!meshCache.has(part.id)) meshCache.set(part.id, await csg.call('csg.mesh', { solidId: part.csgId }));
        return meshCache.get(part.id);
      };

      for (let pi = 0; pi < state.plates.length; pi++) {
        const plate = state.plates[pi];
        const placed = plate.placements.filter((p) => !p.tooBig);
        const objects = [];
        for (let oi = 0; oi < placed.length; oi++) {
          const part = state.parts.find((p) => p.id === placed[oi].id);
          const mesh = await getMesh(part);
          const M = plateMatrix(part, placed[oi]);
          objects.push({
            id: oi + 1, name: part.name, mesh, part, placement: placed[oi],
            matrix12: mat12Of(M),
            overrides: orcaOverrides(effectiveProc(part), effectiveProc({ proc: null })),
          });
        }

        if (selection.plate3mf) {
          const data = await build3MF(objects, printer(), material(), state.proc, { writeZip });
          files.push({ name: `plate_${pi + 1}.3mf`, data });
        }
        if (selection.plateStl) {
          files.push({ name: `plate_${pi + 1}.stl`, data: new Uint8Array(mergedSTL(objects)) });
        }
        setProgress(0.1 + 0.7 * (pi + 1) / state.plates.length);
      }
      if (selection.partStls) {
        for (const part of state.parts) {
          const mesh = await getMesh(part);
          files.push({ name: `${safe(part.name)}.stl`, data: new Uint8Array(writeSTL(mesh.vertProperties, mesh.triVerts, { name: part.name })) });
        }
      }

      if (!files.length) { say('Nothing ticked - nothing exported.'); setProgress(0); return; }
      if (selection.zip || files.length > 3) {
        const zip = await writeZip(files.map((f) => ({ name: f.name, data: f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data) })));
        download(`${safe(state.model?.name || 'printprep')}_plates.zip`, zip, 'application/zip');
      } else {
        for (const f of files) {
          download(f.name, f.data, f.name.endsWith('.3mf') ? 'model/3mf' : 'model/stl');
        }
      }
      setProgress(1);
      say(`Exported ${files.length} file${files.length === 1 ? '' : 's'}. The 3MF opens straight in ElegooSlicer or OrcaSlicer; slice there for G-code.`);
    } catch (e) { setProgress(0); say(e.message, true, 7000); }
  }

  function mergedSTL(objects) {
    let nTri = 0;
    for (const o of objects) nTri += o.mesh.triVerts.length / 3;
    const soup = new Float32Array(nTri * 9);
    let w = 0;
    const v = new THREE.Vector3();
    for (const o of objects) {
      const M = new THREE.Matrix4().fromArray(mat16Of(o.matrix12));
      const { vertProperties: V, triVerts: T } = o.mesh;
      for (let i = 0; i < T.length; i++) {
        const k = T[i] * 3;
        v.set(V[k], V[k + 1], V[k + 2]).applyMatrix4(M);
        soup[w++] = v.x; soup[w++] = v.y; soup[w++] = v.z;
      }
    }
    const idx = new Uint32Array(soup.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    return writeSTL(soup, idx, { name: 'plate' });
  }

  const mat12Of = (M) => {
    const e = M.elements;   // column-major 4x4
    return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]];
  };
  const mat16Of = (m12) => [
    m12[0], m12[1], m12[2], 0, m12[3], m12[4], m12[5], 0,
    m12[6], m12[7], m12[8], 0, m12[9], m12[10], m12[11], 1];

  async function exportCoupon() {
    setProgress(0.2);
    try {
      const files = [];
      for (const stop of ['tight', 'standard', 'loose']) {
        const f = FIT_STOPS.find((s) => s.key === stop);
        const prev = await csg.call('csg.jointPreview', { S: 16, fit: { tol: f.tol, bossFit: f.bossFit, shaftFit: f.shaftFit } });
        for (const [half, mesh] of [['male', prev.male], ['female', prev.female]]) {
          files.push({
            name: `coupon_S16_${stop}_${half}.stl`,
            data: new Uint8Array(writeSTL(mesh.vertProperties, mesh.triVerts, { name: `coupon ${stop} ${half}` })),
          });
        }
      }
      const zip = await writeZip(files);
      download('evf_joint_coupons.zip', zip, 'application/zip');
      setProgress(1);
      say('Six coupons: male + female at Tight, Standard and Loose, all S = 16. Print one pair per material, keep the stop that snaps clean.');
    } catch (e) { setProgress(0); say(e.message, true); }
  }

  const safe = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60);

  // ================================================================ UI: left
  var actionsCard, modelCard, fitSliderCtl;
  function buildLeftPanel() {
    // Import
    const fileInput = el('input', { type: 'file', accept: '.stl', style: 'display:none' });
    fileInput.addEventListener('change', () => fileInput.files[0] && importSTL(fileInput.files[0]));
    L.append(el('div', { class: 'card' },
      el('div', { class: 'card-t' }, 'Model'),
      el('div', { class: 'btnrow' },
        button('Import STL', () => fileInput.click()),
        button('Clear', () => clearAll(), 'g sm')),
      fileInput,
      (modelCard = el('div', { class: 'empty' }, 'Drop an STL anywhere, or import one.')),
    ));

    // Printer
    const bedX = num(state.bed.x, { min: 50, max: 1000, unit: 'mm', onchange: (v) => setBed('x', v) });
    const bedY = num(state.bed.y, { min: 50, max: 1000, unit: 'mm', onchange: (v) => setBed('y', v) });
    const bedZ = num(state.bed.z, { min: 50, max: 1000, unit: 'mm', onchange: (v) => setBed('z', v) });
    const printerSel = select(
      Object.entries(PRINTERS).map(([value, p]) => ({ value, label: p.name })),
      state.printerKey,
      (v) => {
        state.printerKey = v;
        Object.assign(state.bed, PRINTERS[v].bed);
        bedX.input.value = state.bed.x; bedY.input.value = state.bed.y; bedZ.input.value = state.bed.z;
        buildBed(stage, state.bed, PRINTERS[v].excludeArea);
      });
    function setBed(k, v) {
      state.bed[k] = v;
      state.printerKey = 'custom';
      printerSel.value = 'custom';
      buildBed(stage, state.bed, []);
    }
    L.append(card('Printer',
      row('Preset', printerSel),
      row('Volume X', ...bedX.nodes),
      row('Volume Y', ...bedY.nodes),
      row('Volume Z', ...bedZ.nodes),
    ));

    // Global print settings
    const layerSel = select(QUALITIES.map((q) => ({ value: String(q.h), label: `${q.h.toFixed(2)} mm — ${q.name}` })),
      String(state.proc.layerHeight), (v) => { state.proc.layerHeight = Number(v); state.proc.firstLayerHeight = Number(v); });
    const matSel = select(Object.keys(MATERIALS).map((k) => ({ value: k, label: MATERIALS[k].name })),
      state.materialKey, (v) => {
        state.materialKey = v;
        const m = MATERIALS[v];
        state.proc.nozzleC = m.nozzleC; state.proc.bedC = m.bedC;
        if (m.note) say(m.note, false, 6000);
      });
    const walls = num(state.proc.wallLoops, { min: 1, max: 8, onchange: (v) => state.proc.wallLoops = v });
    const infill = num(state.proc.infillPct, { min: 0, max: 100, unit: '%', onchange: (v) => state.proc.infillPct = v });
    const patSel = select(INFILL_PATTERNS.map((p) => ({ value: p, label: p })), state.proc.infillPattern,
      (v) => state.proc.infillPattern = v);
    L.append(card('Print settings',
      row('Material', matSel),
      row('Layer height', layerSel),
      row('Walls', ...walls.nodes),
      row('Infill', ...infill.nodes),
      row('Pattern', patSel),
      checkbox('Allow supports', state.proc.supports, (v) => state.proc.supports = v),
      el('div', { class: 'note' }, 'These are the plate-wide settings. Each part can override its own on the right, and overrides travel into the 3MF.'),
    ));

    // Joint
    fitSliderCtl = steppedSlider(FIT_STOPS, state.fitIdx, (i) => {
      state.fitIdx = i;
      if (state.parts.length) say('Fit changed - re-run Auto Split to restamp the joints with the new clearances.', false, 5000);
    });
    const sMaxN = num(state.sMax, { min: 12, max: 40, unit: 'mm', onchange: (v) => state.sMax = Math.max(12, v) });
    L.append(card('Joints',
      rowInfo('Fit', 'Clearance between the halves. Standard is the design default; print the coupon and move one stop at a time if it binds or rattles.', el('span')),
      fitSliderCtl.wrap,
      row('Max size', ...sMaxN.nodes),
      el('div', { class: 'btnrow', style: 'margin-top:7px' },
        button('Print fit coupon', exportCoupon, 'g sm')),
    ));

    // Actions
    actionsCard = card('Actions',
      el('div', { class: 'btnrow' },
        button('Auto Split', () => autoSplit(), ''),
        button('Auto Chamfer', autoChamfer, 'g'),
        button('Auto-Arrange', arrange, 'g')),
      el('div', { class: 'note' },
        'Split cuts the model into printer-sized parts and stamps snap joints into every cut. Chamfer eases convex right angles. Arrange packs the parts onto plates.'),
    );
    L.append(actionsCard);
    refreshActions();
  }

  function refreshActions() {
    const btns = actionsCard.querySelectorAll('.btn');
    const have = !!state.model;
    btns[0].disabled = !have || !state.model?.csgId;
    btns[1].disabled = !have || (!state.model?.csgId && !state.parts.length);
    btns[2].disabled = !state.parts.length;
  }

  function refreshModelCard() {
    const m = state.model;
    if (!m) { modelCard.className = 'empty'; modelCard.textContent = 'Drop an STL anywhere, or import one.'; return; }
    const s = m.summary, h = s.health;
    modelCard.className = '';
    modelCard.innerHTML = '';
    modelCard.append(
      el('div', { class: 'stats', style: 'margin-top:8px' },
        stat('Size', fmtSize(s.size), 'mm'),
        stat('Triangles', s.triCount.toLocaleString()),
        stat('Faces', s.faces),
        stat('Holes', s.holes)),
      el('div', { class: h.closed ? 'note' : 'note warn' },
        h.closed ? 'Closed, consistently wound, ready to split.'
          : `Not a clean solid: ${h.boundaryEdges} open edges, ${h.nonManifoldEdges} non-manifold, ${h.flippedEdges} flipped. ${m.csgId ? 'The CSG kernel accepted it after welding.' : 'The CSG kernel refused it - repair before splitting.'}`),
    );
  }
  const stat = (k, v, u) => el('div', { class: 'stat' },
    el('div', { class: 'stat-k' }, k),
    el('div', { class: 'stat-v' }, String(v), u ? el('span', { class: 'u' }, u) : null));
  const fmtSize = (s) => s.map((v) => Math.round(v)).join(' × ');

  // ================================================================ UI: right
  var partsList, selectedCard, exportCard, jointsCard;
  function buildRightPanel() {
    partsList = el('div', { class: 'plist' });
    R.append(el('div', { class: 'card flush' },
      el('div', { class: 'card-t', style: 'padding:11px 14px 0' }, 'Parts ',
        el('span', { class: 'n', id: 'part-count' }, '')),
      partsList));
    jointsCard = card('Joints', el('div', { class: 'empty' }, 'Joints appear after a split.'));
    R.append(jointsCard);
    selectedCard = card('Selected part', el('div', { class: 'empty' }, 'Click a part to inspect it.'));
    R.append(selectedCard);
    exportCard = card('Export', el('div', { class: 'empty' }, 'Arrange first, then export.'));
    R.append(exportCard);
  }

  function refreshParts() {
    partsList.innerHTML = '';
    const count = document.getElementById('part-count');
    if (count) count.textContent = state.parts.length ? String(state.parts.length) : '';
    if (!state.parts.length) {
      partsList.append(el('div', { class: 'empty', style: 'padding:10px 14px' }, 'No parts yet - import and Auto Split.'));
      refreshJoints();
      return;
    }
    for (const part of state.parts) {
      const o = part.orientation;
      const item = el('div', { class: 'pitem' + (state.selected === part.id ? ' sel' : '') },
        el('span', { class: 'sw', style: `background:#${part.color.toString(16).padStart(6, '0')}` }),
        el('span', { class: 'nm' }, part.name),
        o?.needsSupport ? el('span', { class: 'warn', title: 'needs support in its best orientation' }, '▲') : null,
        el('span', { class: 'dim' }, part.summary ? fmtSize(part.summary.size) : ''));
      item.addEventListener('click', () => selectPart(part.id));
      item.addEventListener('mouseenter', () => highlightPart(part.id, true));
      item.addEventListener('mouseleave', () => highlightPart(part.id, false));
      partsList.append(item);
    }
    refreshJoints();
  }

  function refreshJoints() {
    jointsCard.innerHTML = '';
    jointsCard.append(el('div', { class: 'card-t' }, 'Joints ', el('span', { class: 'n' }, state.joints.length || '')));
    if (!state.joints.length) {
      jointsCard.append(el('div', { class: 'empty' }, 'Joints appear after a split.'));
      return;
    }
    for (const j of state.joints) {
      const a = state.parts.find((p) => p.id === j.aPartId), b = state.parts.find((p) => p.id === j.bPartId);
      const male = j.maleOn === 'A' ? a : b;
      const ok = j.audit?.ok;
      jointsCard.append(el('div', { class: 'row', style: 'min-height:22px' },
        el('span', { class: 'lbl w' }, `${j.S} mm ×${j.sites.length}`),
        el('span', { style: 'flex:1;font-size:10px;color:rgba(0,0,0,.5)' },
          `${a?.name ?? '?'} ↔ ${b?.name ?? '?'} · male on ${male?.name ?? '?'}`),
        ok === false ? el('span', { class: 'warn', title: 'containment audit failed' }, '▲') : null,
        button('Swap', () => swapJoint(j), 'g sm')));
    }
    jointsCard.append(el('div', { class: 'note' },
      'Ghost view shows every joint inside its part - amber male, violet female. Swap re-runs the split with the halves exchanged.'));
  }

  async function swapJoint(j) {
    if (!state.plan) return;
    state.plan.swaps = state.plan.swaps || {};
    state.plan.swaps[j.planeIdx] = !state.plan.swaps[j.planeIdx];
    say('Re-cutting with the joint swapped…');
    await reexecute();
  }

  async function reexecute() {
    // Tear down parts but keep the model and the plan.
    for (const p of state.parts) { disposeGroup(p.group); stage.world.remove(p.group); geom.call('geom.free', { id: p.id }); }
    csg.call('csg.release', { solidIds: state.parts.map((p) => p.csgId) });
    state.parts = []; state.joints = []; state.plates = [];
    try {
      await executePlan(state.plan);
      say('Re-stamped.');
    } catch (e) { say(e.message, true); }
  }

  function highlightPart(id, on) {
    const part = state.parts.find((p) => p.id === id);
    if (!part) return;
    part.mesh.material.emissive = new THREE.Color(on ? 0x224a66 : 0x000000);
    part.mesh.material.needsUpdate = true;
  }

  function selectPart(id) {
    state.selected = state.selected === id ? null : id;
    refreshParts();
    refreshSelected();
  }

  function refreshSelected() {
    selectedCard.innerHTML = '';
    selectedCard.append(el('div', { class: 'card-t' }, 'Selected part'));
    const part = state.parts.find((p) => p.id === state.selected);
    if (!part) {
      selectedCard.append(el('div', { class: 'empty' }, 'Click a part to inspect it.'));
      return;
    }
    const o = part.orientation;
    selectedCard.append(
      el('div', { class: 'stats' },
        stat('Size', fmtSize(part.summary.size), 'mm'),
        stat('Tris', part.summary.triCount.toLocaleString())),
      el('hr'));

    // Orientation candidates: the print poses, best first.
    selectedCard.append(el('div', { class: 'card-t' }, 'Print orientation'));
    if (!part.orientCands.length) {
      selectedCard.append(el('div', { class: 'empty' }, 'No ranked orientations.'));
    } else {
      for (const [i, cand] of part.orientCands.entries()) {
        const chosen = o === cand;
        const b = el('div', { class: 'row', style: 'cursor:pointer;min-height:24px' + (chosen ? ';color:#2d7cb5' : '') },
          el('span', { class: 'lbl w', style: chosen ? 'color:#2d7cb5;font-weight:700' : '' }, chosen ? '● ' + ordinal(i) : ordinal(i)),
          el('span', { style: 'flex:1;font-size:10px' },
            `${cand.unsupportedMm2 <= 4 ? 'no supports' : `${Math.round(cand.unsupportedMm2)} mm² unsupported`} · h ${cand.height} mm`),
          cand.needsSupport ? el('span', { class: 'warn' }, '▲') : null);
        b.addEventListener('click', () => {
          part.orientation = cand;
          state.plates = [];        // the arrangement is stale now
          refreshSelected(); refreshParts(); refreshExport();
        });
        selectedCard.append(b);
      }
      selectedCard.append(el('div', { class: 'note' },
        'Ranked for dimensional accuracy, layer strength across the joints, and printing every joint face without support.'));
    }

    // Per-part overrides.
    selectedCard.append(el('hr'), el('div', { class: 'card-t' }, 'Overrides',
      el('span', { class: 'n' }, part.proc ? 'custom' : 'inherits global')));
    const eff = effectiveProc(part);
    const mark = () => { part.proc = part.proc || {}; };
    const layerSel = select(QUALITIES.map((q) => ({ value: String(q.h), label: `${q.h.toFixed(2)} mm` })),
      String(eff.layerHeight), (v) => { mark(); part.proc.layerHeight = Number(v); refreshSelected(); });
    const walls = num(eff.wallLoops, { min: 1, max: 8, onchange: (v) => { mark(); part.proc.wallLoops = v; } });
    const infill = num(eff.infillPct, { min: 0, max: 100, unit: '%', onchange: (v) => { mark(); part.proc.infillPct = v; } });
    const patSel = select(INFILL_PATTERNS.map((p) => ({ value: p, label: p })), eff.infillPattern,
      (v) => { mark(); part.proc.infillPattern = v; });
    selectedCard.append(
      row('Layer', layerSel),
      row('Walls', ...walls.nodes),
      row('Infill', ...infill.nodes),
      row('Pattern', patSel),
      checkbox('Supports for this part', eff.supports, (v) => { mark(); part.proc.supports = v; }),
      el('div', { class: 'btnrow', style: 'margin-top:6px' },
        button('Reset to global', () => { part.proc = null; refreshSelected(); }, 'g sm')),
      el('div', { class: 'note' }, 'Overrides ride into the 3MF as per-object settings, so the slicer applies them to this part only. Parts with different layer heights or materials get separate plates.'),
    );
  }
  const ordinal = (i) => ['Best', '2nd', '3rd', '4th', '5th'][i] || `${i + 1}th`;

  function refreshExport() {
    exportCard.innerHTML = '';
    exportCard.append(el('div', { class: 'card-t' }, 'Export'));
    if (!state.plates.length) {
      exportCard.append(el('div', { class: 'empty' }, 'Arrange first, then export.'));
      return;
    }
    const sel = { plate3mf: true, plateStl: false, partStls: false, zip: state.plates.length > 1 };
    exportCard.append(
      checkbox(`Plate project${state.plates.length > 1 ? 's' : ''} (.3mf) — opens in ElegooSlicer with settings applied`, sel.plate3mf, (v) => sel.plate3mf = v),
      checkbox('Merged plate STLs', sel.plateStl, (v) => sel.plateStl = v),
      checkbox('Individual part STLs', sel.partStls, (v) => sel.partStls = v),
      checkbox('Bundle as one .zip', sel.zip, (v) => sel.zip = v),
      el('div', { class: 'btnrow', style: 'margin-top:8px' },
        button('Export', () => doExport(sel), 'wide')),
      el('div', { class: 'note' },
        'No G-code is written here - slice the 3MF in ElegooSlicer or OrcaSlicer. Positions, per-part overrides and the printer profile are already in the file.'),
    );
  }

  // ================================================================ HUD
  var viewSeg, explodeRow;
  function buildHud() {
    const hud = el('div', { class: 'hud' });
    viewSeg = seg([
      { value: 'model', label: 'Model' },
      { value: 'ghost', label: 'Ghost' },
      { value: 'explode', label: 'Explode' },
      { value: 'plates', label: 'Plates' },
    ], 'model', setView);
    hud.append(viewSeg.wrap);

    // Explode amount
    const exSlider = el('input', { type: 'range', min: 0, max: 100, value: 0, style: 'width:130px' });
    exSlider.addEventListener('input', () => { state.explodeT = Number(exSlider.value) / 100; applyExplode(); });
    explodeRow = el('div', { class: 'seg', style: 'padding:4px 10px;display:none;align-items:center;gap:8px' },
      el('span', { style: 'font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:rgba(0,0,0,.4)' }, 'Pull'),
      exSlider);
    hud.append(explodeRow);

    // Section plane: its own segmented control plus a position slider that
    // only appears while a section is active.
    const secSlider = el('input', { type: 'range', min: 0, max: 100, value: 50, style: 'width:110px;display:none' });
    secSlider.addEventListener('input', () => { state.section.frac = Number(secSlider.value) / 100; applySection(); });
    const secSeg = seg([
      { value: 'off', label: 'Solid' },
      { value: 'x', label: 'Cut X' }, { value: 'y', label: 'Cut Y' }, { value: 'z', label: 'Cut Z' },
    ], 'off', (v) => {
      state.section.on = v !== 'off';
      if (v !== 'off') state.section.axis = v;
      secSlider.style.display = state.section.on ? '' : 'none';
      applySection();
    });
    hud.append(secSeg.wrap, secSlider);
    stageEl.append(hud);

    const vhud = el('div', { class: 'vhud' },
      el('div', {}, `${PRINTERS[state.printerKey].name}`),
      el('div', {}, `${state.bed.x} × ${state.bed.y} × ${state.bed.z} mm`));
    stageEl.append(vhud);
  }

  // ================================================================ drop zone
  function buildDropZone() {
    const drop = el('div', { class: 'drop' },
      el('div', { class: 'big' }, 'Drop an STL here'),
      el('div', {}, 'It is split into printable parts, jointed, oriented and packed - all in this tab. Nothing is uploaded.'));
    stageEl.append(drop);
    const setVis = () => { drop.style.display = state.model ? 'none' : ''; };
    const obs = new MutationObserver(setVis);
    // Simpler: poll on import; call setVis from importSTL via interval.
    setInterval(setVis, 600);

    for (const evt of ['dragover', 'dragenter']) {
      window.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('hot'); });
    }
    for (const evt of ['dragleave', 'drop']) {
      window.addEventListener(evt, (e) => { e.preventDefault(); if (evt === 'dragleave' && e.relatedTarget) return; drop.classList.remove('hot'); });
    }
    window.addEventListener('drop', (e) => {
      const f = [...(e.dataTransfer?.files || [])].find((f) => /\.stl$/i.test(f.name));
      if (f) importSTL(f);
      else if (e.dataTransfer?.files?.length) say('That is not an STL.', true);
    });
  }

  // ================================================================ picking
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  stage.renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.parts.length) return;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, stage.camera);
    const meshes = state.parts.map((p) => p.mesh).filter((m) => m.visible);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length) {
      const part = state.parts.find((p) => p.mesh === hits[0].object);
      if (part) selectPart(part.id);
    }
  });

  // ---------------------------------------------------------------- misc math
  const IDENT16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const avg = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]);
  const boxVol = (b) => Math.max(1, (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  say('Ready. Import an STL to begin.');
}
