# 0002. Money as Decimal, rounded half-up to cents

- Status: accepted
- Date: 2026-08-25
- Deciders: Mira Kovač, Jonas Weber

## Context

`quote_price()` returned a `float`. `round(2.675, 2)` gives `2.67`, because 2.675 has no exact
binary representation, and sums of quotes drifted from the invoices by a cent here and there.
Accounting reconciles every cent.

## Decision

We will compute and return prices as `decimal.Decimal`, round every surcharge and the final price
to cents with `ROUND_HALF_UP`, and accept `Decimal`, `float` or `str` weights. Money is never
converted to `float`, including in the HTTP response, which sends the price as a string.

## Consequences

- Quotes match the invoices to the cent.
- `quote_price()` changes its return type, so callers comparing with float literals have to
  change. 0.3.0 is a breaking release.
- A little more ceremony: `Decimal("4.90")` in the tables.

## Alternatives considered

- Integer cents: exact too, but every caller would have to format them.
- Keep `float` and round at the end: rounding only at the end is where the drift came from.
