from parcel import cli


def test_quote(capsys):
    assert cli.main(["quote", "2", "--to", "DE"]) == 0
    assert capsys.readouterr().out.strip() == "6.50 EUR"


def test_express(capsys):
    assert cli.main(["quote", "2", "--to", "domestic", "--express"]) == 0
    assert capsys.readouterr().out.strip() == "9.75 EUR"


def test_bad_zone(capsys):
    assert cli.main(["quote", "2", "--to", "mars"]) == 2
    assert "unknown zone" in capsys.readouterr().err


def test_uses_quote_price(monkeypatch, capsys):
    monkeypatch.setattr("parcel.cli.quote_price", lambda weight, zone, express=False: "1.00")
    cli.main(["quote", "1", "--to", "eu"])
    assert capsys.readouterr().out.startswith("1.00")
