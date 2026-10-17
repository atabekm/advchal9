# Usage

## Modules

| module | what it does |
| --- | --- |
| `parcel.rates` | `quote_price()`: the price of one parcel |
| `parcel.zones` | zone codes and their rate tables |
| `parcel.config` | settings from environment variables |
| `parcel.cli` | the `parcel` command |

## Quoting a parcel

```python
from parcel.rates import quote_price

price = quote_price(weight_kg, zone)
```

- `weight_kg`: a number, must be positive.
- `zone`: a zone code: `domestic`, `eu`, `europe-other`, `world`, `remote`.
- Returns the price in the configured currency, rounded to cents.
- Raises `ValueError` for a non-positive weight and `UnknownZoneError` for an unknown zone.

The price is the zone's base rate plus its per-kg rate times the weight. Remote zones add a
surcharge of 15 %.

## Command line

    parcel quote WEIGHT --zone ZONE

```
$ parcel quote 2.5 --zone eu
13.50 EUR
$ parcel quote 2 --zone mars
parcel: unknown zone: 'mars'
```

The exit code is 0 on success and 2 on a bad weight or zone.
