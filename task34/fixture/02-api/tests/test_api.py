import json

from parcel.api import app


def call(path, query=""):
    seen = {}

    def start_response(status, headers):
        seen["status"] = status

    body = b"".join(app({"REQUEST_METHOD": "GET", "PATH_INFO": path, "QUERY_STRING": query}, start_response))
    return seen["status"], json.loads(body)


def test_quote():
    assert call("/quote", "weight=2&zone=DE") == ("200 OK", {"price": "6.50", "currency": "EUR"})


def test_errors():
    assert call("/quote", "weight=2&zone=mars")[0] == "400 Bad Request"
    assert call("/quote", "zone=eu")[1] == {"error": "missing parameter 'weight'"}
    assert call("/other")[0] == "404 Not Found"
