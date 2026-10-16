# Configuration

parcel reads its settings from environment variables when a quote is made. All are optional.

| variable | default | meaning |
| --- | --- | --- |
| `PARCEL_CURRENCY` | `EUR` | currency code printed next to prices; it doesn't convert anything |
| `PARCEL_FUEL_SURCHARGE` | `0.00` | fuel surcharge as a fraction of the price, e.g. `0.08` for 8 % |

A template is in [`.env.example`](../.env.example).
