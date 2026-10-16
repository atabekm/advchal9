"""Price quotes: base rate + per-kg rate of the zone, surcharges, rounding to cents."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from .config import load_settings
from .zones import zone_rates


def _round_money(amount: Decimal) -> Decimal:
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def quote_price(weight_kg: Decimal | float | str, zone: str) -> Decimal:
    """The price of one parcel in the configured currency, rounded to cents.

    `zone` is a zone code ("eu") or a two-letter country code ("FR").
    """
    settings = load_settings()
    try:
        weight = Decimal(str(weight_kg))
    except InvalidOperation:
        raise ValueError(f"not a weight: {weight_kg!r}") from None
    if weight <= 0:
        raise ValueError("weight must be positive")
    # TODO(#14): use volumetric weight for large light parcels
    rates = zone_rates(zone)
    price = rates["base"] + rates["per_kg"] * weight
    price += price * rates.get("surcharge", Decimal("0"))
    price += _round_money(price * settings.fuel_surcharge)
    return _round_money(price)
