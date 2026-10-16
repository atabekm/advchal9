from parcel import cli


def test_quote(capsys):
    assert cli.main(["quote", "2", "--zone", "domestic"]) == 0
    assert capsys.readouterr().out.strip() == "6.50 EUR"


def test_bad_zone(capsys):
    assert cli.main(["quote", "2", "--zone", "mars"]) == 2
    assert "unknown zone" in capsys.readouterr().err
