# Project rules

Every change to parcel follows these rules. Reviewers check them before merging.

1. **Docstrings.** Every public function and class in `parcel/` (a name without a leading
   underscore) has a docstring.
2. **No printing in the library.** Only `parcel/cli.py` writes to stdout or stderr. Library
   code returns values or raises exceptions.
3. **Configuration is documented.** Every environment variable the code reads is listed both
   in `.env.example` and in the table in `docs/configuration.md`.
4. **TODOs have an issue.** A `TODO` or `FIXME` comment names its issue: `# TODO(#12): ...`.
5. **Modules are documented.** Every module in `parcel/` except `__init__.py` has a row in the
   "Modules" table of `docs/usage.md`.
6. **Modules are tested.** Every module in `parcel/` except `__init__.py` has a test file
   `tests/test_<module>.py`.
7. **Money is Decimal.** Prices are computed and returned as `Decimal`, never `float`
   ([ADR 0002](docs/adr/0002-money-as-decimal.md)).
