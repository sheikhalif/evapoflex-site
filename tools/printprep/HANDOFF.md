# Print Prep — handoff

State of the work on branch `printprep-thin-stock-joints` (commits `7483a59`,
`fe081cf`, `<this one>`). Not pushed; `main` is untouched.

---

## Read this first

**`printprep.html` is stale.** There is no Node on this machine, so the shipped
encrypted page still holds the build from before this work. Everything below
lives only in `tools/printprep/src/`. To publish it:

```bash
cd tools/printprep && npm install && npm run build   # needs ../../.printprep-password
```

**To run it without building or knowing the gate password**, there is a demo
shell that imports the sources unbundled:

```bash
python3 printprep-demo/serve.py 8124
# then open http://localhost:8124/printprep-demo/index.html
```

Use that server, **not** `python -m http.server`. Plain `http.server` sends no
cache headers, so the browser treats a module whose Last-Modified is a few hours
old as fresh and never revalidates it. That cost three debugging rounds: a
correct fix to `scene.js` appeared to do nothing because the browser kept
serving the old copy. `serve.py` sends `no-store` and strips `Last-Modified`.

`window.printPrep` exposes `{ state, stage, geom, csg }` in the demo for
console work and automated checks.

---

## What the tool now does that it did not

### Parts are real objects

A cut can leave a piece whose material is in several disjoint lumps — cut the
prongs off a fork and the upper piece is two prongs. That used to be one "part"
with a bounding box spanning the gap between them. Every leaf now goes through
`Manifold.decompose()` (`csg.worker.js`, `csg.decompose`).

Measured on `printprep-demo/fork-bracket-300.stl`:

| | before | after |
|---|---|---|
| parts | 2 — one a phantom `180 × 100 × 152` box | 3 — `50×100×152`, `50×100×152`, `180×100×162` |
| joints | 1, bonding two disconnected lumps | 2, one per prong |

### A joint on every seam

Joints used to be placed per **cut plane** on the planner's proxy pieces. Proxy
pieces are open shells, so the contact region had to be reconstructed by masking
the root against halfspaces, and outer seams quietly came back plain. Placement
now runs per **part pair** on the real post-cut solids (`geom.seamJoints`),
whose sections are simply true.

Quartering a ring went from 2 joints to **4** — one per seam.

A second bug hid inside that: planes at different indices can be the *same
plane in space* (a tree cuts each half of a quartered ring at y=0 separately).
Excluding keep-out bands by plane index alone let one cut's band cover another's
entire contact face.

