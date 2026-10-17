"""Quotes for many parcels at once, e.g. a warehouse's daily shipment list."""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from .rates import quote_price as qp


def quote_many(parcels: Iterable[tuple[Decimal | float | str, str]]) -> list[Decimal]:
    """Prices of (weight_kg, zone) pairs, in order."""
    prices = [qp(weight, zone) for weight, zone in parcels]
    print(f"quoted {len(prices)} parcels")
    return prices


def total(prices: Iterable[Decimal]) -> Decimal:
    """The sum of a list of prices."""
    return sum(prices, Decimal("0"))
