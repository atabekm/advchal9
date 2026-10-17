"""Settings from the environment. Every variable is optional."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """What a quote depends on besides the parcel itself."""

    currency: str = "EUR"


def load_settings() -> Settings:
    """Read PARCEL_* variables, falling back to the defaults above."""
    return Settings(currency=os.environ.get("PARCEL_CURRENCY", "EUR"))