Seams that take no joint are now **listed with the reason** ("the widest clear
spot on the face takes only a 1.5 mm joint (needs 12)") instead of being absent.

### Exploded view

Driven by the seam graph, not the joint list — glue seams were non-edges, so
their parts were scattered on a golden angle. A relaxation pass separates any
overlapping non-adjacent pair, so nothing ends up inside anything else.

---

## Bugs the EEDX wheel found

`tools/printprep/samples/EEDX_test_wheel.stl` — 967 × 967 × 10 mm, 412,422
triangles, Rhino export, **exactly watertight** (verified independently).

1. **"Not a clean solid: 8,368 open edges."** `weld()` had an area floor scaled
   to the model diagonal. On a 967 mm part that floor sat *above the mesh's own
   median triangle area* and deleted 6,941 valid faces. Only vertex-identity
   collapses are dropped now — those are topologically safe, since a collapsed
   triangle's two surviving edges cancel.
2. **Weld tolerance** came off the bounding diagonal: 13.7 µm against a mesh
   whose finest edge is 10.3 µm, wrongly merging 192 vertex pairs. It is now
   keyed to the mesh's own finest edge with a float32 noise floor beneath it
   (the model sits 4 m from the origin, where float32 resolves to ~0.5 µm).
3. **The model was invisible.** Fog was hard-coded at 1400–2600 mm; framing a
   967 mm part puts the camera 4.1 m back, so every triangle rendered as
   background colour — model, parts and build volume all gone, nothing in the
   console. Fog and clip planes now follow the framed object. **Anything over
   ~600 mm was affected.**
4. **The planner could not split it** — 6 pieces, 2 of them fitting. See below.

After these: imports as *closed, consistently wound*, all 412,422 triangles.

---

## Planner

Three changes, each of which was necessary and none of which was sufficient
alone:

- **Slab move** — a piece more than twice the bed on an axis is divided into
  equal printable slabs in *one* expansion. Cutting one plane at a time meant a
  4×4 grid needed 15 sequential expansions, each re-clipping a 412k-triangle
  soup, and the budget ran out at 6 pieces.
- **Ranking by cuts made plus a lower bound on cuts remaining.** Two earlier
  rankings were wrong: pure accumulated cost punished the slab move for laying
  three planes at once; counting pieces-that-do-not-fit was worse, because a
  slab move turns one oversize piece into four still-oversize ones while a
  single cut makes two — so the move that advanced the plan always looked like
  the one falling behind.
- **Expansion cap derived from the model** instead of a fixed 16, so a part
  needing 15 cuts can finish.
- No joint protrusion is reserved on stock too thin to host any joint (it was
  shrinking every slab by a quarter on the 10 mm wheel).

Result: **26 parts, all fitting the 256 mm bed, ~25 s.** Ten of those parts
exist only because of the decompose fix.

---

## The wheel's stock, measured

Not 8 solid arms — **16 rails, each 5–6.5 mm wide × 10 mm thick.**

This is the fact that drives every joint decision. The EVF snap joint in
`joint.js` needs ~20 mm of cut face; the largest joint that fits a face on these
rails is **1.5 mm**. All 30 seams of the wheel come back as glue seams. There is
no snap-joint answer on this stock without adding material.

---

## Seam joints (`src/csg/seamJoints.js`)

On thin stock the joint cannot be a boss stamped on a flat face, so **the cut
path itself is the joint** — a profile with a tab, extruded through the full
thickness. Vertical walls everywhere when the part lies flat; the tab's undercut
carries the tension that would otherwise need glue.

- `dovetail`, `puzzle` — parametric on `flankDeg`, `neckRatio`, `sideWall`,
  `reach`, `clearance`
- **auto-boss** — pads the rail locally at the seam, ramping back at 45° *in the
  plane of the sheet* (a vertical wall printed flat, a 45° wall on edge)
- **pillars** — integral posts through the thickness either side of the tab.
  They must be prismatic along the assembly direction: a post pointing along the
  rail could never enter its bore, since that is the motion the tab exists to
  prevent. No pins, no hardware.
- **detents** — diamonds, not spheres, so every face is 45°

Measured on 6 × 10 stock:

| variant | boss | grip | pillars | closed | unsupported flat / inverted / on-edge |
|---|---|---|---|---|---|
| dovetail, bare | — | 0.90 | — | yes | 0 / 0 / 0 |
| dovetail + boss | 18 mm | **3.90** | — | yes | 0 / 0 / 0 |
| dovetail + boss + pillars | 24 mm | 3.02 | 2 × r1.78 @ ±8.4 | yes | 0 / 0 / 0 |
| puzzle + boss + pillars | 24 mm | 2.30 | 2 × r1.78 @ ±8.4 | yes | 0 / 0 / 0 |

The boss is worth **4.3× the grip** — the single biggest lever on this stock.

Detent behaviour, verified against a zero-throughout control with detents off:

| detent | at rest | mid-insertion |
|---|---|---|
| none | 0 | 0 |
| r0.45 | 0 | 0.038 mm³ |
| r0.8 | 0 | 0.42 mm³ |

Clearance at rest, interference on the way in — which is what a snap is.

**Correction worth carrying forward:** a *shallower* dovetail flank is less of
an overhang, not more. 45° is the safe ceiling, not the target; lowering
`flankDeg` buys engagement at no printability cost. The overhang audit caught
this — my reasoning had it backwards.

RPCs: `csg.seamParams`, `csg.seamCoupon` (printable test pairs),
`csg.seamFit` (interference, with `insertZ` to test mid-insertion).

---

## Next steps, in order

1. **Union the boss before the profiled cut.** `csg.splitProfiled` sizes a
   bossed tab but never pads the solid, so a 12 mm tab is currently cut into
   6 mm stock. Small fix, do it first.
2. **Route `executePlan` through `csg.splitProfiled`.** The splitter still calls
   `csg.splitOne`. Until this lands, none of the joint work reaches the wheel.
   Note `csg.splitProfiled` deliberately refuses anything but a sheet in XY with
   an X/Y-aligned seam — a seam the user believes is jointed but is not is the
   worst outcome, so it throws rather than silently cutting on a plane.
3. **Symmetry-aware splitting** — detect rotational order and cut all 16 rails
   identically. Requested explicitly: "this structure is symmetric so there is
   no reason for the axles to be split differently from each other."
4. **Sleeve option** (allowed, optional) and tongue/plane mating features. **No
   pins or dowels** — everything integral to the two mating parts.
5. **UI rebuild.** Decisions already made and recorded:
   - hover previews a part card, **click pins it**, Esc unpins
   - build plate appears **only in Plates view and the hover card**; main stage
     is a CAD void
   - **Export** moves to a top-bar button opening a modal
   - left rail: Actions (auto-split / chamfer / arrange) at top, then Joints
     (mating-feature dropdown, feature preview, fit slider showing mm offset),
     then Print settings, then Printer — all collapsible
   - the whole right panel is absorbed into the per-part hover card

---

## Open item not caused by this work

The containment audit reports ▲ on the fork's joints. It does so on the
pre-existing committed code too, so it predates all of this and was never
investigated.

## Scratch

`printprep-demo/` holds the unbundled dev shell, the no-cache server and four
generated test models (`wheel-rim-420` for ring seams, `fork-bracket-300` for
islands, `bracket-300`, `shaft-coupler-100` for the fits-already path). The
generators live in the session scratchpad, not the repo.
