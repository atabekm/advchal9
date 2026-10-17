from parcel.config import load_settings


def test_defaults(monkeypatch):
    monkeypatch.delenv("PARCEL_CURRENCY", raising=False)
    assert load_settings().currency == "EUR"


def test_from_env(monkeypatch):
    monkeypatch.setenv("PARCEL_CURRENCY", "CHF")
    assert load_settings().currency == "CHF"
