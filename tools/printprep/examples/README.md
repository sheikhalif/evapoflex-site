# Demo models

Four analytic STLs for exercising Print Prep. Each is here because it breaks the
tool in a different way, and each of those ways was a real bug once.

| File | What it is | What it exercises |
|---|---|---|
| `demo-wheel.stl` | Ø480 x 50 spoked wheel: rim, web, hub, bore, 8 lightening holes | Oversize on **two** axes at once. Splits into four quadrants with snap joints in the hub - the only place the solid-depth field allows one. |
| `demo-panel.stl` | 520 x 400 x 24 plate, 24 bores | Needs cuts on both axes and produces grandchild pieces, whose sections are open shells - the case that forces every measurement through the closed root solid. |
| `demo-bracket.stl` | 380 x 160 x 90 L-bracket, 4 bores | The clean case: one cut, one joint, five ranked orientations per part. Fastest way to see the whole flow. |
| `demo-tube.stl` | 620 long, Ø60, 4 mm wall | A section too thin for any joint. Must degrade to honest glue seams rather than refusing to split or lying about fitting. |

Drop any of them on the tool, or use Import STL.

Regenerate them from `tools/printprep/examples/generate.mjs` if the shapes ever
need to change; they are built with the same manifold kernel the tool uses, so
they are watertight and consistently wound by construction.
