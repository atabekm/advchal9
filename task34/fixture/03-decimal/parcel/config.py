"""Settings from the environment. Every variable is optional."""

from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Settings:
    """What a quote depends on besides the parcel itself."""

    currency: str = "EUR"
    fuel_surcharge: Decimal = Decimal("0.00")


def load_settings() -> Settings:
    """Read PARCEL_* variables, falling back to the defaults above."""
    return Settings(
        currency=os.environ.get("PARCEL_CURRENCY", "EUR"),
        fuel_surcharge=Decimal(os.environ.get("PARCEL_FUEL_SURCHARGE", "0.00")),
    )
