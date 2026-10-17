# Usage

## Modules

| module | what it does |
| --- | --- |
| `parcel.rates` | `quote_price()`: the price of one parcel |
| `parcel.zones` | zone codes, country to zone, rate tables |
| `parcel.config` | settings from environment variables |
| `parcel.cli` | the `parcel` command |
| `parcel.api` | a WSGI handler for HTTP quotes |

## Quoting a parcel

```python
from parcel.rates import quote_price

price = quote_price(weight_kg, zone)
```

- `weight_kg`: a `Decimal`, `float` or string, must be positive.
- `zone`: a zone code (`domestic`, `eu`, `europe-other`, `world`, `remote`) or a two-letter
  country code (`FR`). Countries not in the table are `world`.
- Returns a `Decimal` in the configured currency, rounded to cents
  ([ADR 0002](adr/0002-money-as-decimal.md)).
- Raises `ValueError` for a non-positive weight and `UnknownZoneError` for an unknown zone.

The price is the zone's base rate plus its per-kg rate times the weight. Remote zones add a
surcharge of 15 %, then the fuel surcharge (`PARCEL_FUEL_SURCHARGE`) applies to the total.

## Command line

    parcel quote WEIGHT --zone DEST

```
$ parcel quote 2.5 --zone FR
13.50 EUR
$ parcel quote 2 --zone mars
parcel: unknown zone or country: 'mars'
```

The exit code is 0 on success and 2 on a bad weight or zone.

## HTTP

`parcel.api.app` is a WSGI application with one endpoint:

    GET /quote?weight=2.5&zone=FR

    200 {"price": "13.50", "currency": "EUR"}
    400 {"error": "unknown zone or country: 'mars'"}

Run it locally with the standard library:

```python
from wsgiref.simple_server import make_server
from parcel.api import app

make_server("", 8000, app).serve_forever()
```
