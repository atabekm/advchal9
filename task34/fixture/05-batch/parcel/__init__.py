"""parcel: shipping cost quotes by weight and destination zone."""

from .batch import quote_many
from .rates import quote_price

__all__ = ["quote_price", "quote_many"]
__version__ = "0.3.0"
