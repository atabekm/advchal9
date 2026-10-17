"""A minimal HTTP handler: GET /quote?weight=2.5&zone=FR -> {"price": "13.50", "currency": "EUR"}.

`app` is a WSGI application, so it runs behind any WSGI server (`wsgiref` in development).
"""

from __future__ import annotations

import json
import os
from urllib.parse import parse_qs

from . import rates
from .config import load_settings
from .zones import UnknownZoneError

PREFIX = os.environ.get("PARCEL_API_PREFIX", "").rstrip("/")


def app(environ, start_response):
    """WSGI entry point. Only GET {PREFIX}/quote is served."""
    if environ.get("REQUEST_METHOD") != "GET" or environ.get("PATH_INFO") != f"{PREFIX}/quote":
        return _reply(start_response, "404 Not Found", {"error": "not found"})
    query = parse_qs(environ.get("QUERY_STRING", ""))
    try:
        weight = query["weight"][0]
        zone = query["zone"][0]
        price = rates.quote_price(weight, zone)
    except KeyError as e:
        return _reply(start_response, "400 Bad Request", {"error": f"missing parameter {e}"})
    except (ValueError, UnknownZoneError) as e:
        return _reply(start_response, "400 Bad Request", {"error": str(e)})
    return _reply(start_response, "200 OK", {"price": f"{price:.2f}", "currency": load_settings().currency})


def _reply(start_response, status: str, body: dict) -> list[bytes]:
    data = json.dumps(body).encode()
    start_response(status, [("Content-Type", "application/json"), ("Content-Length", str(len(data)))])
    return [data]
