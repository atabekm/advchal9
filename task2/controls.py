"""Response controls: format, length and stop condition.

Every control can be applied twice over, and the pairing is the point of this
task:

  instruction  the prompt asks the model to comply, and it may not
  API          the request parameter enforces it, whatever the model intends

Nothing here is bundled into presets. A control is active only if you asked for
it, so `--max-words 60` is an instruction with no enforcement behind it, and
`--max-tokens 150` is enforcement with nothing shaping the answer. The command
line is the whole description of what gets sent.
"""

from dataclasses import dataclass

STOP_MARKER = "<END>"

# Format descriptions handed to the model verbatim. The json one deliberately
# spells "json" in lower case: DeepSeek rejects response_format=json_object
# unless that word appears somewhere in the messages.
FORMATS = {
    "bullets": (
        "Answer as a flat list of 3-5 bullet points.\n"
        "Each bullet is a single line starting with '- '.\n"
        "No heading, no preamble, no closing summary."
    ),
    # "confidence" used to sit in this shape and had to go: an epistemic field
    # reads as a role ("a system that rates its claims"), and requests that do
    # not fit that role -- a recipe, say -- were occasionally refused in schema
    # rather than answered. The closing line guards the same failure directly.
    "json": (
        "Answer with a single json object and nothing else.\n"
        'Shape: {"summary": string, "points": [string, ...], "detail": '
        '"brief" | "full"}\n'
        "Use at most 5 entries in points. No markdown fences, no commentary.\n"
        "This describes the output format only. Answer the question fully "
        "within it."
    ),
    "table": (
        "Answer as a markdown table with exactly two columns: | Step | What happens |\n"
        "Include the header row and the separator row, and at most 5 data rows.\n"
        "No text before or after the table."
    ),
}


@dataclass(frozen=True)
class Controls:
    """The controls asked for on the command line. Empty means no controls."""

    fmt: str | None = None           # key into FORMATS, described to the model
    max_words: int | None = None     # instruction-level length limit
    max_tokens: int | None = None    # API-level length limit
    stop_marker: str | None = None   # stop condition, instruction and API both

    @property
    def active(self):
        """True if anything at all was asked for."""
        return any((self.fmt, self.max_words, self.max_tokens, self.stop_marker))

    def system_prompt(self, base=None):
        """Build the system message: the caller's own prompt plus our block."""
        parts = [base.strip()] if base and base.strip() else []

        if self.fmt:
            parts.append(FORMATS[self.fmt])
        if self.max_words:
            parts.append(f"Hard limit: {self.max_words} words for the whole answer.")
        if self.stop_marker:
            parts.append(
                f"When the answer is complete, output {self.stop_marker} on its own "
                "line. Write nothing after it."
            )
        return "\n\n".join(parts) or None

    def request_params(self):
        """The API parameters that enforce what can be enforced."""
        params = {}
        if self.max_tokens:
            params["max_tokens"] = self.max_tokens
        if self.stop_marker:
            params["stop"] = [self.stop_marker]
        if self.fmt == "json":
            params["response_format"] = {"type": "json_object"}
        return params

    def describe(self):
        """One line per active control, marking which side enforces it."""
        lines = []
        if self.fmt:
            fmt = f"format: {self.fmt} (instruction)"
            if self.fmt == "json":
                fmt += " + response_format=json_object (API)"
            lines.append(fmt)
        if self.max_words or self.max_tokens:
            limit = []
            if self.max_words:
                limit.append(f"{self.max_words} words (instruction)")
            if self.max_tokens:
                limit.append(f"max_tokens={self.max_tokens} (API)")
            lines.append("length: " + " + ".join(limit))
        if self.stop_marker:
            lines.append(f"stop: {self.stop_marker} (instruction) + "
                         f"stop={self.stop_marker!r} (API)")
        return lines or ["no controls"]


def build(fmt=None, max_words=None, max_tokens=None, stop=None):
    """Assemble the controls from the flags that were actually passed.

    JSON mode forbids any text outside the object, so a trailing stop marker
    would make the response invalid -- with --format json the marker is dropped
    and max_tokens is left to bound the answer.
    """
    if fmt == "json":
        stop = None

    return Controls(
        fmt=fmt,
        max_words=max_words or None,
        max_tokens=max_tokens or None,
        stop_marker=stop or None,
    )
