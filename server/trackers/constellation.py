"""Constellation tracker: many identical markers, matched as a set.

The rig carries four green tapes around the rim plus one on the shaft, with a
cover hiding one tape at a time. Following a single marker cannot work when the
markers are identical and keep disappearing, so rotation is instead whichever
shift best superimposes this frame's set of bearings on the last frame's. Only
one tape needs to be visible in both frames.

Streaming port of wheel_tracker_constellation.py.
"""
from __future__ import annotations

import math
import time

import cv2
import numpy as np

from tracker import KERNEL, ang_diff, _angular_spread
from .base import TrackerBase


DEFAULT_CALIBRATION = {
    # Green tape: four markers spaced around the rim plus one on the shaft.
    "hsv_lo": [35, 70, 60],
    "hsv_hi": [85, 255, 255],
    "center": [0.5, 0.5],      # normalised; overridden by the hub marker
    "radius": 0.35,            # normalised (fraction of width); auto-fitted
    "band_frac": 0.22,         # tolerance around the circle, fraction of radius
    "min_area_frac": 0.00008,  # fraction of frame area
    "max_area_frac": 0.02,
    "auto_hub": True,          # derive centre/radius from the shaft marker
    "merge_tol_deg": 10.0,     # collapse lobes of one tape into one marker
    "match_tol_deg": 3.0,      # consensus tolerance when matching frames
    "max_step_deg": 25.0,      # largest believable rotation between samples
    "reject_static": True,     # ignore green objects that never move
    # Rim tapes needed to accept a sample. The rig carries four with a cover
    # over one, so three are normally in view and the third is spare.
    #
    # Two is a genuine floor, not a compromise: on a clean frame two tapes
    # track to 0.01%, indistinguishable from four. What two cannot do is
    # outvote a stray green object - at three-plus the constellation carries
    # the vote, at two an intruder is a third of it. So two is safe exactly
    # while the frame is clean, and the Fixtures annotation layer is how you
    # confirm that it is.
    #
    # One is refused outright: a lone bearing has no consensus to check
    # against, so a mis-detection would enter the results unchallenged.
    "min_markers": 2,
}

# Streaming equivalent of wheel_tracker_constellation's --reject-static pre-scan
STATIC_WINDOW = 40             # frames examined when classifying
STATIC_PRESENCE = 0.7          # fraction of them a blob must sit still for
STATIC_EPS_FRAC = 0.012        # "same place", as a fraction of frame width
STATIC_MIN_ROTATION = 12.0     # deg the wheel must have turned to judge at all


def merge_close(angles: list[float], tol: float) -> list[float]:
    """Collapse blobs that are really lobes of one tape into one angle."""
    if not angles:
        return []
    a = sorted(angles)
    groups = [[a[0]]]
    for x in a[1:]:
        if x - groups[-1][-1] < tol:
            groups[-1].append(x)
        else:
            groups.append([x])
    if len(groups) > 1 and (groups[0][0] + 360.0 - groups[-1][-1]) < tol:
        groups[0] = groups.pop() + groups[0]
    return [float(np.mean(g)) % 360.0 for g in groups]


def best_shift(prev: list[float], cur: list[float], max_step: float,
               tol: float) -> tuple[float | None, int]:
    """Rotation from `prev` to `cur` by consensus over marker pairings.

    Ported from wheel_tracker_constellation.best_shift. Every pairing of a
    previous marker with a current one proposes a delta; the delta supported by
    the most markers wins and is refined to the mean of its inliers. Only ONE
    marker needs to be visible in both frames, so a tape passing behind the
    cover costs nothing.

    Returns (delta_degrees, n_inliers), or (None, 0) if nothing agrees.
    """
    best_d, best_n = None, 0
    for a in prev:
        for b in cur:
            d = ang_diff(b, a)
            if abs(d) > max_step:
                continue
            res = [r for x in prev for y in cur
                   if abs(r := ang_diff(ang_diff(y, x), d)) <= tol]
            if len(res) > best_n:
                best_d, best_n = d + float(np.mean(res)), len(res)
    return best_d, best_n


