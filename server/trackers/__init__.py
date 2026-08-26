"""Registry of tracking algorithms, discovered from this directory.

Drop a .py file in here that subclasses TrackerBase and it becomes selectable
at runtime - no restart, no edits elsewhere. `reload()` re-imports every module
from disk, so an algorithm can be edited and retried against a live feed.

Import errors are captured rather than raised: a syntax error in one algorithm
must not take down the rig, and the message needs to reach the UI where whoever
just saved the file will see it.
"""
from __future__ import annotations

import importlib
import importlib.util
import os
import pkgutil
import sys
import traceback

from .base import TrackerBase

_HERE = os.path.dirname(os.path.abspath(__file__))

_registry: dict[str, type[TrackerBase]] = {}
_errors: dict[str, str] = {}
_loaded = False


def _module_names() -> list[str]:
    return sorted(m.name for m in pkgutil.iter_modules([_HERE])
                  if m.name != "base" and not m.name.startswith("_"))


def _scan(force_reload: bool = False) -> None:
    global _loaded
    _registry.clear()
    _errors.clear()
    for name in _module_names():
        full = f"{__name__}.{name}"
        try:
            if force_reload and full in sys.modules:
                mod = importlib.reload(sys.modules[full])
            else:
                mod = importlib.import_module(full)
        except Exception:                              # noqa: BLE001
            # Surfaced through last_errors() so a bad edit shows up in the UI
            # instead of silently leaving the previous version running.
            _errors[name] = traceback.format_exc(limit=3)
            continue
        for attr in vars(mod).values():
            if (isinstance(attr, type) and issubclass(attr, TrackerBase)
                    and attr is not TrackerBase):
                _registry[attr.NAME] = attr
    _loaded = True


def _ensure() -> None:
    if not _loaded:
        _scan()


def available() -> dict[str, type[TrackerBase]]:
    _ensure()
    return dict(_registry)


def describe_all() -> list[dict]:
    _ensure()
    return [cls.describe() for cls in
            sorted(_registry.values(), key=lambda c: c.LABEL)]


def last_errors() -> dict[str, str]:
    _ensure()
    return dict(_errors)


def get(name: str) -> type[TrackerBase]:
    _ensure()
    if name not in _registry:
        raise KeyError(f"no tracker named {name!r} "
                       f"(have: {', '.join(sorted(_registry)) or 'none'})")
    return _registry[name]


def reload() -> dict:
    """Re-import every algorithm from disk. Returns what happened."""
    before = set(_registry)
    _scan(force_reload=True)
    after = set(_registry)
    return {
        "loaded": sorted(after),
        "added": sorted(after - before),
        "removed": sorted(before - after),
        "errors": dict(_errors),
    }


def default_name() -> str:
    """Preferred algorithm when nothing is stored yet."""
    _ensure()
    if "constellation" in _registry:
        return "constellation"
    return next(iter(sorted(_registry)), "")
