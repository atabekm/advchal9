# 0001. Prices from flat per-zone tables

- Status: accepted
- Date: 2026-07-06
- Deciders: Mira Kovač, Jonas Weber

## Context

We need shipping prices for a web shop that sends parcels from Germany. Carriers price by
weight and distance, with dozens of exceptions. We want something small that ops can reason
about, not a copy of a carrier's tariff.

## Decision

We will price a parcel as `base + per_kg × weight` from a table with one row per zone, plus a
percentage surcharge for remote zones. Zones are a handful of codes (`domestic`, `eu`, ...).

## Consequences

- The whole pricing model is one table and one formula, and a change is one line.
- Prices approximate carrier costs; we accept losing a little on some parcels.
- Volumetric weight is not modelled yet.

## Alternatives considered

- A carrier API lookup per quote: exact, but slow, rate-limited, and ties us to one carrier.
- Weight bands (0–2 kg, 2–5 kg, ...): what carriers do, but four times the table for little gain.
