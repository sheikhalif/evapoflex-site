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
    mateType: 'dovetail',   // profiled cut is the default; 'snap' is the stamped boss
    model: null,          // {geomId, csgId, name, summary, group}
    parts: [],            // see mkPart
    joints: [],           // {id, planeIdx, aPartId, bPartId, axis, S, hb, sites, frame, maleOn, swap}
    plan: null,           // last plan from geom.plan
    manualPlanes: [],     // user-placed cuts: {n, d, point, helper}
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
  // A handle on the running tool, for the console and for automated checks.
  // Read-only by convention; nothing in the app reads it back.
  if (typeof window !== 'undefined') window.printPrep = { state, stage, geom, csg };
  buildBed(stage, state.bed, PRINTERS[state.printerKey].excludeArea);
  const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  const clipping = [];    // filled when section is on

  const say = (m, err) => toast(stageEl, m, err);

  // ---------------------------------------------------------------- panels
  const L = document.getElementById('pane-l');
  const R = document.getElementById('pane-r');
  buildLeftPanel();
  buildPartCard();
  buildTopActions();
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
    for (const e of state.manualPlanes) disposeGroup(e.helper);
    state.manualPlanes = []; state.cutMode = false;
    state.model = null; state.parts = []; state.joints = []; state.plan = null;
    state.plates = []; state.selected = null; state.view = 'model';
    // Seams outlive their parts otherwise, and the joints card lists a dozen
    // "? <-> ? · glue seam" rows for a model that is no longer loaded.
    state.seams = []; state.plainSeams = 0; state.islandCount = 0;
    refreshParts(); refreshModelCard(); refreshActions(); refreshSelected(); refreshCuts(); refreshQuality();
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
      const useManual = manualPlanes ||
        (state.manualPlanes.length ? state.manualPlanes.map((p) => ({ n: p.n, d: p.d })) : null);
      const plan = await geom.call('geom.plan', {
        id: m.geomId, bed: state.bed, sMax: state.sMax, fit: fit(),
        nozzle: printer().nozzle, manualPlanes: useManual,
      }, { onProgress: (p) => setProgress(0.05 + p.frac * 0.3) });
      console.debug('[split plan]', plan.planes.length, 'planes;', plan.log);
      state.cutMode = false;
      for (const e of state.manualPlanes) e.helper.visible = false;
      refreshCuts();
      state.plan = { ...plan, manualPlanes };
      state.planOptions = plan.options && plan.options.length > 1 ? plan.options : null;

      if (!plan.planes.length) {
        // No planes can mean two very different things, and conflating them
        // once told a 620 mm tube it "already fits".
        if (plan.fits) say('It already fits the printer - nothing to split.');
        else say(`Could not find any workable cut: ${plan.log.join('; ')}. Try placing a cut by hand with Place cuts.`, true, 9000);
        setProgress(1);
        return;
      }
      await executePlan(plan);
      const bad = state.parts.filter((p) => p.summary.size.some((d, i) => d > [state.bed.x, state.bed.y, state.bed.z][i])).length;
      const plain = state.plainSeams || 0;
      const islands = state.islandCount || 0;
      const isle = islands
        ? ` ${islands} cut piece${islands === 1 ? '' : 's'} fell into separate lumps and ${islands === 1 ? 'was' : 'were'} listed separately.`
        : '';
      if (!plan.fits && bad) {
        say(`${state.parts.length} parts, but ${bad} still exceed${bad === 1 ? 's' : ''} the printer - the search ran out of workable cuts (${plan.log[plan.log.length - 1]}). Add manual cuts for the red parts.`, true, 9000);
      } else if (plain) {
        say(`${state.parts.length} parts, ${state.joints.length} of ${state.seams.length} seams jointed. ${plain} seam${plain === 1 ? ' has' : 's have'} no room for a snap joint (under 12 mm of clear material) - ${plain === 1 ? 'it is a plain glue seam' : 'those are plain glue seams'}, shown without joint markers.${isle}`, true, 8000);
      } else {
        say(`${state.parts.length} parts, ${state.joints.length} jointed seam${state.joints.length === 1 ? '' : 's'}.${isle} Check them in Ghost view.`);
      }
      setProgress(1);
    } catch (e) {
      setProgress(0);
      say(e.message, true, 7000);
    }
  }

  /**
   * A seam's identity, stable across re-executions of the same plan.
   *
   * Component handles are minted fresh on every run, so "swap this joint" has
   * to name the seam by where it is, not by which objects happened to hold it
   * last time. The plan replays deterministically, so the plane it lies on plus
   * the two pre-stamp box centres name it exactly.
   */
  const seamKey = (seam) => {
    const c = (bb) => [0, 1, 2].map((k) => ((bb.min[k] + bb.max[k]) / 2).toFixed(1)).join(',');
    return `${seam.planeIdx}|${c(seam.a.bbox)}|${c(seam.b.bbox)}`;
  };

  /**
   * Which of a profiled cut's tabs belongs to this seam.
   *
   * One plane can carry a tab per rail it crosses and produce a seam per pair
   * of components, so the two lists have to be matched by position: the tab
   * whose centre lies in the material both components share along the seam.
   */
  const tabForSeam = (seam, prof) => {
    // Project each box onto the seam's own along-axis. That axis is only a
    // world axis for a grid cut; on a radial seam it points any which way, so
    // the interval has to come from the box's support along u rather than from
    // one of its coordinates.
    const onU = (bb) => {
      let c = 0, r = 0;
      for (let k = 0; k < 3; k++) {
        c += prof.u[k] * (bb.min[k] + bb.max[k]) / 2;
        r += Math.abs(prof.u[k]) * (bb.max[k] - bb.min[k]) / 2;
      }
      return [c - r, c + r];
    };
    const [aLo, aHi] = onU(seam.a.bbox), [bLo, bHi] = onU(seam.b.bbox);
    const lo = Math.max(aLo, bLo), hi = Math.min(aHi, bHi);
    return prof.tabs.find((t) => t.at >= lo - 0.5 && t.at <= hi + 0.5) || null;
  };

  /**
   * A cut set that respects the model's own symmetry.
   *
   * The planner cuts an axis-aligned grid, and a grid is at best four-fold
   * symmetric, so an eight-armed wheel comes apart into one-offs: 24 parts of
   * 20 distinct shapes on the EEDX wheel, 16 of them unique. What makes parts
   * repeat is not cutting each arm "the same" one at a time - it is choosing a
   * set of planes that maps onto ITSELF under the model's rotation. Do that and
   * the partition is symmetric too, so the pieces come out in orbits of
   * identical parts, whatever order the tree happens to apply them in.
   *
   * Two families, both invariant under a turn of one sector:
   *   radial   planes containing the axis, one per sector boundary. A plane
   *            through the axis covers two opposite boundaries at once, so an
   *            even order needs only half as many.
   *   rings    planes perpendicular to each sector's own bisector at a fixed
   *            radius - together a regular polygon, which is as close to a
   *            circle as flat cuts get.
   *
   * The sector count may have to be a MULTIPLE of the symmetry order: eight
   * sectors of a 1 m wheel are 383 mm across at the rim and no bed takes that.
   * A multiple of a symmetry is still a symmetry, so subdividing is free.
   */
  function symmetricPlanes(sym, bed) {
    const margin = 10;
    const lim = Math.max(20, Math.min(bed.x, bed.y) - margin);
    const R = sym.rMax, c = sym.centre;
    if (!(sym.order >= 2) || !(R > 0)) return null;

    // Enough sectors that the outermost band fits across, and still a multiple
    // of the order so the set stays invariant.
    let sectors = sym.order;
    while (2 * R * Math.sin(Math.PI / sectors) > lim && sectors < 256) sectors += sym.order;
    const step = 2 * Math.PI / sectors;
    const planes = [];

    const half = sectors % 2 === 0 ? sectors / 2 : sectors;
    for (let k = 0; k < half; k++) {
      const t = sym.phaseRad + k * step;
      const n = [-Math.sin(t), Math.cos(t), 0];
      planes.push({ n, d: n[0] * c[0] + n[1] * c[1] });
    }

    const bands = Math.max(1, Math.ceil(R / lim));
    for (let j = 1; j < bands; j++) {
      const rad = (j * R) / bands;
      for (let k = 0; k < sectors; k++) {
        const b = sym.phaseRad + (k + 0.5) * step;
        const n = [Math.cos(b), Math.sin(b), 0];
        planes.push({ n, d: n[0] * c[0] + n[1] * c[1] + rad });
      }
    }
    return { planes, sectors, bands };
  }

  /**
   * Snap a nearly-symmetric model onto its own symmetry, then split it.
   *
   * A model that only ALMOST repeats cannot come apart into identical parts,
   * however good the planner is - the parts are not identical in the source.
   * The EEDX wheel repeats to within 4.6% at a half turn and 6.8% at an eighth,
   * and the error grows with the order, which is the signature of arms that sit
   * at slightly irregular angles rather than one bad arm. Rebuilding it from a
   * single sector makes it exact.
   *
   * This changes the model, so it says by how much and leaves the decision with
   * the user.
   */
  async function makeSymmetric() {
    const m = state.model;
    if (!m?.csgId) { say('Import a model first.', true, 5000); return; }
    try {
      setProgress(0.1);
      const sym = await geom.call('geom.symmetry', { id: m.geomId, tol: 0.12 });
      if (sym.order < 4) {
        setProgress(0);
        say(`No usable rotational symmetry about Z (best order ${sym.order}) - nothing to snap to.`, true, 7000);
        return;
      }
      setProgress(0.4);
      const r = await csg.call('csg.symmetrize', { solidId: m.csgId, order: sym.order, centre: sym.centre });
      const mesh = await csg.call('csg.mesh', { solidId: r.solidId });
      const id = `m${state.seq++}`;
      const adopted = await geom.call('geom.adopt', { id, name: `${m.name} (symmetric)`,
        vertProperties: mesh.vertProperties, triVerts: mesh.triVerts });
      // Replace the model in place; the old solid and analysis go with it.
      disposeGroup(m.group); stage.world.remove(m.group);
      geom.call('geom.free', { id: m.geomId });
      csg.call('csg.release', { solidIds: [m.csgId] });
      const group = new THREE.Group();
      const mesh3 = meshFromRender(adopted.render, solidMaterial(0x8fa8bc, clipping));
      const edges = linesFromSegs(adopted.edges, edgeMaterial(clipping));
      group.add(mesh3, edges);
      centreOnBed(group, adopted.summary.bbox);
      state.modelOffset = group.position.clone();
      stage.world.add(group);
      state.model = { geomId: id, csgId: r.solidId, csgError: null, name: adopted.summary.name,
        summary: adopted.summary, group, mesh: mesh3, edges };
      stage.frameObject(shiftedBbox(adopted.summary.bbox, group.position));
      refreshModelCard(); refreshActions();
      setProgress(1);
      say(`Snapped to ${r.order}-fold symmetry: ${r.movedMm3.toFixed(0)} mm3 moved, ${r.movedPct.toFixed(2)}% of the model. Re-run Auto Split for identical parts.`, false, 9000);
    } catch (e) { setProgress(0); say(e.message, true, 8000); }
  }

  async function symmetricSplit() {
    const m = state.model;
    if (!m) return;
    if (!m.csgId) { say(`Cannot split: ${m.csgError}`, true, 7000); return; }
    try {
      setProgress(0.05);
      const sym = await geom.call('geom.symmetry', { id: m.geomId });
      if (sym.order < 2) {
        setProgress(0);
        say(`No rotational symmetry found about Z - nothing to align cuts to. Use Auto Split.`, true, 7000);
        return;
      }
      const built = symmetricPlanes(sym, state.bed);
      if (!built) { setProgress(0); say('Could not build a symmetric cut set.', true, 6000); return; }
      state.symmetry = sym;
      // MEASURED AND NOT SHIPPED. Radial cuts do make the sectors identical,
      // but the ring cuts that shorten each sector are infinite PLANES, and
      // manualTree applies every plane to every piece it crosses - so each
      // ring cut slices all sixteen sectors instead of its own. On the wheel
      // that turned 35 parts into 280, with simplicity 35 against 24 and
      // strength 29 against 55: worse on every axis it was meant to improve.
      //
      // The fix is not a tweak to the plane set. A plan node names one parent
      // piece and two children, but nothing lets a cut say "only this piece" -
      // so sector-local ring cuts need the plan format to carry per-piece
      // assignment first. Refusing beats quietly producing 280 parts.
      setProgress(0);
      say(`${sym.order}-fold symmetry found (${(sym.err * 100).toFixed(1)}% mismatch), but symmetric splitting is `
        + `not ready: ring cuts run across every sector, which made 280 parts where Auto Split makes 35. `
        + `Use Symmetrise to make the model exactly ${sym.order}-fold, then Auto Split.`, true, 11000);
      return;
      // eslint-disable-next-line no-unreachable
      await autoSplit(built.planes);
    } catch (e) { setProgress(0); say(e.message, true, 7000); }
  }

  /**
   * Cut with the joint profile instead of a plane, where that is the honest
   * thing to do.
   *
   * The stamped EVF joint needs about 12 mm of cut face to sit on. Below that
   * `placeJoints` gives up and the seam comes back as glue - which is the whole
   * reason the profiled cut exists: on thin stock the joint cannot be a boss on
   * a face, so the cut path itself becomes the joint. Above that threshold the
   * stamped joint is the proven one and this leaves it alone; the wheel's 10 mm
   * sheet takes this path, the fork and the bracket do not.
   *
   * The tab list can only be measured here. The planner works on a triangle
   * soup and never sees the solid, so which rails a seam crosses - and how wide
   * each one is - is not knowable until the real parent is in hand.
   */
  // How thick stock has to be before a STAMPED joint can sit on its cut face.
  //
  // A square boss of side S needs S/sqrt(2) + margin of clearance from the
  // face's edge all round, so a face only t thick can host the smallest useful
  // 12 mm joint when t >= 2*(12/sqrt(2) + margin) - about 20 mm. This is the
  // same test geom.plan makes before reserving protrusion, and the two have to
  // agree or there is a band where each assumes the other will handle it.
  // Measured in that band: a 12 mm lattice of 24 mm bars got NO joint at all -
  // profiled declined because 12 is not under 12, stamped declined because 12
  // is nowhere near 20 - on seams that comfortably take a 5.4 mm dovetail.
  const stampedNeeds = () => 2 * (12 / Math.SQRT2 + Math.max(1.5, 2 * (printer().nozzle ?? 0.4)));
  async function profiledCut(parentId, pl, idx, profiled) {
    if (state.mateType === 'none' || state.mateType === 'snap') {
      profiled.set(idx, { used: false, why: state.mateType === 'none' ? 'mating feature set to none' : 'stamped snap boss chosen' });
      return null;
    }
    const sec = await csg.call('csg.seamSection', { solidId: parentId, plane: pl });
    if (!sec.lumps.length) return null;
    if (sec.thickness >= stampedNeeds()) {
      profiled.set(idx, { used: false, why: `${sec.thickness.toFixed(1)} mm stock can take a stamped joint` });
      return null;
    }
    // NO BOSS. A joint may only redistribute material across the face it is cut
    // on: whatever the tab adds to one side is exactly what the socket takes
    // from the other, so the two halves put back together are the solid they
    // came from. The pad broke that - it welded material onto the rail that was
    // never in the model, which is a different object, not a jointed one.
    //
    // The joint sizes itself from the face it has to live in. That face is the
    // rail's width by the sheet's thickness, so its area is the only honest
    // budget for how big the tab can be.
    const r = await csg.call('csg.splitProfiled', {
      solidId: parentId, plane: pl,
      // No `at` or `width`: the worker sizes and counts the tabs from the face
      // itself, which is the whole point of a parametric joint.
      stock: { tabs: sec.lumps.map(() => ({})) },
      opts: { type: state.mateType === 'puzzle' ? 'puzzle' : 'dovetail', clearance: fit().tol, faceThickness: sec.thickness },
    });
    if (r.aId == null) { profiled.set(idx, { used: false, why: r.why }); return null; }
    profiled.set(idx, {
      used: true, tabs: r.tabs, maleOn: r.maleOn, jointed: r.jointed,
      // The tab side overshoots the plane by the tab's own length; the seam
      // finder has to know by how much or it will not see that side touching.
      reach: Math.max(0, ...r.tabs.map((t) => (t.plain ? 0 : t.params.tabL))),
      u: sec.u,
    });
    return r;
  }

  async function executePlan(plan) {
    const m = state.model;
    // A re-split replaces everything downstream: the old parts' solids, their
    // analyses, their scene objects, and any arrangement built on them. Leaving
    // any of it behind is either a WASM leak or a stale plate that exports
    // parts which no longer exist.
    for (const p of state.parts) {
      disposeGroup(p.group);
      stage.world.remove(p.group);
      geom.call('geom.free', { id: p.id });
    }
    if (state.parts.length) csg.call('csg.release', { solidIds: state.parts.map((p) => p.csgId) });
    state.parts = []; state.joints = []; state.plates = []; state.seams = [];
    refreshExport();
    // Work on a copy so the original solid survives for a re-plan.
    const rootCopy = await csg.call('csg.transform', { solidId: m.csgId, matrix: IDENT16 });
    const idMap = new Map([[0, rootCopy.solidId]]);
    const parents = new Set(plan.planes.map((p) => p.parentId));

    setProgress(0.4);
    const profiled = new Map();     // plane index -> what the profiled cut did
    for (let i = 0; i < plan.planes.length; i++) {
      const pl = plan.planes[i];
      const parentId = idMap.get(pl.parentId);
      let r = null;
      try {
        r = await profiledCut(parentId, pl, i, profiled);
      } catch (e) {
        // Every refusal is a fallback, never a failure: splitProfiled throws
        // rather than cut a seam wrong, and it leaves the parent handle alone
        // when it does, so the plain cut below can still have it.
        profiled.set(i, { used: false, why: e.message });
        r = null;
      }
      if (!r) r = await csg.call('csg.splitOne', { solidId: parentId, plane: pl });
      if (r.aId == null) throw new Error('a planned cut missed the model - re-run Auto Split');
      idMap.set(pl.aId, r.aId);
      idMap.set(pl.bId, r.bId);
      setProgress(0.4 + 0.15 * (i + 1) / plan.planes.length);
    }

    // ---------------------------------------------------------------- pieces
    // Every leaf becomes one or more COMPONENTS. A leaf whose material is in
    // two disjoint lumps is not one part, and pretending otherwise produced
    // "parts" that were two objects a metre apart sharing a colour, a row in
    // the list and - worse - a single joint that bonded only one of them.
    const leaves = [...new Set(plan.planes.flatMap((p) => [p.aId, p.bId]))].filter((id) => !parents.has(id));
    let islands = 0;
    const comps = [];
    for (const leaf of leaves) {
      const r = await csg.call('csg.decompose', { solidId: idMap.get(leaf) });
      if (r.split) islands += r.parts.length - 1;
      for (const c of r.parts) {
        comps.push({ leaf, csgId: c.solidId, bbox: c.bbox, volume: c.volume, gid: `p${state.seq++}` });
      }
      setProgress(0.55 + 0.05 * (leaves.indexOf(leaf) + 1) / leaves.length);
    }

    // Park each component's mesh in the geom worker so seams can be sectioned
    // against real closed solids.
    for (const c of comps) {
      const mesh = await csg.call('csg.mesh', { solidId: c.csgId });
      await geom.call('geom.stage', { id: c.gid, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts });
    }

    // ---------------------------------------------------------------- seams
    // A seam is a pair of components that face each other across one cut
    // plane. Enumerating pairs - rather than planes - is what puts a joint on
    // every place two parts actually meet: quartering a ring has four seams,
    // not two, because plane X meets plane Y's halves twice over.
    const parentOf = new Map();
    for (const p of plan.planes) { parentOf.set(p.aId, p.parentId); parentOf.set(p.bId, p.parentId); }
    const inSubtree = (leaf, node) => {
      for (let c = leaf; ; c = parentOf.get(c)) {
        if (c === node) return true;
        if (!parentOf.has(c)) return false;
      }
    };
    const span = (bbox, n) => {          // interval of n·x over the box
      let lo = 0, hi = 0;
      for (let k = 0; k < 3; k++) {
        const a = n[k] * bbox.min[k], b = n[k] * bbox.max[k];
        lo += Math.min(a, b); hi += Math.max(a, b);
      }
      return [lo, hi];
    };
    const TOUCH = 0.25;                  // mm: the cut face is exactly on the plane
    const overlapsInPlane = (a, b, n) => {
      // Compare the two boxes on the axes the plane does NOT run along. Boxes
      // that only meet at a corner share no face worth jointing.
      for (let k = 0; k < 3; k++) {
        if (Math.abs(n[k]) > 0.5) continue;
        const lo = Math.max(a.min[k], b.min[k]), hi = Math.min(a.max[k], b.max[k]);
        if (hi - lo < 1) return false;
      }
      return true;
    };

    const seams = [];
    for (let i = 0; i < plan.planes.length; i++) {
      const pl = plan.planes[i];
      // "Reaches the plane", not "ends exactly on it".
      //
      // Everything in the A subtree lies at or above d and everything in the B
      // subtree at or below it, so asking whether a component reaches the plane
      // is the same test as before for a plain cut - but it survives a profiled
      // one, where the tab side overshoots by the tab's length. At 3.9 mm on
      // the wheel's rails that is fifteen times TOUCH, so the old equality test
      // dropped every profiled seam, and with it the joint row and the explode
      // edge for a joint that was physically there.
      const aSide = comps.filter((c) => inSubtree(c.leaf, pl.aId) && span(c.bbox, pl.n)[0] < pl.d + TOUCH);
      const bSide = comps.filter((c) => inSubtree(c.leaf, pl.bId) && span(c.bbox, pl.n)[1] > pl.d - TOUCH);
      for (const a of aSide) {
        for (const b of bSide) {
          if (!overlapsInPlane(a.bbox, b.bbox, pl.n)) continue;
          seams.push({ planeIdx: i, plane: { n: pl.n, d: pl.d }, a, b });
        }
      }
    }

    // Site the joints on each seam from the real geometry. The other planes
    // bounding either component are handed over as keep-out lines so a joint is
    // never stamped across a neighbouring cut.
    state.joints = [];
    state.seams = seams;
    let jseq = 0, plain = 0;
    for (let s = 0; s < seams.length; s++) {
      const seam = seams[s];
      // A profiled seam is already mated - the joint IS the cut, so there is
      // nothing to site and nothing to stamp, and no containment to audit
      // because a joint shaped like the cut cannot poke out of its own part.
      const prof = profiled.get(seam.planeIdx);
      if (prof?.used) {
        const tab = tabForSeam(seam, prof);
        seam.profiled = true;
        seam.why = tab?.why || null;
        if (tab && !tab.plain) {
          seam.placement = { profiled: true, grip: tab.params.grip, width: tab.width };
          state.joints.push({
            id: `j${jseq++}`, seamKey: seamKey(seam), planeIdx: seam.planeIdx,
            kind: 'profiled', aComp: seam.a, bComp: seam.b,
            axis: seam.plane.n.slice(), maleOn: prof.maleOn,
            grip: tab.params.grip, tabL: tab.params.tabL, width: tab.width,
            type: tab.params.type, sites: [], hb: 0,
          });
        } else {
          seam.placement = null;
          plain++;
        }
        setProgress(0.6 + 0.1 * (s + 1) / seams.length);
        continue;
      }
      // Keep-outs: only the cuts that actually pass through one of these two
      // components. A plane on the far side of the model draws a keep-out band
      // across all of space, and including it would veto perfectly good sites
      // on a seam it has nothing to do with.
      const crosses = (q, bbox) => {
        const [lo, hi] = span(bbox, q.n);
        return lo - 1 < q.d && q.d < hi + 1;
      };
      // A plane at a different index can still be the SAME plane in space: the
      // tree cuts each half of a quartered ring at y = 0 separately, so plane 1
      // and plane 2 are geometrically identical. Excluding by index alone let
      // plane 2's keep-out band cover the whole of plane 1's contact face, and
      // both of the ring's side seams silently came back plain.
      const coincident = (q) => {
        const dp = q.n[0] * seam.plane.n[0] + q.n[1] * seam.plane.n[1] + q.n[2] * seam.plane.n[2];
        if (Math.abs(Math.abs(dp) - 1) > 1e-3) return false;
        return Math.abs(q.d - Math.sign(dp) * seam.plane.d) < 0.5;
      };
      const avoid = plan.planes
        .filter((q, qi) => qi !== seam.planeIdx && !coincident(q) &&
          (crosses(q, seam.a.bbox) || crosses(q, seam.b.bbox)))
        .map((q) => ({ n: q.n, d: q.d }));
      let placed = null;
      try {
        const r = await geom.call('geom.seamJoints', {
          aId: seam.a.gid, bId: seam.b.gid, plane: seam.plane,
          sMax: state.sMax, fit: fit(), nozzle: printer().nozzle, avoid,
        });
        placed = r?.placed || null;
        seam.why = r?.why || null;
      } catch (e) { placed = null; seam.why = e.message; }
      seam.placement = placed;
      if (!placed) {
        // Say why BOTH answers were unavailable. Reporting only the stamped
        // joint's reason on stock too thin to ever take one is half the story,
        // and the half that cannot be acted on.
        if (prof && !prof.used && prof.why) seam.why = `${seam.why || 'no stamped joint'}; cut joint: ${prof.why}`;
        plain++;
        continue;
      }

      const key = seamKey(seam);
      const maleOn = state.plan?.swaps?.[key] ? 'A' : 'B';
      const r = await csg.call('csg.stamp', {
        aId: seam.a.csgId, bId: seam.b.csgId,
        placement: placed, fit: fit(), maleOn,
      });
      if (!r.audit.ok) say(`A joint's containment audit failed (${(r.audit.maleContained * 100).toFixed(1)}% / ${(r.audit.femaleContained * 100).toFixed(1)}%) - inspect it in Ghost view.`, true, 8000);
      seam.a.csgId = r.aId;
      seam.b.csgId = r.bId;
      state.joints.push({
        id: `j${jseq++}`, seamKey: key, planeIdx: seam.planeIdx,
        aComp: seam.a, bComp: seam.b,
        axis: r.meta.axis, S: placed.S, hb: r.meta.hb ?? placed.hb, depth: placed.depth,
        sites: placed.sites, frame: placed.frame, maleOn, audit: r.audit,
      });
      setProgress(0.6 + 0.1 * (s + 1) / seams.length);
    }
    state.plainSeams = plain;
    state.islandCount = islands;
    state.profiledPlanes = profiled;

    // ---------------------------------------------------------------- parts
    if (state.model) state.model.group.visible = false;
    state.parts = [];
    let pi = 0;
    for (const c of comps) {
      const mesh = await csg.call('csg.mesh', { solidId: c.csgId });
      const name = `Part ${pi + 1}`;
      const adopted = await geom.call('geom.adopt', {
        id: c.gid, name, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts,
      });
      const part = mkPart(c.gid, c.csgId, name, adopted, pi);
      part.planLeaf = c.leaf;
      part.volume = c.volume;
      c.partId = part.id;
      state.parts.push(part);
      stage.world.add(part.group);
      pi++;
      setProgress(0.7 + 0.25 * pi / comps.length);
    }
    await geom.call('geom.unstage', { ids: comps.map((c) => c.gid) });

    // Joint <-> part links, then joint preview solids for the ghost/exploded views.
    for (const j of state.joints) {
      j.aPartId = j.aComp.partId;
      j.bPartId = j.bComp.partId;
    }
    for (const seam of seams) {
      seam.aPartId = seam.a.partId;
      seam.bPartId = seam.b.partId;
    }
    await buildJointPreviews();
    await orientAll();
    layoutPartsOnBed();
    refreshParts(); refreshActions(); refreshExport(); refreshQuality(); refreshPlanOptions();
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
      // A profiled joint has no separate solid to preview - it is the shape of
      // the seam, already in both parts, and it shows up in Ghost view as the
      // parts themselves.
      if (j.kind === 'profiled') { j.siteMeshes = []; continue; }
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
        .flatMap((j) => (j.sites || []).map((s) => ({ center: s.world, S: j.S })));
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

    // The stage is a CAD void everywhere but Plates. A build plate under an
    // assembled model is scenery: it says nothing about the model, and it puts
    // a grid behind every joint you are trying to look at.
    stage.bedGroup.visible = platesOn;
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
      bbox: p.summary?.bbox || null,
    }));
    // Every seam is an edge, jointed or not. A glue seam still means "these two
    // came apart here", and the view is only honest if it opens along it.
    const seamInfo = (state.seams || [])
      .filter((s) => s.aPartId && s.bPartId)
      .map((s) => ({
        aId: s.aPartId, bId: s.bPartId,
        axis: s.plane.n.slice(),
        hb: state.joints.find((j) => j.aPartId === s.aPartId && j.bPartId === s.bPartId)?.hb || 0,
      }));
    explodeMap = explodeVectors(partsInfo, seamInfo);
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

      const skipped = [];
      for (let pi = 0; pi < state.plates.length; pi++) {
        const plate = state.plates[pi];
        const placed = plate.placements.filter((p) => !p.tooBig);
        skipped.push(...plate.placements.filter((p) => p.tooBig).map((p) => p.id));
        if (!placed.length) continue;    // a plate of only unplaceable parts is not a file worth writing
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
      const skippedNames = skipped.map((id) => state.parts.find((p) => p.id === id)?.name).filter(Boolean);
      say(`Exported ${files.length} file${files.length === 1 ? '' : 's'}.` +
        (skippedNames.length ? ` LEFT OUT of the plates (too big for the bed): ${skippedNames.join(', ')} - their STLs are still exportable individually.` : '') +
        ' The 3MF opens straight in ElegooSlicer or OrcaSlicer; slice there for G-code.', skippedNames.length > 0, 8000);
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
  var actionsCard, modelCard, fitSliderCtl, cutsCard;
  /**
   * A card that folds. The rail carries five sections now that the right panel
   * is gone, and all of them at once is a wall - so everything but Actions
   * starts shut and remembers nothing, which is the honest default when the
   * tool has just opened and there is nothing to inspect yet.
   */
  function foldCard(title, open, ...children) {
    const chev = el('span', { class: 'chev' }, '\u25be');
    const t = el('div', { class: 'card-t fold' }, title, chev);
    const body = el('div', { class: 'card-body' }, ...children);
    const c = el('div', { class: 'card' + (open ? '' : ' shut') }, t, body);
    t.addEventListener('click', () => c.classList.toggle('shut'));
    c.body = body;
    c.head = t;
    return c;
  }

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
    const printerCard = foldCard('Printer', false,
      row('Preset', printerSel),
      row('Volume X', ...bedX.nodes),
      row('Volume Y', ...bedY.nodes),
      row('Volume Z', ...bedZ.nodes),
    );

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
    const printCard = foldCard('Print settings', false,
      row('Material', matSel),
      row('Layer height', layerSel),
      row('Walls', ...walls.nodes),
      row('Infill', ...infill.nodes),
      row('Pattern', patSel),
      checkbox('Allow supports', state.proc.supports, (v) => state.proc.supports = v),
      el('div', { class: 'note' }, 'Plate-wide. A part can override its own from its card, and overrides travel into the 3MF.'),
    );

    // Joint
    const MATES = [
      { value: 'dovetail', label: 'Dovetail — cut through the sheet' },
      { value: 'puzzle', label: 'Puzzle — round head, flat print only' },
      { value: 'snap', label: 'Snap boss — needs a 12 mm face' },
      { value: 'none', label: 'None — plain glue seams' },
    ];
    const matePreview = el('div', { class: 'note', style: 'margin:2px 0 6px' }, '');
    const describeMate = () => {
      const t = { dovetail: 'A tab cut through the full thickness. Vertical walls printed flat, no supports, and nothing added to the model - the tab is material the other half gave up.',
                  puzzle: 'Round head on a waist. Grips harder than a dovetail for the same width, but the undercut is a true overhang printed on edge.',
                  snap: 'The EVF boss stamped on the cut face. Strongest option, but it needs about 12 mm of clear face and thin stock has none.',
                  none: 'Every seam plain. Butt faces, glued.' }[state.mateType] || '';
      matePreview.textContent = t;
    };
    const mateSel = select(MATES, state.mateType, (v) => { state.mateType = v; describeMate();
      if (state.parts.length) say('Mating feature changed - re-run Auto Split to recut the seams.', false, 5000); });
    describeMate();
    jointsCard = el('div', { style: 'margin-top:9px' });
    qualityCard = el('div', { style: 'margin-top:9px' });
    planOptCard = el('div', { style: 'margin-top:9px' });
    fitSliderCtl = steppedSlider(FIT_STOPS, state.fitIdx, (i) => {
      state.fitIdx = i;
      if (state.parts.length) say('Fit changed - re-run Auto Split to restamp the joints with the new clearances.', false, 5000);
    });
    const sMaxN = num(state.sMax, { min: 12, max: 40, unit: 'mm', onchange: (v) => state.sMax = Math.max(12, v) });
    const jointsSetCard = foldCard('Joints', false,
      row('Mating feature', mateSel),
      matePreview,
      rowInfo('Fit', 'Clearance between the halves. Standard is the design default; print the coupon and move one stop at a time if it binds or rattles.', el('span')),
      fitSliderCtl.wrap,
      row('Max size', ...sMaxN.nodes),
      el('div', { class: 'btnrow', style: 'margin-top:7px' },
        button('Print fit coupon', exportCoupon, 'g sm')),
      qualityCard,
      planOptCard,
      jointsCard,
    );

    // Manual cuts
    cutsCard = foldCard('Cuts', false, el('div', { class: 'empty' }, 'Optional. Turn on Place cuts, then click a face to add a cut in its plane, or a bore to cut square to it. Auto Split uses your cuts when any exist.'));
    refreshCuts();

    // Actions
    actionsCard = card('Actions',
      el('div', { class: 'btnrow' },
        button('Auto Split', () => autoSplit(), ''),
        button('Auto Chamfer', autoChamfer, 'g'),
        button('Symmetrise', makeSymmetric, 'g'),
        button('Auto-Arrange', arrange, 'g')),
      el('div', { class: 'note' },
        'Split cuts the model into printer-sized parts and joints every seam it can. Chamfer eases convex right angles. Arrange packs the parts onto plates.'),
    );

    // The recorded order: what you DO, then how the joints behave, then how it
    // prints, then which machine. Settings you touch once live at the bottom.
    L.append(actionsCard, jointsSetCard, cutsCard, printCard, printerCard);
    refreshActions();
    refreshJoints();
  }

  function refreshCuts() {
    if (!cutsCard) return;
    const cutsBody = cutsCard.body || cutsCard;
    cutsBody.innerHTML = '';
    const toggle = button(state.cutMode ? 'Placing cuts — click the model' : 'Place cuts', () => {
      state.cutMode = !state.cutMode;
      refreshCuts();
    }, state.cutMode ? 'sm' : 'g sm');
    if (cutsCard.head) { const n = state.manualPlanes.length; cutsCard.head.firstChild.textContent = n ? `Cuts (${n})` : 'Cuts'; }
    cutsBody.append(toggle);
    if (!state.manualPlanes.length) {
      cutsCard.append(el('div', { class: 'note' },
        'Optional. Click a face to add a cut in its plane, a bore to cut square to its axis. With no cuts placed, Auto Split chooses its own.'));
      return;
    }
    state.manualPlanes.forEach((entry, i) => {
      const range = Math.max(20, (state.model?.summary.diag || 100) / 3);
      const slider = el('input', { type: 'range', min: -range, max: range, step: 0.5, value: entry.d - entry.d0 });
      slider.addEventListener('input', () => {
        entry.d = entry.d0 + Number(slider.value);
        entry.place(entry.d);
      });
      cutsCard.append(el('div', { class: 'row' },
        el('span', { class: 'lbl w' }, `Cut ${i + 1}`),
        slider,
        button('×', () => removeManualPlane(entry), 'g sm')));
    });
    cutsBody.append(el('div', { class: 'note' }, 'Sliders move each cut along its own normal.'));
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
  var partsList, jointsCard, qualityCard, planOptCard;
  /**
   * The per-part card, which is the whole of the old right panel.
   *
   * Hover a part and it follows the pointer; click and it pins, so you can
   * reach into it without the thing you are reading sliding away. Esc unpins.
   * The build plate lives HERE and in Plates view - the main stage stays a CAD
   * void, because a plate under an assembled model is scenery that tells you
   * nothing about the model.
   */
  var partCard, pinnedPart = null, hoverPart = null;

  var exportModal, exportBody, exportBtn;
  function buildTopActions() {
    const host = document.getElementById('pp');
    exportBtn = button('Export', () => openExport(), 'sm');
    exportBtn.disabled = true;
    document.body.append(el('div', { class: 'top-actions' }, exportBtn));
    exportBody = el('div');
    exportModal = el('div', { class: 'modal-back' },
      el('div', { class: 'modal' }, el('h3', {}, 'Export'), exportBody));
    exportModal.addEventListener('click', (e) => { if (e.target === exportModal) closeExport(); });
    document.body.append(exportModal);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExport(); });
  }
  function openExport() { refreshExport(); exportModal.classList.add('on'); }
  function closeExport() { if (exportModal) exportModal.classList.remove('on'); }

  function buildPartCard() {
    partCard = el('div', { class: 'pcard' });
    document.getElementById('stage').append(partCard);
    partsList = el('div');          // kept so refreshParts has somewhere to write
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pinnedPart) { pinnedPart = null; showPartCard(null); }
    });
  }

  function movePartCard(clientX, clientY) {
    if (!partCard || pinnedPart) return;
    const st = document.getElementById('stage').getBoundingClientRect();
    const w = 236, pad = 14;
    let x = clientX - st.left + 18, y = clientY - st.top + 14;
    if (x + w + pad > st.width) x = clientX - st.left - w - 18;
    if (y + partCard.offsetHeight + pad > st.height) y = Math.max(pad, st.height - partCard.offsetHeight - pad);
    partCard.style.left = Math.max(pad, x) + 'px';
    partCard.style.top = Math.max(pad, y) + 'px';
  }

  /**
   * A live 3D view of the part in its own little scene.
   *
   * A flat footprint rectangle told you how much plate it eats and nothing
   * about what it IS - which is the one question you have while pointing at an
   * unfamiliar lump. One renderer and one scene are reused for every card; the
   * part's geometry is borrowed, never cloned, so hovering a 400k-triangle
   * wheel part costs a camera move rather than a copy.
   */
  var pv = null;
  function partPreview() {
    if (pv) return pv;
    const W = 210, H = 158;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    // updateStyle TRUE: without it the canvas keeps its device-pixel attribute
    // size as its CSS size, and on a 2x display the preview renders twice as
    // tall as the card it sits in and spills across the stage.
    renderer.setSize(W, H, true);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.cursor = 'grab';
    renderer.domElement.style.touchAction = 'none';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, W / H, 0.5, 100000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa2a8, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, -1.4, 2);
    scene.add(key);
    const holder = new THREE.Group();        // spun by the drag
    scene.add(holder);
    const plate = new THREE.Group();          // build volume, for scale
    const part = new THREE.Group();
    holder.add(plate, part);
    pv = { renderer, scene, camera, holder, plate, part, yaw: Math.PI / 5, pitch: -Math.PI / 2.6, radius: 1 };

    // Drag to orbit, the same gesture as the main stage. The card only takes
    // pointer events once pinned, so this is reachable exactly when the card is
    // meant to be interactive.
    let drag = null;
    const cv = renderer.domElement;
    cv.addEventListener('pointerdown', (e) => {
      drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId);
      cv.style.cursor = 'grabbing'; e.stopPropagation();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      e.stopPropagation();
      pv.yaw += (e.clientX - drag[0]) * 0.011;
      pv.pitch += (e.clientY - drag[1]) * 0.011;
      pv.pitch = Math.max(-Math.PI + 0.05, Math.min(-0.05, pv.pitch));
      drag = [e.clientX, e.clientY];
      drawPreview();
    });
    const stop = (e) => { if (drag) { drag = null; cv.style.cursor = 'grab'; e.stopPropagation(); } };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      pv.radius *= e.deltaY > 0 ? 1.08 : 0.93;
      pv.radius = Math.max(0.35, Math.min(3, pv.radius));
      drawPreview();
    }, { passive: false });
    return pv;
  }

  function drawPreview() {
    if (!pv || !pv.frame) return;
    pv.holder.rotation.set(pv.pitch, 0, pv.yaw);
    pv.camera.position.set(0, 0, pv.frame * pv.radius);
    pv.camera.lookAt(0, 0, 0);
    pv.renderer.render(pv.scene, pv.camera);
  }

  /**
   * The part, in the build volume it has to print in.
   *
   * Showing the piece alone told you its shape and nothing about whether it is
   * a thumbnail or fills the machine - and "will this print" is the question
   * the card exists to answer. Drawing the plate around it makes the scale
   * self-evident, and the same drag as the main stage lets you look under it.
   */
  function renderPartPreview(part) {
    const v = partPreview();
    v.part.clear(); v.plate.clear();
    const src = part.mesh;
    if (!src?.geometry) return v.renderer.domElement;

    const bed = state.bed;
    const half = [bed.x / 2, bed.y / 2, bed.z / 2];
    // Build volume: a wire box on a faint floor, centred on the origin.
    const box = new THREE.Box3(
      new THREE.Vector3(-half[0], -half[1], 0), new THREE.Vector3(half[0], half[1], bed.z));
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(bed.x, bed.y, bed.z)),
      new THREE.LineBasicMaterial({ color: 0x2d7cb5, transparent: true, opacity: 0.22 }));
    wire.position.set(0, 0, bed.z / 2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(bed.x, bed.y),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    floor.position.set(0, 0, -0.2);
    v.plate.add(floor, wire);

    // The part, sitting on the plate in its chosen print pose.
    const m = new THREE.Mesh(src.geometry, new THREE.MeshStandardMaterial({
      color: part.color, roughness: 0.6, metalness: 0.04,
    }));
    const pb = new THREE.Box3().setFromBufferAttribute(src.geometry.attributes.position);
    const c = pb.getCenter(new THREE.Vector3());
    m.position.set(-c.x, -c.y, -pb.min.z);
    v.part.add(m);

    // Frame the whole build volume, so every part is drawn at the same scale
    // and a small one looks small.
    const r = new THREE.Vector3(bed.x, bed.y, bed.z).length() / 2;
    v.frame = (r / Math.sin((30 * Math.PI / 180) / 2)) * 0.62;
    // Centre the box vertically so the plate sits in the middle of the frame.
    v.holder.position.set(0, 0, -bed.z / 2);
    drawPreview();
    return v.renderer.domElement;
  }

  function showPartCard(id, clientX, clientY) {
    if (!partCard) return;
    const part = id && state.parts.find((p) => p.id === id);
    if (!part) { partCard.classList.remove('on', 'pin'); hoverPart = null; return; }
    hoverPart = id;
    const o = part.orientation;
    const sz = part.summary?.size;
    const bed = [state.bed.x, state.bed.y, state.bed.z].sort((a, b) => a - b);
    const fits = sz && sz.slice().sort((a, b) => a - b).every((d, i) => d <= bed[i] + 1e-6);
    const mySeams = (state.seams || []).filter((sm) => sm.aPartId === part.id || sm.bPartId === part.id);
    const jointed = mySeams.filter((sm) => sm.placement).length;
    const rows = [
      ['Size', sz ? fmtSize(sz) : '-'],
      ['Volume', part.volume ? `${(part.volume / 1000).toFixed(1)} cm3` : '-'],
      ['Triangles', part.summary ? String(part.summary.triCount) : '-'],
      ['Fits plate', fits ? 'yes' : 'NO'],
    ];
    if (o) {
      rows.push(['Best up', o.up.map((v) => (Math.abs(v) < 1e-6 ? 0 : +v.toFixed(2))).join(', ')]);
      rows.push(['Support', o.needsSupport ? `${o.unsupportedMm2.toFixed(0)} mm2` : 'none']);
    }
    rows.push(['Seams', mySeams.length ? `${jointed} of ${mySeams.length} jointed` : 'none']);

    partCard.innerHTML = '';
    partCard.append(
      el('div', { class: 'pc-h' },
        el('span', { class: 'sw', style: `background:#${part.color.toString(16).padStart(6, '0')}` }),
        el('span', { class: 'nm' }, part.name),
        el('span', { class: 'pin-b' }, pinnedPart === id ? 'pinned · esc' : '')),
      ...rows.map(([k, v]) => el('div', { class: 'pc-r' }, el('span', {}, k), el('span', {}, v))),
    );
    const shot = renderPartPreview(part);
    if (shot) partCard.append(el('div', { class: 'pc-plate' }, shot));
    if (mySeams.length) {
      const sec = el('div', { class: 'pc-sec' });
      for (const sm of mySeams.slice(0, 6)) {
        const other = state.parts.find((q) => q.id === (sm.aPartId === part.id ? sm.bPartId : sm.aPartId));
        sec.append(el('div', { class: 'pc-r' },
          el('span', {}, other?.name ?? 'seam'),
          el('span', {}, sm.placement
            ? (sm.placement.profiled ? `${sm.placement.grip.toFixed(1)} mm grip` : `${sm.placement.S} mm snap`)
            : 'glue')));
      }
      partCard.append(sec);
    }
    if (pinnedPart === id) {
      // Never let a card section take the whole card down with it: the pin
      // state is applied below, and a throw here used to skip it, leaving a
      // card that says "pinned" and is not.
      try {
        const orow = orientationRows(part);
        if (orow) partCard.append(orow);
      } catch (e) { console.error('orientation rows', e); }
    }
    partCard.classList.add('on');
    partCard.classList.toggle('pin', pinnedPart === id);
    if (clientX != null) movePartCard(clientX, clientY);
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

  /**
   * How good is this split, in the two terms that actually matter?
   *
   * STRENGTH is about where the seams landed. A seam is only as good as the
   * joint it can hold, and a joint is only as good as the face it is cut in -
   * so the honest measure is how much of the total seam area is jointed rather
   * than glued, and how much grip those joints have. A split that cuts a model
   * into printable pieces through its thinnest, most awkward sections is a
   * worse split than one that takes the same pieces through fat material, even
   * though both "work".
   *
   * SIMPLICITY is about what you then have to print. Fewer distinct shapes
   * beats fewer parts - eight copies of one bracket is a simpler print job
   * than five different ones - and parts should be as big as the bed allows,
   * because every extra part is another seam to glue and another chance to
   * mis-assemble. Plate use says whether the pieces are near that ceiling or
   * timidly small.
   */
  function splitQuality() {
    const parts = state.parts, seams = state.seams || [];
    if (!parts.length) return null;
    const bed = state.bed;
    const bedVol = bed.x * bed.y * bed.z;

    // --- simplicity
    const sig = (p) => {
      const d = p.summary.size.slice().sort((a, b) => a - b).map((v) => v.toFixed(1));
      return `${(p.volume / 100).toFixed(0)}|${d.join('x')}`;
    };
    const shapes = new Map();
    for (const p of parts) shapes.set(sig(p), (shapes.get(sig(p)) || 0) + 1);
    const distinct = shapes.size;
    const biggest = Math.max(...parts.map((p) => p.summary.size[0] * p.summary.size[1] * p.summary.size[2]));
    const plateUse = Math.min(1, biggest / bedVol);
    const reuse = 1 - (distinct - 1) / Math.max(1, parts.length - 1);   // 1 = all identical

    // --- strength
    const faceArea = (sm) => {
      const a = sm.a?.bbox, b = sm.b?.bbox, n = sm.plane.n;
      if (!a) return 0;
      let area = 1;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(n[k]) > 0.5) continue;
        const lo = Math.max(a.min[k], b.min[k]), hi = Math.min(a.max[k], b.max[k]);
        area *= Math.max(0, hi - lo);
      }
      return area;
    };
    // A stamped snap and a profiled tab are not measured in the same units - one
    // is a joint SIZE on a face big enough to host it, the other is millimetres
    // of undercut. Averaging them gave "mean grip 25.0 mm" for a 25 mm boss,
    // which reads as a joint six times stronger than any tab can be. Score each
    // on its own terms: a stamped joint only exists at all when the face can
    // carry it, so it is full marks; a tab is graded on its undercut, where
    // 3 mm is one you can feel.
    let total = 0, jointedArea = 0, qualSum = 0, gripSum = 0, gripArea = 0;
    for (const sm of seams) {
      const A = faceArea(sm);
      total += A;
      if (!sm.placement) continue;
      jointedArea += A;
      if (sm.placement.profiled) {
        qualSum += Math.min(1, sm.placement.grip / 3) * A;
        gripSum += sm.placement.grip * A; gripArea += A;
      } else {
        qualSum += A;
      }
    }
    const jointedFrac = total ? jointedArea / total : 0;
    const meanGrip = gripArea ? gripSum / gripArea : null;
    const strength = total ? qualSum / total : 0;

    return {
      parts: parts.length, distinct, reuse, plateUse, jointedFrac, meanGrip,
      seams: seams.length, jointed: seams.filter((sm) => sm.placement).length,
      strengthPct: Math.round(strength * 100),
      simplicityPct: Math.round((0.6 * reuse + 0.4 * plateUse) * 100),
    };
  }

  /**
   * The alternative splits, when the search found more than one that works.
   *
   * Presenting a single plan implies it is THE answer; it is one point on a
   * trade-off. Simplest gives the fewest, most repeated, biggest pieces.
   * Strongest puts the seams where joints can actually hold. Balanced is the
   * best compromise, and is what runs by default.
   */
  function refreshPlanOptions() {
    if (!planOptCard) return;
    planOptCard.innerHTML = '';
    const opts = state.planOptions;
    if (!opts) return;
    planOptCard.append(el('div', { class: 'card-t', style: 'margin-top:2px' }, 'Alternative splits'));
    for (const o of opts) {
      const active = state.planChoice ? state.planChoice === o.label : o.label === (state.plan?.chosen || 'balanced');
      const row = el('div', { class: 'pc-r', style: 'cursor:pointer;padding:3px 0' + (active ? ';color:#2d7cb5' : '') },
        el('span', { style: active ? 'color:#2d7cb5;font-weight:700' : '' }, (active ? '\u25cf ' : '') + o.label),
        el('span', {}, `${o.pieces} parts \u00b7 ${o.distinct} shapes \u00b7 S${o.strength} \u00b7 P${o.simplicity}`));
      row.addEventListener('click', async () => {
        if (active) return;
        state.planChoice = o.label;
        try {
          setProgress(0.35);
          await executePlan({ ...state.plan, planes: o.planes });
          say(`Switched to the ${o.label} split: ${state.parts.length} parts.`);
          setProgress(1);
        } catch (e) { setProgress(0); say(e.message, true, 7000); }
      });
      planOptCard.append(row);
    }
  }

  function refreshQuality() {
    if (!qualityCard) return;
    qualityCard.innerHTML = '';
    const q = splitQuality();
    if (!q) return;
    const bar = (label, pct, hint) => el('div', { style: 'margin-top:6px' },
      el('div', { class: 'pc-r' }, el('span', {}, label), el('span', {}, `${pct}%`)),
      el('div', { style: 'height:4px;border-radius:3px;background:rgba(0,0,0,.08);overflow:hidden;margin-top:2px' },
        el('div', { style: `height:100%;width:${pct}%;background:${pct >= 66 ? '#4d9e5f' : pct >= 33 ? '#c9a227' : '#c0392b'}` })),
      el('div', { class: 'note', style: 'margin-top:3px' }, hint));
    qualityCard.append(
      el('div', { class: 'card-t', style: 'margin-top:2px' }, 'Split quality'),
      bar('Strength', q.strengthPct,
        `${q.jointed} of ${q.seams} seams jointed, ${Math.round(q.jointedFrac * 100)}% of seam area`
        + (q.meanGrip != null ? `, mean undercut ${q.meanGrip.toFixed(2)} mm.` : '.')),
      bar('Simplicity', q.simplicityPct,
        `${q.parts} parts of ${q.distinct} distinct shape${q.distinct === 1 ? '' : 's'}; largest fills ${Math.round(q.plateUse * 100)}% of the build volume.`));
  }

  function refreshJoints() {
    if (!jointsCard) return;
    jointsCard.innerHTML = '';
    const seamCount = (state.seams || []).length;
    if (!state.joints.length && !seamCount) return;
    jointsCard.append(el('div', { class: 'card-t', style: 'margin-top:2px' }, 'Seams ',
      el('span', { class: 'n' }, `${state.joints.length}/${seamCount}`)));
    for (const j of state.joints) {
      const a = state.parts.find((p) => p.id === j.aPartId), b = state.parts.find((p) => p.id === j.bPartId);
      const male = j.maleOn === 'A' ? a : b;
      // A profiled joint is the cut, so there is no stamped solid to swap sides
      // and no containment to audit. What matters about it is the grip.
      if (j.kind === 'profiled') {
        jointsCard.append(el('div', { class: 'row', style: 'min-height:22px' },
          el('span', { class: 'lbl w' }, `${j.type} ${j.grip.toFixed(1)} mm`),
          el('span', { style: 'flex:1;font-size:10px;color:rgba(0,0,0,.5)' },
            `${a?.name ?? '?'} ↔ ${b?.name ?? '?'} · cut joint in ${j.width.toFixed(1)} mm stock`)));
        continue;
      }
      const ok = j.audit?.ok;
      jointsCard.append(el('div', { class: 'row', style: 'min-height:22px' },
        el('span', { class: 'lbl w' }, `${j.S} mm ×${j.sites.length}`),
        el('span', { style: 'flex:1;font-size:10px;color:rgba(0,0,0,.5)' },
          `${a?.name ?? '?'} ↔ ${b?.name ?? '?'} · male on ${male?.name ?? '?'}`),
        ok === false ? el('span', { class: 'warn', title: 'containment audit failed' }, '▲') : null,
        button('Swap', () => swapJoint(j), 'g sm')));
    }
    // Seams that took no joint are still seams. Listing them - with the reason
    // the placement gave up - is the difference between "the tool found two
    // joints" and "the tool found four seams and could only joint two of them,
    // here is why".
    for (const s of (state.seams || [])) {
      if (s.placement) continue;
      const a = state.parts.find((p) => p.id === s.aPartId), b = state.parts.find((p) => p.id === s.bPartId);
      jointsCard.append(el('div', { class: 'row', style: 'min-height:22px;align-items:flex-start' },
        el('span', { class: 'lbl w', style: 'color:rgba(0,0,0,.35)' }, 'plain'),
        el('span', { style: 'flex:1;font-size:10px;color:rgba(0,0,0,.5)' },
          `${a?.name ?? '?'} ↔ ${b?.name ?? '?'} · glue seam`,
          s.why ? el('div', { style: 'font-size:9px;color:rgba(0,0,0,.32);margin-top:2px;line-height:1.4' }, s.why) : null)));
    }
    jointsCard.append(el('div', { class: 'note' },
      'Ghost view shows every joint inside its part - amber male, violet female. Swap re-runs the split with the halves exchanged.'));
  }

  async function swapJoint(j) {
    if (!state.plan) return;
    state.plan.swaps = state.plan.swaps || {};
    // Keyed by seam, not by plane: one plane can carry several independent
    // seams and swapping one of them must not flip the others.
    state.plan.swaps[j.seamKey] = !state.plan.swaps[j.seamKey];
    say('Re-cutting with the joint swapped…');
    await reexecute();
  }

  async function reexecute() {
    // executePlan tears down the previous parts itself.
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
    pinnedPart = pinnedPart === id ? null : id;
    showPartCard(pinnedPart || id);
    state.selected = state.selected === id ? null : id;
    refreshParts();
    refreshSelected();
  }

  /**
   * The pinned part's card is where "selected part" lives now. Keeping the old
   * name means every caller that used to poke the right panel still works.
   */
  function refreshSelected() {
    const id = pinnedPart || state.selected;
    if (id && state.parts.some((p) => p.id === id)) showPartCard(id);
    else if (partCard) partCard.classList.remove('on', 'pin');
  }

  const ordinal = (i) => ['Best', '2nd', '3rd', '4th', '5th'][i] || `${i + 1}th`;

  /** Print-pose chooser, appended to the part card when it is pinned. */
  function orientationRows(part) {
    if (!part.orientCands?.length) return null;
    const box = el('div', { class: 'pc-sec' },
      el('div', { class: 'card-t', style: 'margin-bottom:5px' }, 'Print orientation'));
    for (const [i, cand] of part.orientCands.entries()) {
      const chosen = part.orientation === cand;
      const r = el('div', { class: 'pc-r', style: 'cursor:pointer' + (chosen ? ';color:#2d7cb5' : '') },
        el('span', { style: chosen ? 'color:#2d7cb5;font-weight:700' : '' }, (chosen ? '\u25cf ' : '') + ordinal(i)),
        el('span', {}, `${cand.unsupportedMm2 <= 4 ? 'no supports' : `${Math.round(cand.unsupportedMm2)} mm\u00b2`} \u00b7 h ${cand.height}`));
      r.addEventListener('click', (e) => {
        e.stopPropagation();
        part.orientation = cand;
        state.plates = [];               // the arrangement is stale now
        showPartCard(part.id); refreshParts(); refreshExport();
      });
      box.append(r);
    }
    return box;
  }
  function refreshExport() {
    if (!exportBody) return;
    exportBody.innerHTML = '';
    if (exportBtn) exportBtn.disabled = !state.parts.length;
    if (!state.plates.length) {
      exportBody.append(el('div', { class: 'empty' }, 'Arrange first, then export.'));
      return;
    }
    const sel = { plate3mf: true, plateStl: false, partStls: false, zip: state.plates.length > 1 };
    exportBody.append(
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
  // A click is a click only if the pointer barely moved - otherwise it was an
  // orbit drag and placing a cut mid-orbit would drive anyone mad.
  let downAt = null;
  function pickPart(e) {
    if (!state.parts.length) return null;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, stage.camera);
    const meshes = state.parts.map((p) => p.mesh).filter((m) => m.visible);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    return state.parts.find((p) => p.mesh === hits[0].object)?.id ?? null;
  }

  stage.renderer.domElement.addEventListener('pointermove', (e) => {
    if (pinnedPart) return;
    const hit = pickPart(e);
    if (hit !== hoverPart) showPartCard(hit, e.clientX, e.clientY);
    else if (hit) movePartCard(e.clientX, e.clientY);
  });
  stage.renderer.domElement.addEventListener('pointerleave', () => { if (!pinnedPart) showPartCard(null); });

  stage.renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button === 0) downAt = [e.clientX, e.clientY];
  });
  stage.renderer.domElement.addEventListener('pointerup', async (e) => {
    if (e.button !== 0 || !downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 5) return;

    const rect = stage.renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, stage.camera);

    if (state.parts.length) {
      const meshes = state.parts.map((p) => p.mesh).filter((m) => m.visible);
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length) {
        const part = state.parts.find((p) => p.mesh === hits[0].object);
        if (part) selectPart(part.id);
      }
      return;
    }

    // Before a split, in cut mode, clicking the model snaps a cut to what was
    // clicked: a flat face gives a cut in that face's plane, a bore gives a cut
    // square to its axis through the click point. This is where the
    // clean-geometry analysis pays off - the click hits a FEATURE, not a
    // triangle.
    if (!state.model || !state.cutMode) return;
    const m = state.model;
    const off = state.modelOffset || new THREE.Vector3();
    const origin = raycaster.ray.origin.clone().sub(off);
    const dir = raycaster.ray.direction;
    const hit = await geom.call('geom.pick', {
      id: m.geomId, origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z],
    }).catch(() => null);
    if (!hit) return;
    if (hit.kind === 'plane') {
      // A cut exactly in an OUTER face's plane is a zero-thickness slice - the
      // click means "cut in this direction", so when the face is the model's
      // skin, start the cut mid-model along that normal instead. A shoulder or
      // step face inside the extent is kept exactly where it is.
      let d = -hit.d;
      const ext = extentAlongModel(hit.n);
      if (d - ext.lo < 1 || ext.hi - d < 1) {
        d = (ext.lo + ext.hi) / 2;
        say('That face is the outer skin, so the cut starts mid-model in its plane direction. Slide it where you want it.');
      } else {
        say('Cut added in the plane of that face. Slide it in the Cuts card, then Split.');
      }
      addManualPlane(hit.n, d, hit.point);
    } else {
      const d = hit.axis[0] * hit.point[0] + hit.axis[1] * hit.point[1] + hit.axis[2] * hit.point[2];
      addManualPlane(hit.axis, d, hit.point);
      say("Cut added square to that bore's axis.");
    }
  });

  function addManualPlane(n, d, point) {
    const size = state.model ? state.model.summary.diag * 0.8 : 200;
    const helper = new THREE.Group();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)),
      new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.5 }));
    helper.add(quad, outline);
    helper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), V3(n));
    const off = state.modelOffset || new THREE.Vector3();
    const place = (dd) => {
      // Keep the quad centred near the click, but ON the plane n.x = dd.
      const p = V3(point);
      const slide = dd - (n[0] * point[0] + n[1] * point[1] + n[2] * point[2]);
      p.add(V3(n).multiplyScalar(slide));
      helper.position.copy(p).add(off);
    };
    place(d);
    stage.world.add(helper);
    const entry = { n: [...n], d, d0: d, point: [...point], helper, place };
    state.manualPlanes.push(entry);
    refreshCuts();
  }

  function extentAlongModel(n) {
    const b = state.model.summary.bbox;
    let lo = Infinity, hi = -Infinity;
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
      const h = x * n[0] + y * n[1] + z * n[2];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return { lo, hi };
  }

  function removeManualPlane(entry) {
    stage.world.remove(entry.helper);
    disposeGroup(entry.helper);
    state.manualPlanes = state.manualPlanes.filter((p) => p !== entry);
    refreshCuts();
  }

  // ---------------------------------------------------------------- misc math
  const IDENT16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const avg = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]);
  const boxVol = (b) => Math.max(1, (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  say('Ready. Import an STL to begin.');

  // A named handle for tests and for poking at the tool from the console. It
  // lives behind the gate, so it exposes nothing the page does not already hold.
  window.__pp = { state, geom, csg, stage, autoSplit, symmetricSplit, arrange, addManualPlane, importSTL, setView, openExport, makeSymmetric,
    get pinned() { return pinnedPart; }, showPartCard, splitQuality };
}
