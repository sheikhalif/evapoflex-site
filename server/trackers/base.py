"""Interface every tracking algorithm implements.

A tracker turns frames into an unwrapped rotation angle. Everything else - how
runs are recorded, what the dashboard draws, how metrics are computed - is the
same regardless of which one is loaded, so algorithms can be swapped without
touching the rest of the system.

Swapping mid-run is deliberately awkward rather than impossible: see
`carry_state_to`. A run whose numbers came from two different algorithms is not
comparable with either, and silently producing one is worse than refusing.
"""
from __future__ import annotations

import hashlib
import inspect
import os

import numpy as np

from tracker import RollingMetrics

# State that belongs to the *run*, not to the algorithm. Carried across a swap
# so a reload does not zero the rotation count or throw away the metrics
# gathered so far.
RUN_STATE = ("unwrapped", "seen", "missed", "unmatched", "frame_num",
             "metrics", "started_wall", "last_lock_t", "last_marker")


class TrackerBase:
    """Subclass this and implement `process`."""

    #: short identifier, used in the API and stored on each run
    NAME = "base"
    #: human label for the UI
    LABEL = "Base tracker"
    #: one-line description shown next to the label
    DESCRIPTION = ""
    #: marker layout this expects, so the UI can warn about a mismatch
    EXPECTS = ""
    #: algorithm defaults; merged under any stored calibration
    DEFAULT_CALIBRATION: dict = {}

    def __init__(self, calibration: dict | None = None):
        self.calibration = {**self.DEFAULT_CALIBRATION, **(calibration or {})}
        self.reset()

    # ---- lifecycle -----------------------------------------------------

    def reset(self) -> None:
        """Full reset: new run. Zeroes rotation and metrics."""
        self.unwrapped = 0.0
        self.seen = 0
        self.missed = 0
        self.unmatched = 0
        self.frame_num = 0
        self.metrics = RollingMetrics()
        self.last_lock_t = None
        self.last_marker = None
        self.started_wall = __import__("time").time()
        self.reset_algorithm()

    def soft_reset(self) -> None:
        """Drop per-frame continuity, keep the run.

        Used when the camera reconnects, a pause ends, or calibration changes.
        A full reset() would zero `unwrapped` and swap in fresh metrics, so a
        wifi blip mid-run would silently restart the rotation count at zero.
        """
        self.reset_algorithm()

    def reset_algorithm(self) -> None:
        """Clear algorithm-private state. Subclasses override."""

    def set_calibration(self, patch: dict) -> None:
        self.calibration.update(patch)

    # ---- the actual work -----------------------------------------------

    def process(self, frame: np.ndarray, t: float) -> dict:
        """Track one frame; return an overlay/status dict. Must not raise.

        Expected keys: `locked` (bool), and when locked `angle`, `unwrapped`,
        `frame_num`. Anything else is passed through to the dashboard for
        drawing, so a new algorithm can ship its own annotations without the
        front end knowing about it in advance.
        """
        raise NotImplementedError

    # ---- swapping ------------------------------------------------------

    def carry_state_to(self, other: "TrackerBase") -> None:
        """Move run-level state into a replacement tracker.

        The new algorithm starts blind - no previous frame, no learned
        fixtures - but the run's accumulated rotation and metrics survive, so
        a reload does not look like the wheel jumped back to zero.
        """
        for key in RUN_STATE:
            if hasattr(self, key):
                setattr(other, key, getattr(self, key))
        other.reset_algorithm()

    # ---- provenance ----------------------------------------------------

    @classmethod
    def source_path(cls) -> str:
        return inspect.getfile(cls)

    @classmethod
    def source_hash(cls) -> str:
        """Short digest of the source file, recorded on every run.

        Without this, "which code produced this number" is unanswerable once
        the algorithm has been edited - and with hot reloading it will be
        edited, often, while runs are in progress.
        """
        try:
            with open(cls.source_path(), "rb") as f:
                return hashlib.sha256(f.read()).hexdigest()[:12]
        except OSError:
            return "unknown"

    @classmethod
    def describe(cls) -> dict:
        return {
            "name": cls.NAME,
            "label": cls.LABEL,
            "description": cls.DESCRIPTION,
            "expects": cls.EXPECTS,
            "source": os.path.basename(cls.source_path()),
            "hash": cls.source_hash(),
            "defaults": cls.DEFAULT_CALIBRATION,
        }

    # ---- shared helpers ------------------------------------------------

    def lock_quality(self) -> float:
        total = self.seen + self.missed
        return round(100.0 * self.seen / total, 1) if total else 0.0
