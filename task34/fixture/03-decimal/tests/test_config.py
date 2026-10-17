from decimal import Decimal

from parcel.config import load_settings


def test_defaults(monkeypatch):
    monkeypatch.delenv("PARCEL_CURRENCY", raising=False)
    monkeypatch.delenv("PARCEL_FUEL_SURCHARGE", raising=False)
    settings = load_settings()
    assert settings.currency == "EUR" and settings.fuel_surcharge == Decimal("0")


def test_from_env(monkeypatch):
    monkeypatch.setenv("PARCEL_CURRENCY", "CHF")
    monkeypatch.setenv("PARCEL_FUEL_SURCHARGE", "0.08")
    settings = load_settings()
    assert settings.currency == "CHF" and settings.fuel_surcharge == Decimal("0.08")
