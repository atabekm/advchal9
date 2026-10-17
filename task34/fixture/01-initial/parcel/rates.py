"""Price quotes: base rate + per-kg rate of the zone, plus the remote surcharge."""

from __future__ import annotations

from .zones import zone_rates


def quote_price(weight_kg: float, zone: str) -> float:
    """The price of one parcel in the configured currency, rounded to cents."""
    weight = float(weight_kg)
    if weight <= 0:
        raise ValueError("weight must be positive")
    rates = zone_rates(zone)
    price = rates["base"] + rates["per_kg"] * weight
    price *= 1 + rates.get("surcharge", 0)
    return round(price, 2)