def identify_hub(blobs: list[tuple[float, float, float]]
                 ) -> tuple[int, float, float, float] | None:
    """Pick which blob is the shaft marker, and fit the rim circle to the rest.

    The rim tapes all sit the same distance from the shaft, so the true hub is
    the blob that the most others are equidistant from. This finds the wheel
    centre without it being known in advance, so the rig never needs to be
    hand-calibrated and a bumped camera re-fits itself on the next frame.

    Consensus rather than overall spread: any other green object in shot - a
    fixture, a reflection, a bit of tape on the frame - is one more distance in
    the list, and averaging over it dragged the score past any fixed threshold
    and rejected the true hub outright. Counting how many distances agree
    ignores the strays instead.

    Returns (hub_index, cx, cy, radius) or None if there is nothing to fit.
    """
    n = len(blobs)
    if n < 3:                      # need a hub plus at least two rim markers
        return None
    best = None            # (inliers, angular_spread, -radial_spread, ...)
    for i in range(n):
        hx, hy, _ = blobs[i]
        others = [(bx, by) for j, (bx, by, _) in enumerate(blobs) if j != i]
        dists = [math.hypot(bx - hx, by - hy) for bx, by in others]
        for ref in dists:
            if ref <= 1e-6:
                continue
            keep = [(d, p) for d, p in zip(dists, others)
                    if abs(d - ref) <= 0.15 * ref]
            if len(keep) < 2:
                continue
            radius = float(np.mean([d for d, _p in keep]))
            radial_spread = float(np.std([d for d, _p in keep])) / radius
            # Equidistance alone does not identify the hub: with four tapes at
            # 90 degrees, every tape sees its two neighbours at the same
            # distance (R*sqrt2) and scores as well as the centre does. What
            # separates them is that the tapes surround the hub, whereas from
            # a tape they all lie to one side.
            spread = _angular_spread([math.atan2(py - hy, px - hx)
                                      for _d, (px, py) in keep])
            cand = (len(keep), spread, -radial_spread, i, hx, hy, radius)
            if best is None or cand[:3] > best[:3]:
                best = cand
    if best is None:
        return None
    _n, _as, _rs, idx, hx, hy, radius = best
    return idx, hx, hy, radius


