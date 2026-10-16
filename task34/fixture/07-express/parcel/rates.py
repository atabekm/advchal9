"""Price quotes: base rate + per-kg rate of the zone, surcharges, rounding to cents."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from .config import load_settings
from .zones import zone_rates

EXPRESS_MULTIPLIER = Decimal("1.5")


class WeightLimitError(ValueError):
    """Raised when a parcel is heavier than PARCEL_MAX_WEIGHT_KG."""


def _round_money(amount: Decimal) -> Decimal:
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def quote_price(weight_kg: Decimal | float | str, zone: str, *, express: bool = False) -> Decimal:
    """The price of one parcel in the configured currency, rounded to cents.

    `zone` is a zone code ("eu") or a two-letter country code ("FR"). Express delivery costs
    1.5 times the standard price. Raises WeightLimitError above the configured maximum weight.
    """
    settings = load_settings()
    try:
        weight = Decimal(str(weight_kg))
    except InvalidOperation:
        raise ValueError(f"not a weight: {weight_kg!r}") from None
    if weight <= 0:
        raise ValueError("weight must be positive")
    if weight > settings.max_weight_kg:
        raise WeightLimitError(f"{weight} kg is over the limit of {settings.max_weight_kg} kg")
    # TODO(#14): use volumetric weight for large light parcels
    rates = zone_rates(zone)
    price = rates["base"] + rates["per_kg"] * weight
    price += _round_money(price * rates.get("surcharge", Decimal("0")))
    price += _round_money(price * settings.fuel_surcharge)
    if express:
        price *= EXPRESS_MULTIPLIER
    return _round_money(price)
