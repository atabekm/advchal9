from decimal import Decimal

import pytest

from parcel.zones import UnknownZoneError, resolve_zone, zone_rates


def test_zone_codes():
    assert zone_rates("EU ")["base"] == Decimal("9.50")
    with pytest.raises(UnknownZoneError):
        zone_rates("moon")


def test_country_codes():
    assert zone_rates("fr") is zone_rates("eu")
    assert zone_rates("DE") is zone_rates("domestic")
    assert zone_rates("US") is zone_rates("world")


def test_resolve_zone():
    assert [resolve_zone(d) for d in ("eu", " FR", "ch", "GL", "JP")] == ["eu", "eu", "europe-other", "remote", "world"]
    with pytest.raises(UnknownZoneError):
        resolve_zone("Atlantis")
