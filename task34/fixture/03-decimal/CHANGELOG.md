# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-08-25

### Changed
- Prices are `Decimal`, rounded half-up to cents, instead of `float` (ADR 0002).
  `quote_price()` returns a `Decimal`, and the HTTP handler sends the price as a string.

### Added
- `PARCEL_FUEL_SURCHARGE`: a fuel surcharge applied to every quote.

## [0.2.0] - 2026-07-28

### Added
- `parcel.api`: a WSGI handler for `GET /quote`.
- Two-letter country codes as destinations (`FR` is zone `eu`).

## [0.1.0] - 2026-07-06

### Added
- `quote_price()` with five zones and a surcharge for remote ones.
- The `parcel quote` command.
- `PARCEL_CURRENCY`: the currency code printed next to prices.

[Unreleased]: https://git.example.com/parcel/compare/v0.3.0...HEAD
[0.3.0]: https://git.example.com/parcel/compare/v0.2.0...v0.3.0
[0.2.0]: https://git.example.com/parcel/compare/v0.1.0...v0.2.0
[0.1.0]: https://git.example.com/parcel/releases/tag/v0.1.0
