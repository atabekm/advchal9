import pytest

from parcel.zones import UnknownZoneError, zone_rates


def test_zone_codes():
    assert zone_rates("EU ")["base"] == 9.50
    with pytest.raises(UnknownZoneError):
        zone_rates("moon")


def test_country_codes():
    assert zone_rates("fr") is zone_rates("eu")
    assert zone_rates("DE") is zone_rates("domestic")
    assert zone_rates("US") is zone_rates("world")
