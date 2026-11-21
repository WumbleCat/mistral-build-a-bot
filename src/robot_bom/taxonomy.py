"""Category normalisation, functional roles and name similarity."""

from __future__ import annotations

import re
from difflib import SequenceMatcher

from .models import Component

_CATEGORY_ALIASES = {
    "wheels": "wheel", "tire": "wheel", "tyre": "wheel", "tires": "wheel", "tyres": "wheel",
    "frame": "chassis", "base_plate": "chassis", "body": "chassis",
    "dc_motor": "motor", "gear_motor": "motor", "gearmotor": "motor", "motors": "motor",
    "stepper_motor": "motor", "servo_motor": "servo",
    "motor_controller": "motor_driver", "h_bridge": "motor_driver", "esc": "motor_driver",
    "relay_board": "relay_module", "relays": "relay",
    "mcu": "microcontroller", "controller": "microcontroller", "dev_board": "microcontroller",
    "development_board": "microcontroller", "arduino": "microcontroller",
    "sbc": "single_board_computer", "computer": "single_board_computer",
    "pcb": "pcb_module", "module": "pcb_module", "board": "pcb_module",
    "batteries": "battery", "battery_pack": "battery", "power_source": "power_supply",
    "wire": "wiring", "wires": "wiring", "jumper_wires": "wiring", "cable": "wiring",
    "cables": "wiring", "leds": "led", "light": "led", "lights": "led",
    "screw": "fastener", "screws": "fastener", "fasteners": "fastener", "standoff": "fastener",
    "connectors": "connector", "sensors": "sensor", "switches": "switch",
}

ROLE_CATEGORIES: dict[str, set[str]] = {
    "wheel": {"wheel"},
    "motor": {"motor"},
    "motor_driver": {"motor_driver"},
    "relay": {"relay_module", "relay"},
    "controller": {"microcontroller", "single_board_computer"},
    "power": {"battery", "battery_holder", "power_supply"},
    "chassis": {"chassis"},
    "board": {"microcontroller", "single_board_computer", "motor_driver", "relay_module", "pcb_module"},
}

_TOKEN_SYNONYMS = {"tyre": "wheel", "tire": "wheel", "frame": "chassis", "cable": "wire"}
_STOPWORDS = {"a", "an", "the", "of", "with", "and", "for", "on", "in"}


def normalize_category(raw: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", raw.strip().lower()).strip("_") or "other"
    return _CATEGORY_ALIASES.get(slug, slug)


def has_role(component: Component, role: str) -> bool:
    return component.category in ROLE_CATEGORIES[role]


def name_tokens(name: str) -> frozenset[str]:
    tokens = set()
    for token in re.findall(r"[a-z0-9]+", name.lower()):
        if token in _STOPWORDS:
            continue
        if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
            token = token[:-1]
        tokens.add(_TOKEN_SYNONYMS.get(token, token))
    return frozenset(tokens)


def normalize_name(name: str) -> str:
    return " ".join(sorted(name_tokens(name)))


def name_similarity(a: str, b: str) -> float:
    """0..1 similarity between two part-type names (token overlap + fuzzy string match)."""
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb:
        return 0.0
    if ta == tb:
        return 1.0
    jaccard = len(ta & tb) / len(ta | tb)
    subset = 0.75 if (ta <= tb or tb <= ta) else 0.0
    fuzzy = SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio()
    # Fuzzy matching alone is weak evidence (shared letters, not shared meaning): damp it.
    return max(jaccard, subset, fuzzy * 0.7)


class IdAllocator:
    """Hands out stable ``<category>-<n>`` ids."""

    def __init__(self, existing: list[str] | None = None) -> None:
        self._used = set(existing or [])

    def new(self, category: str) -> str:
        n = 1
        while f"{category}-{n}" in self._used:
            n += 1
        component_id = f"{category}-{n}"
        self._used.add(component_id)
        return component_id
