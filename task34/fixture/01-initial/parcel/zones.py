"""Destination zones and their base rates.

A zone is a short code: "domestic", "eu", "europe-other", "world", "remote".
"""

from __future__ import annotations

ZONES: dict[str, dict[str, float]] = {
    "domestic": {"base": 4.90, "per_kg": 0.80},
    "eu": {"base": 9.50, "per_kg": 1.60},
    "europe-other": {"base": 14.00, "per_kg": 2.40},
    "world": {"base": 24.00, "per_kg": 4.10},
    "remote": {"base": 24.00, "per_kg": 4.10, "surcharge": 0.15},
}


class UnknownZoneError(ValueError):
    """Raised for a zone code that has no rate."""


def zone_rates(zone: str) -> dict[str, float]:
    """The rate table of a zone code (see ZONES)."""
    try:
        return ZONES[zone.strip().lower()]
    except KeyError:
        raise UnknownZoneError(f"unknown zone: {zone!r}") from None