def fit_circle(points: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Kasa algebraic circle fit. Returns (cx, cy, r)."""
    pts = np.asarray(points, dtype=float)
    x, y = pts[:, 0], pts[:, 1]
    a = np.column_stack([x, y, np.ones(len(pts))])
    b = x ** 2 + y ** 2
    sol, *_ = np.linalg.lstsq(a, b, rcond=None)
    cx = sol[0] / 2.0
    cy = sol[1] / 2.0
    r = math.sqrt(max(sol[2] + cx ** 2 + cy ** 2, 0.0))
    return cx, cy, r


# ---------------------------------------------------------------------------
# Tracker
# ---------------------------------------------------------------------------
class ConstellationTracker(TrackerBase):
    NAME = "constellation"
    LABEL = "Constellation (rim tapes + shaft hub)"
    DESCRIPTION = ("Matches the whole set of markers between frames, so an "
                   "occluded tape costs nothing. Derives the wheel centre "
                   "from the stationary shaft marker.")
    EXPECTS = "4 green rim tapes (one may be hidden) + 1 green shaft tape"
    DEFAULT_CALIBRATION = DEFAULT_CALIBRATION

    def reset_algorithm(self) -> None:
        """Clear per-frame continuity and everything learned from the scene."""
        self.prev_angle = None
        # Drop the previous constellation: matching across a gap would read
        # the rotation that happened during it as a single step.
        self.prev_angles = None
        self.vel = 0.0
        self.hub_px = None           # last good wheel centre, pixels
        self.radius_px = 0.0
        self.static_points: list[tuple[float, float]] = []
        # (blob positions, unwrapped angle) per frame, for fixture detection
        self._pos_history: list[tuple[list[tuple[float, float]], float]] = []

    def process(self, frame: np.ndarray, t: float) -> dict:
        """Track one frame. Returns an overlay/status dict (never raises).

        Four rim tapes plus one on the shaft. The shaft tape gives the centre,
        the rim tapes give a set of bearings, and the rotation between frames
        is whichever shift best superimposes this frame's set on the last -
        so a tape disappearing behind the cover costs nothing as long as one
        other stays visible.
        """
        self.frame_num += 1
        h, w = frame.shape[:2]
        cal = self.calibration
        frame_area = float(w * h)

        blobs = self._find_blobs(frame, np.array(cal["hsv_lo"]),
                                 np.array(cal["hsv_hi"]),
                                 cal["min_area_frac"] * frame_area,
                                 cal["max_area_frac"] * frame_area)

        overlay = {"frame_num": self.frame_num, "blobs": len(blobs),
                   "t": round(t, 3)}

        use_static = cal.get("reject_static", True)
        if use_static:
            self._update_static(blobs, w, h)
        statics, movers = self._split_static(blobs, w, h) if use_static \
            else ([], blobs)

        hub = None
        hub_source = None
        if cal.get("auto_hub", True):
            # The shaft marker sits on the axis, so it is the one green thing
            # that never moves while the wheel turns. Preferring a known-static
            # blob is far more reliable than single-frame geometry: with four
            # tapes at 90 degrees, a rim tape sees its neighbours at equal
            # distances and repeatedly won the "which blob is the centre"
            # contest, throwing away the frame.
            if statics and len(movers) >= 2:
                mx = float(np.mean([b[0] for b in movers]))
                my = float(np.mean([b[1] for b in movers]))
                hx, hy, _a = min(statics,
                                 key=lambda b: math.hypot(b[0] - mx, b[1] - my))
                dists = [math.hypot(b[0] - hx, b[1] - hy) for b in movers]
                ref = float(np.median(dists))
                keep = [d for d in dists if abs(d - ref) <= 0.25 * ref]
                # Being the nearest stationary blob is not enough to be the
                # hub. With the shaft tape out of view the only stationary
                # thing left may be a fixture, and adopting that as the centre
                # throws the whole rim off.
                #
                # "Some movers are equidistant" is too weak a test: markers at
                # 90 degrees mean any external point sees a symmetric PAIR of
                # them at identical distance, so a fixture passes on a
                # coincidence. Demand that nearly all of them agree - true of
                # the axis, false of anything off it.
                need = max(2, math.ceil(0.75 * len(movers)))
                if len(keep) >= need:
                    radius = float(np.mean(keep))
                    if radius > 1e-6 and float(np.std(keep)) / radius <= 0.12:
                        hub = (None, hx, hy, radius)
                        hub_source = "shaft marker"
            if hub is None:
                # No trustworthy stationary marker. The tapes still sweep a
                # circle centred on the axis, so fit one to where they have
                # been - this recovers the centre with the shaft tape missing
                # entirely (fallen off, or hidden by the wheel structure),
                # which single-frame geometry cannot do because on those
                # frames no blob in shot IS the centre.
                hub = self._hub_from_orbit(w, h, len(movers))
                if hub is not None:
                    hub_source = "orbit fit (no shaft marker)"
            if hub is None:
                geo = identify_hub(blobs)
                if geo is not None:
                    idx, gx, gy, grad = geo
                    hub = (idx, gx, gy, grad)
                    hub_source = "geometry (weak)"

        if hub is not None:
            idx, cx, cy, radius = hub
            self.hub_px = (cx, cy)
            self.radius_px = radius
            rim = movers if idx is None else [
                b for j, b in enumerate(blobs) if j != idx]
            overlay["hub_source"] = hub_source or "shaft marker"
        else:
            # Shaft tape not visible this frame - fall back to the last good
            # geometry, or to the manual calibration if we never had one.
            if self.hub_px is None:
                self.hub_px = (cal["center"][0] * w, cal["center"][1] * h)
                self.radius_px = cal["radius"] * w
            cx, cy = self.hub_px
            radius = self.radius_px
            rim = blobs
            overlay["hub_source"] = "last known"

        band = max(cal["band_frac"] * radius, 8.0)

        # Anything static that is not the hub is a fixture - a bracket, a
        # reflection, tape on the frame. Left in, it pulls the frame-to-frame
        # match toward zero rotation and the wheel reads slower than it turns
        # (measured 7.9% low with one such blob in shot).
        accepted, rejected = [], []
        rejected_static = [(sx, sy) for sx, sy, _a in statics
                           if math.hypot(sx - cx, sy - cy) > 1e-6] \
            if use_static else []
        for bx, by, area in rim:
            d = math.hypot(bx - cx, by - cy)
            if abs(d - radius) > band:
                rejected.append((bx, by))
                continue
            accepted.append((math.degrees(math.atan2(-(by - cy), bx - cx))
                             % 360.0, bx, by))

        angles = merge_close([a for a, _x, _y in accepted],
                             cal.get("merge_tol_deg", 10.0))

        overlay.update({
            "hub": [round(cx / w, 5), round(cy / h, 5)],
            "radius": round(radius / w, 5),
            "band": round(band / w, 5),
            "markers": [[round(bx / w, 5), round(by / h, 5), round(a, 1)]
                        for a, bx, by in accepted],
            "rejected": [[round(bx / w, 5), round(by / h, 5)]
                         for bx, by in rejected],
            "static": [[round(bx / w, 5), round(by / h, 5)]
                       for bx, by in rejected_static],
            "n_markers": len(angles),
        })

        min_markers = max(int(cal.get("min_markers", 2)), 2)
        overlay["spare_markers"] = max(len(angles) - min_markers, 0)

        if len(angles) < min_markers:
            self.missed += 1
            overlay["locked"] = False
            overlay["reason"] = (f"{len(angles)} tape(s) visible, "
                                 f"{min_markers} needed")
            if not angles:
                # Nothing at all to match next frame against.
                self.prev_angles = None
            # With some tapes still visible, prev_angles is deliberately kept:
            # a one-frame dip below the floor is then bridged by matching the
            # next good frame against the older set, and max_step_deg still
            # rejects a bridge that spans an implausible rotation.
            return overlay

        delta, inliers = (None, 0)
        if self.prev_angles:
            delta, inliers = best_shift(self.prev_angles, angles,
                                        cal.get("max_step_deg", 25.0),
                                        cal.get("match_tol_deg", 3.0))
        self.prev_angles = angles

        if delta is None:
            # Markers present but no consistent rotation between the two sets.
            # Better to skip the sample than to guess a delta.
            self.unmatched += 1
            overlay.update({"locked": False, "reason": "no consensus",
                            "inliers": 0})
            return overlay

        self.unwrapped += delta
        self.seen += 1
        self.last_lock_t = t
        self.last_marker = (accepted[0][1] / w, accepted[0][2] / h)
        self.metrics.add(t, self.unwrapped)

        overlay.update({
            "locked": True,
            "angle": round(self.unwrapped % 360.0, 2),
            "unwrapped": round(self.unwrapped, 2),
            "delta": round(delta, 3),
            "inliers": inliers,
            "marker": [round(accepted[0][1] / w, 5),
                       round(accepted[0][2] / h, 5)],
        })
        return overlay

    def _hub_from_orbit(self, w: int, h: int, n_movers: int):
        """Fit the wheel centre to the arc the tapes have swept.

        Needs the points to span a decent arc: three markers clustered in one
        quadrant fit a circle of almost any radius, so the fit is only trusted
        once the accumulated positions wrap far enough around to pin it.
        """
        if n_movers < 2 or len(self._pos_history) < STATIC_WINDOW // 2:
            return None
        # Pixel space, not normalised: dividing x by width and y by height
        # turns the orbit into an ellipse on a 16:9 frame and the circle fit
        # is then meaningless. Fixtures are dropped - they do not orbit.
        eps = STATIC_EPS_FRAC * w
        pts = [(px * w, py * h)
               for frame_pts, _u in self._pos_history for px, py in frame_pts
               if not any(math.hypot((px - sx) * w, (py - sy) * h) <= eps
                          for sx, sy in self.static_points)]
        if len(pts) < 12:
            return None
        cx, cy, r = fit_circle(pts)
        if not (0.05 * w < r < 1.5 * w) or not (-w < cx < 2 * w):
            return None
        spread = _angular_spread([math.atan2(py - cy, px - cx)
                                  for px, py in pts])
        if spread < 200.0:
            return None
        return (None, cx, cy, r)

    def _split_static(self, blobs, w: int, h: int):
        """Partition blobs into (stationary, moving) using the learned set."""
        eps = STATIC_EPS_FRAC * w
        statics, movers = [], []
        for b in blobs:
            if any(math.hypot(b[0] - sx * w, b[1] - sy * h) <= eps
                   for sx, sy in self.static_points):
                statics.append(b)
            else:
                movers.append(b)
        return statics, movers

    def _update_static(self, rim, w: int, h: int) -> None:
        """Learn which green blobs are fixtures rather than tape on the wheel.

        A tape's image position sweeps as the wheel turns; a bracket, a
        reflection or a bit of tape on the frame stays put. So: remember recent
        blob positions, and call a position static if something sat within a
        few pixels of it for most of the window.

        Crucially this only runs while the wheel is demonstrably turning. A
        stalled wheel makes every real tape look like a fixture, and rejecting
        them would erase exactly the stall the experiment exists to measure -
        so when there is no rotation to speak of, the existing classification
        is kept and nothing new is learned.
        """
        self._pos_history.append(([(bx / w, by / h) for bx, by, _a in rim],
                                  self.unwrapped))
        if len(self._pos_history) > STATIC_WINDOW:
            self._pos_history.pop(0)
        if len(self._pos_history) < STATIC_WINDOW:
            return

        # Rotation ACROSS THE WINDOW, not since the previous frame. Comparing
        # against the last call made this per-frame (a few degrees), which sits
        # permanently under the threshold - so classification ran once and then
        # never again. Any rig whose conditions were not right at that single
        # instant got no fixture rejection at all for the rest of the run.
        rotation = abs(self.unwrapped - self._pos_history[0][1])
        if rotation < STATIC_MIN_ROTATION:
            return                      # stalled or barely moving - do not judge

        eps = STATIC_EPS_FRAC
        found = []
        for cand in self._pos_history[-1][0]:
            hits = sum(1 for frame_pts, _u in self._pos_history
                       if any(math.hypot(px - cand[0], py - cand[1]) <= eps
                              for px, py in frame_pts))
            if hits >= STATIC_PRESENCE * len(self._pos_history):
                found.append(cand)
        self.static_points = found

    @staticmethod
    def _find_blobs(frame, lo, hi, amin, amax):
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, lo, hi)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, KERNEL)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, KERNEL)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        out = []
        for c in contours:
            area = cv2.contourArea(c)
            if area < amin or area > amax:
                continue
            m = cv2.moments(c)
            if m["m00"] == 0:
                continue
            out.append((m["m10"] / m["m00"], m["m01"] / m["m00"], area))
        return out

    # -- helpers -----------------------------------------------------------
    def auto_calibrate(self) -> dict | None:
        """Fit a circle to recently seen marker positions.

        Needs the wheel to have turned: points clustered in one arc fit a
        wildly wrong circle, so require a decent angular spread before
        accepting the result.
        """
        pts = list(self._fit_points)
        if len(pts) < 40:
            return None
        try:
            cx, cy, r = fit_circle(pts)
        except np.linalg.LinAlgError:
            return None
        if not (0.05 < r < 1.5) or not (0.0 < cx < 1.0) or not (0.0 < cy < 1.0):
            return None
        angles = [math.atan2(p[1] - cy, p[0] - cx) for p in pts]
        spread = _angular_spread(angles)
        if spread < math.radians(90):
            return None
        return {"center": [round(cx, 5), round(cy, 5)], "radius": round(r, 5),
                "spread_deg": round(math.degrees(spread), 1),
                "points": len(pts)}

    def sample_hsv(self, frame: np.ndarray, x: float, y: float,
                   patch: int = 12) -> dict:
        """Sample the colour under a normalised (x, y) tap and widen to a range.

        The phone user taps the marker; a single pixel is far too tight a range
        once lighting shifts, so this takes the median over a small patch and
        pads generously in S and V (which swing with the sun through a window)
        while keeping hue tight (which is what actually identifies the tape).
        """
        h, w = frame.shape[:2]
        px, py = int(x * w), int(y * h)
        x0, x1 = max(px - patch, 0), min(px + patch, w)
        y0, y1 = max(py - patch, 0), min(py + patch, h)
        region = frame[y0:y1, x0:x1]
        if region.size == 0:
            return {}
        hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV).reshape(-1, 3)
        hue, sat, val = (int(np.median(hsv[:, i])) for i in range(3))
        return {
            "hsv_lo": [max(hue - 12, 0), max(sat - 70, 60), max(val - 70, 50)],
            "hsv_hi": [min(hue + 12, 179), 255, 255],
            "sampled": [hue, sat, val],
        }


