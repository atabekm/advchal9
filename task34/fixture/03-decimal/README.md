# parcel

Shipping cost quotes by weight and destination zone, in Python. Prices are `Decimal`,
rounded to cents (see [ADR 0002](docs/adr/0002-money-as-decimal.md)).

## Install

    pip install -e .

## Quick start

```python
from parcel import quote_price

quote_price("2.5", "FR")      # Decimal('13.50'), zone "eu"
quote_price(2, "domestic")    # Decimal('6.50')
```

From the command line:

    parcel quote 2.5 --zone FR
    13.50 EUR

## Documentation

- [Usage](docs/usage.md): the API, the CLI and the HTTP handler
- [Configuration](docs/configuration.md): environment variables
- [Decisions](docs/adr/README.md): architecture decision records
- [Changelog](CHANGELOG.md)

## Development

    pip install -e . pytest
    pytest

The project's rules are in [RULES.md](RULES.md).
