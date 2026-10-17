# parcel

Shipping cost quotes by weight and destination zone, in Python.

## Install

    pip install -e .

## Quick start

```python
from parcel import quote_price

quote_price(2.5, "eu")        # 13.5
quote_price(2, "domestic")    # 6.5
```

From the command line:

    parcel quote 2.5 --zone eu
    13.50 EUR

## Documentation

- [Usage](docs/usage.md): the API and the CLI
- [Configuration](docs/configuration.md): environment variables
- [Decisions](docs/adr/README.md): architecture decision records
- [Changelog](CHANGELOG.md)

## Development

    pip install -e . pytest
    pytest

The project's rules are in [RULES.md](RULES.md).
