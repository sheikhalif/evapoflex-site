"""Have Claude write a tracking algorithm from sample frames of the wheel.

The operator captures a few seconds of the live feed, and Claude is shown those
frames plus the current calibration and asked to author a tracker plugin for
what it can actually see. The result lands in `trackers/` as an ordinary file.

Deliberately NOT automatic. Generated code is written to disk and returned for
review, but never activated: switching to it is a second, explicit action. The
model is looking at five JPEGs of a wheel - it can be wrong about the marker
layout in ways that are obvious to whoever built the rig and invisible here,
and this code runs unsandboxed on the machine holding every test result. A
human reads it first.
"""
from __future__ import annotations

import base64
import os
import re
import time

MODEL = "claude-opus-4-8"

# What Claude must produce. A schema rather than free text so the file, its
# metadata and its reasoning come back separable - no fishing code out of prose.
TRACKER_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {
            "type": "string",
            "description": "short lowercase identifier, e.g. 'green-quad'",
        },
        "label": {"type": "string", "description": "human label for the UI"},
        "description": {"type": "string"},
        "expects": {
            "type": "string",
            "description": "the marker layout this expects, in one line",
        },
        "observations": {
            "type": "string",
            "description": "what you actually saw in the frames: marker "
                           "colour, count, positions, lighting, anything "
                           "unusual or ambiguous",
        },
        "rationale": {
            "type": "string",
            "description": "why this approach suits what you saw, and what "
                           "would make it fail",
        },
        "code": {
            "type": "string",
            "description": "the complete Python file contents",
        },
    },
    "required": ["name", "label", "description", "expects", "observations",
                 "rationale", "code"],
    "additionalProperties": False,
}

SYSTEM = """You write frame-by-frame wheel-tracking algorithms for a research \
rig that measures a very slowly rotating evaporation-driven wheel (typically \
0.1-1 RPM).

You are given sample frames from the rig's camera and the current calibration. \
Author a tracker plugin for the marker layout you can actually SEE in those \
frames - not the one described to you, if they disagree. Say so in \
`observations` when they disagree.

The plugin must subclass TrackerBase and implement exactly one method:

    def process(self, frame: np.ndarray, t: float) -> dict

`frame` is BGR (OpenCV). `t` is the capture timestamp in seconds. Return a dict
with at least `locked` (bool); when locked, also `angle` (0-360), `unwrapped`
(cumulative degrees, sign-consistent), and `frame_num`. Any other keys are
passed through to the dashboard for drawing.

Available on self:
  self.calibration   - dict, the values below; read thresholds from it
  self.unwrapped     - cumulative rotation; YOU maintain this
  self.seen/.missed  - counters; increment them
  self.frame_num     - increment each call
  self.metrics.add(t, unwrapped)  - call ONLY on a locked frame
  self.reset_algorithm()  - override to clear your own state

Hard requirements:
- `process` must never raise. Return {"locked": False, ...} on any failure.
- No file, network, subprocess, or shell access. No imports beyond math, time,
  cv2, numpy, and `from .base import TrackerBase`.
- Pure function of the frames it is given plus its own state.
- Fast: this runs on every frame of a live feed. No per-frame allocation of
  large buffers, no exhaustive search.

Physics you can rely on:
- The wheel turns slowly. Between consecutive frames it moves a fraction of a
  degree. A large apparent jump is a tracking error, not rotation.
- Rotation is smooth and usually one direction, but stalls and small reversals
  are REAL and scientifically important - never smooth them away or clamp them.
- The camera is fixed. Anything that never moves is a fixture, not a marker.

Write the file as if it will be read by the engineer who built the rig: explain
WHY in comments where the reason is not obvious from the code, and be explicit
about what would make the approach fail."""


def _slug(name: str) -> str:
    """Filesystem- and import-safe module name. Never trust the model here."""
    s = re.sub(r"[^a-z0-9_]+", "_", (name or "").lower()).strip("_")
    return s or "generated"


def capture_samples(rig, count: int = 5) -> list[bytes]:
    """Grab the most recent frames the rig has seen.

    Returns whatever is available rather than blocking: the caller has already
    told the operator to make sure the feed is live, and a hang here would look
    like the whole page froze.
    """
    frames = [f for f in (rig.recent_frames() or []) if f]
    if not frames:
        raise ValueError("no frames available - is the camera streaming?")
    if len(frames) <= count:
        return frames
    # Spread across what we have: consecutive frames of a 0.5 RPM wheel are
    # nearly identical and would show the model the same picture five times.
    step = len(frames) / count
    return [frames[int(i * step)] for i in range(count)]


def _image_block(jpeg: bytes) -> dict:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": base64.standard_b64encode(jpeg).decode("ascii"),
        },
    }


def generate_tracker(frames: list[bytes], calibration: dict,
                     notes: str = "", trackers_dir: str = "") -> dict:
    """Ask Claude to author a tracker for these frames. Returns the result.

    The file is written to disk but NOT registered or activated - the caller
    reloads and selects it as a separate, deliberate step.
    """
    import anthropic

    client = anthropic.Anthropic()      # resolves key/profile from environment

    prompt = [
        {"type": "text", "text":
            f"Here are {len(frames)} frames from the rig camera, in "
            f"chronological order."},
        *[_image_block(f) for f in frames],
        {"type": "text", "text":
            "Current calibration (the values your `process` should read from "
            f"self.calibration):\n\n{calibration}\n\n"
            + (f"Notes from the operator:\n{notes}\n\n" if notes.strip() else "")
            + "Write the tracker. Look carefully at what markers are actually "
              "present, how many, what colour, and where they sit, before "
              "choosing an approach."},
    ]

    message = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        thinking={"type": "adaptive"},
        output_config={"effort": "high",
                       "format": {"type": "json_schema",
                                  "schema": TRACKER_SCHEMA}},
        messages=[{"role": "user", "content": prompt}],
    )

    if message.stop_reason == "refusal":
        raise RuntimeError("the model declined this request")

    import json
    text = next((b.text for b in message.content if b.type == "text"), "")
    result = json.loads(text)

    slug = _slug(result["name"])
    filename = f"generated_{slug}.py"
    path = os.path.join(trackers_dir, filename)

    header = (
        f'"""{result["label"]} - generated by Claude, NOT yet reviewed.\n\n'
        f'Generated {time.strftime("%Y-%m-%d %H:%M")} from {len(frames)} '
        f'sample frames.\n\n'
        f'What the model saw:\n{result["observations"]}\n\n'
        f'Why this approach:\n{result["rationale"]}\n\n'
        f'Read this before selecting it. It has never processed a frame.\n'
        f'"""\n'
    )
    body = result["code"]
    # The model usually writes its own docstring; keep ours as the provenance
    # record and let its module docstring become a comment rather than fight.
    if body.lstrip().startswith('"""'):
        body = body.lstrip()
        end = body.find('"""', 3)
        if end != -1:
            body = body[end + 3:].lstrip("\n")

    os.makedirs(trackers_dir, exist_ok=True)
    with open(path, "w") as f:
        f.write(header + "\n" + body + ("\n" if not body.endswith("\n") else ""))

    return {
        "name": result["name"],
        "label": result["label"],
        "description": result["description"],
        "expects": result["expects"],
        "observations": result["observations"],
        "rationale": result["rationale"],
        "file": filename,
        "path": path,
        "code": header + "\n" + body,
        "frames_used": len(frames),
        "model": MODEL,
        "usage": {"input": message.usage.input_tokens,
                  "output": message.usage.output_tokens},
    }
