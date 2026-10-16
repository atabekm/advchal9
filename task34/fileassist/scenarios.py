"""The preset goals. Each is a goal in words plus a short checklist of how to do that kind of job well;
neither names the files to open: the model finds them.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_SYMBOL = "quote_price"
DEFAULT_DECISION = ("Parcels heavier than a configurable maximum weight are rejected with an error instead of "
                    "being priced.")


@dataclass(frozen=True)
class Scenario:
    name: str
    title: str
    goal: str
    checklist: str
    changes_files: bool


USAGES = """How to do it well:
- Search for the name with a regular expression, across all files (code, tests, docs, changelog).
- The name can hide: imported under another name (`import x as y`), called through its module \
(`module.name(`), re-exported, or mentioned in a string. For every alias you find, search for the alias too.
- Read around a hit when it isn't clear what it does.
- Don't change any files.
- Report a Markdown table: `file:line` | kind (definition, re-export, import, call, call via alias, \
test, mock or string, docs, changelog) | what it does there. Then two or three sentences on how the \
name is used overall."""

UPDATE_DOCS = """How to do it well:
- Start from git: git_show for the last commit (git_log first if you need more history). List every \
user-visible change in it: renamed or new parameters, CLI flags, HTTP parameters, environment \
variables, exceptions, limits.
- For each change, search the documentation (README.md, docs/, .env.example) for the old name and \
for where similar things are documented.
- Update every place that still describes the old behaviour, and add the new things where their \
neighbours are documented (a new setting gets a row next to the other settings).
- Change documentation only: no code, no tests, not CHANGELOG.md, not the ADRs.
- At the end, search for the old names again; fix what is left.
- Report what changed in the code and, per file, what you updated."""

CHECK = """How to do it well:
- Read RULES.md. For each rule, decide how to check it with the tools: outline shows functions and \
classes without docstrings; search finds print(, TODO, os.environ; list_files shows which test files exist.
- Check each rule against every file it applies to; don't stop at the first violation.
- Check the facts in both places a rule names (e.g. code and docs) before calling something a violation.
- Report per rule: the violations as `file:line` with one line of explanation, or "no violations"."""

CHECK_REPORT_ONLY = "- Don't change any files."

CHECK_FIX = """- Then fix what you can without changing behaviour: add missing docstrings and documentation, \
remove library prints, add missing test files with real tests of the module. A TODO needs an issue \
number you don't know: report it, don't invent one.
- The project's tests must keep passing: don't change existing code paths.
- Report the violations and, separately, what you fixed and what is left."""

CHANGELOG = """How to do it well:
- Find the latest release (git tags in git_log) and the commits after it; git_show a commit when its \
message isn't enough to tell what changed for users.
- Read CHANGELOG.md and follow its format (Keep a Changelog).
- Write the entries under "## [Unreleased]": groups "### Added", "### Changed", "### Fixed" (only \
the ones needed), one bullet per user-visible change, in the words of a user rather than of the code. \
Say "breaking" for a change that breaks existing callers. Internal refactors without a visible effect \
don't belong in it.
- Don't touch the released sections; change only CHANGELOG.md.
- Report the entries and which commit each came from."""

ADR = """How to do it well:
- Read docs/adr/README.md (the index), docs/adr/template.md and one existing ADR for the style.
- Find where the decision lives in the code and the history (search, git_log, git_show): the commit \
that made it, its date and author, the code and settings involved.
- Write the new ADR from the template as docs/adr/NNNN-short-title.md with the next free number. \
Status accepted; date and deciders from that commit. Context, decision, consequences and \
alternatives grounded in what you found; name the files and settings.
- Add its row to the table in docs/adr/README.md.
- Change nothing else.
- Report the new file and the facts it rests on."""


def usages(symbol: str = DEFAULT_SYMBOL) -> Scenario:
    return Scenario("usages", f"Find usages of {symbol}",
                    f"Find every place where `{symbol}` is used in this project and say how it is used there.",
                    USAGES, False)


def update_docs() -> Scenario:
    return Scenario("update-docs", "Update the docs after the last change",
                    "The documentation is out of date after the latest code change. Bring it in line with the code.",
                    UPDATE_DOCS, True)


def check(fix: bool = False) -> Scenario:
    if fix:
        return Scenario("check-fix", "Check the rules and fix",
                        "Check the project against its rules in RULES.md, report every violation and fix what "
                        "you can.", CHECK + "\n" + CHECK_FIX, True)
    return Scenario("check", "Check the rules", "Check the project against its rules in RULES.md and report "
                    "every violation.", CHECK + "\n" + CHECK_REPORT_ONLY, False)


def changelog() -> Scenario:
    return Scenario("changelog", "Update the changelog",
                    "Update the changelog with what changed since the last release.", CHANGELOG, True)


def adr(decision: str = DEFAULT_DECISION) -> Scenario:
    return Scenario("adr", "Write an ADR", f"Write an architecture decision record for this decision: {decision}",
                    ADR, True)


def by_name(name: str, arg: str | None = None) -> Scenario:
    match name:
        case "usages":
            return usages(arg or DEFAULT_SYMBOL)
        case "update-docs":
            return update_docs()
        case "check":
            return check(False)
        case "check-fix":
            return check(True)
        case "changelog":
            return changelog()
        case "adr":
            return adr(arg or DEFAULT_DECISION)
    raise KeyError(name)


NAMES = ["usages", "update-docs", "check", "check-fix", "changelog", "adr"]
