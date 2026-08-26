# Joint port reference

`evf_joint.json` is ground truth for `src/csg/joint.js`, produced by running the
original `evf_joint.py` (trimesh + the manifold3d engine) under Python and
recording, for five face sizes, both halves' volume, surface area, bounding box
and the full six-direction `check_joint` audit.

The JavaScript port is not a reimplementation - it drives the same manifold
kernel through the same sequence of hulls and booleans - so the standard it is
held to is equality, not similarity. `joint.test.mjs` asserts a relative
tolerance of 1e-5 on volume and area, 1e-4 mm absolute on the bounding box, and
exact agreement on the printability audit.

Measured agreement at the time of the port: volume and area within 5e-8
relative across all five sizes and both halves, bounding boxes identical, and
the audit reporting 0.00 mm2 unsupported, 0.36 mm2 bridged and 0.0 degrees worst
overhang on both sides in all six build directions - matching Python exactly,
from an independently written audit.

To regenerate after changing the Python:

    python3 -c "
    import json, numpy as np
    from evf_joint import make_joint, params, check_joint
    out = {}
    for S in (12.0, 16.0, 20.0, 25.0, 30.0):
        male, female = make_joint(S)
        rec = lambda m: dict(volume=round(float(m.volume),6), area=round(float(m.area),6),
                             bmin=[round(float(x),6) for x in m.bounds[0]],
                             bmax=[round(float(x),6) for x in m.bounds[1]],
                             **{k: v for k, v in check_joint(m).items()
                                if k in ('unsupported_mm2','worst_overhang_deg','bridged_mm2')})
        out[str(S)] = dict(male=rec(male), female=rec(female))
    print(json.dumps(out))
    "

then rename `unsupported_mm2`/`worst_overhang_deg`/`bridged_mm2` to
`unsupported`/`worst`/`bridged` and fold in the `params()` dict.
