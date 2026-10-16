from decimal import Decimal

import pytest

from parcel.rates import WeightLimitError, quote_price
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


def test_remote_and_fuel_round_separately(monkeypatch):
    # 36.30 + 5.45 remote surcharge (5.445 rounded) + 4.18 fuel (4.175 rounded)
    monkeypatch.setenv("PARCEL_FUEL_SURCHARGE", "0.10")
    assert quote_price("3", "GL") == Decimal("45.93")


def test_express():
    assert quote_price("2", "domestic", express=True) == Decimal("9.75")


def test_weight_limit(monkeypatch):
    monkeypatch.delenv("PARCEL_MAX_WEIGHT_KG", raising=False)
    with pytest.raises(WeightLimitError):
        quote_price("30.5", "eu")
    monkeypatch.setenv("PARCEL_MAX_WEIGHT_KG", "50")
    assert quote_price("30.5", "eu") == Decimal("58.30")


def test_bad_input():
    with pytest.raises(ValueError):
        quote_price(0, "eu")
    with pytest.raises(ValueError):
        quote_price("heavy", "eu")
    with pytest.raises(UnknownZoneError):
        quote_price(1, "mars")
