"""Destination zones and their base rates.

A zone is a short code: "domestic", "eu", "europe-other", "world", "remote". A two-letter
country code works too and is mapped to its zone.
"""

from __future__ import annotations

ZONES: dict[str, dict[str, float]] = {
    "domestic": {"base": 4.90, "per_kg": 0.80},
    "eu": {"base": 9.50, "per_kg": 1.60},
    "europe-other": {"base": 14.00, "per_kg": 2.40},
    "world": {"base": 24.00, "per_kg": 4.10},
    "remote": {"base": 24.00, "per_kg": 4.10, "surcharge": 0.15},
}

# Country codes that are not "world": everything else is.
COUNTRY_ZONES = {
    "DE": "domestic",
    "AT": "eu", "BE": "eu", "FR": "eu", "IT": "eu", "NL": "eu", "PL": "eu", "ES": "eu",
    "CH": "europe-other", "NO": "europe-other", "GB": "europe-other",
    "GL": "remote", "FO": "remote",
}


class UnknownZoneError(ValueError):
    """Raised for a zone code or country that has no rate."""


def zone_rates(zone: str) -> dict[str, float]:
    """The rate table of a zone code or a two-letter country code (see ZONES)."""
    code = zone.strip()
    if code.lower() in ZONES:
        return ZONES[code.lower()]
    if len(code) == 2 and code.isalpha():
        return ZONES[COUNTRY_ZONES.get(code.upper(), "world")]
    raise UnknownZoneError(f"unknown zone or country: {zone!r}")
