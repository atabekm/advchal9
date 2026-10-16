"""Command line: `parcel quote 2.5 --zone eu`."""

from __future__ import annotations

import argparse
import sys

from .config import load_settings
from .rates import quote_price
from .zones import UnknownZoneError


def build_parser() -> argparse.ArgumentParser:
    """The argument parser of the `parcel` command."""
    parser = argparse.ArgumentParser(prog="parcel", description="Shipping cost quotes.")
    sub = parser.add_subparsers(dest="command", required=True)
    quote = sub.add_parser("quote", help="price of one parcel (uses quote_price)")
    quote.add_argument("weight", help="weight in kg, e.g. 2.5")
    quote.add_argument("--zone", required=True, help="zone code: domestic, eu, europe-other, world, remote")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the command line; returns the exit code."""
    args = build_parser().parse_args(argv)
    try:
        price = quote_price(args.weight, args.zone)
    except (ValueError, UnknownZoneError) as e:
        print(f"parcel: {e}", file=sys.stderr)
        return 2
    print(f"{price:.2f} {load_settings().currency}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
