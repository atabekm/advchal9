import pytest

from parcel.rates import quote_price
from parcel.zones import UnknownZoneError


def test_domestic():
    assert quote_price(2, "domestic") == 6.5


def test_remote_surcharge():
    assert quote_price(2, "remote") == 37.03


def test_bad_input():
    with pytest.raises(ValueError):
        quote_price(0, "eu")
    with pytest.raises(UnknownZoneError):
        quote_price(1, "mars")
