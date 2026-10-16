from decimal import Decimal

import pytest

from parcel.rates import quote_price
from parcel.zones import UnknownZoneError


def test_domestic():
    assert quote_price("2", "domestic") == Decimal("6.50")


def test_country_code():
    assert quote_price(2.5, "FR") == Decimal("13.50")


def test_remote_surcharge():
    assert quote_price("3", "GL") == Decimal("41.75")


def test_fuel_surcharge(monkeypatch):
    monkeypatch.setenv("PARCEL_FUEL_SURCHARGE", "0.10")
    assert quote_price("2", "domestic") == Decimal("7.15")


def test_bad_input():
    with pytest.raises(ValueError):
        quote_price(0, "eu")
    with pytest.raises(ValueError):
        quote_price("heavy", "eu")
    with pytest.raises(UnknownZoneError):
        quote_price(1, "mars")
