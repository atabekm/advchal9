import pytest

from parcel.zones import UnknownZoneError, zone_rates


def test_zone_codes():
    assert zone_rates("EU ")["base"] == 9.50
    with pytest.raises(UnknownZoneError):
        zone_rates("moon")
