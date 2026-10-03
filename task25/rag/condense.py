"""A chat message → a standalone question for retrieval, or "meta".

"And how much protein for that?" retrieves nothing as it stands. The condenser sees the last
few messages and the task memory, and writes the question out in full:
"How much protein per day should a vegetarian eat while losing fat, according to Gutless?".
That standalone question is what task 24's rewrite → search → rerank → answer pipeline gets.

A message that asks nothing of the documents ("thanks", "what have we agreed so far?") is
"meta": it skips retrieval and is answered from the conversation itself.

If the call fails or the reply can't be read, the message is treated as a question and
searched as it is, so a turn never fails because of the condenser.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from .cited import CITE
from .llm import DeepSeek, LLMError
from .store import Message

KINDS = ("question", "meta")
ASSISTANT_CHARS = 500  # an earlier answer in the prompt is cut to this; the gist is enough to resolve "it"

SYSTEM = """\
You prepare a user's chat message for search over a small document collection.

The collection contains these documents:
{titles}

You get the recent conversation and the user's new message. Decide what kind of message it is:
- "question": it asks for information that should come from the documents, including follow-ups
  ("and for women?", "how did they do that?") and replies to the assistant's clarifying
  question ("the TTS one").
- "meta": it asks nothing of the documents: greetings, thanks, "ok", instructions about how to
  answer ("keep it short"), or questions about this conversation itself ("what have we agreed
  so far?", "what was my goal?").

For a "question", write "standalone": the question as one self-contained sentence that can be
understood without the conversation. Replace pronouns and vague references ("it", "that",
"the paper", "the second one") with what they refer to. When the user answers a clarifying
question, combine their answer with the question it clarifies. Keep the user's names, numbers
and details; name the document when the conversation makes clear which one is meant. Do not
answer the question and do not add facts. If the message is already self-contained, copy it.
Use the task memory, when given, for what the conversation has established: what the user's
terms mean, what they clarified. The standalone question is for search, so ask what the
documents would state in general: leave out the user's personal details (their weight, diet,
situation) and answer preferences (length, units) unless the user asks about that detail as
the topic ("which vegetarian protein sources does it list?"). The assistant sees those
details separately and applies them to the answer. For example, "I'm vegetarian and weigh
82 kg. How much protein should I eat?" becomes "How much protein per day does Gutless
recommend?", not "How much protein should an 82 kg vegetarian eat?".
For "meta", "standalone" is "".

Reply with one JSON object only: {{"kind": "question" | "meta", "standalone": "..."}}"""


@dataclass
class Condensed:
    kind: str  # "question" | "meta"
    standalone: str  # the question to retrieve with; "" for meta
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0
    error: str = ""  # set when the reply was unusable and the message is searched as it is

    @property
    def meta(self) -> bool:
        return self.kind == "meta"


def history_block(history: list[Message]) -> str:
    lines = []
    for m in history:
        if m.role == "user":
            lines.append(f"User: {m.text.strip()}")
        else:
            text = " ".join(CITE.sub("", m.text).replace(" .", ".").split())  # [n] meant passages of that turn
            lines.append(f"Assistant: {text[:ASSISTANT_CHARS]}{'…' if len(text) > ASSISTANT_CHARS else ''}")
    return "\n".join(lines) or "(no earlier messages)"


def parse(text: str) -> tuple[str, str]:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise LLMError(f"condense: no JSON in {text[:200]!r}")
    try:
        data = json.loads(m.group(0))
    except ValueError as e:
        raise LLMError(f"condense: bad JSON ({e}) in {text[:200]!r}") from e
    kind = data.get("kind") if isinstance(data, dict) else None
    if kind not in KINDS:
        raise LLMError(f"condense: kind {kind!r} is not one of {KINDS}")
    standalone = data.get("standalone") or ""
    if not isinstance(standalone, str):
        raise LLMError("condense: standalone is not a string")
    standalone = " ".join(standalone.split())
    if kind == "question" and not standalone:
        raise LLMError("condense: a question needs a standalone text")
    return kind, standalone if kind == "question" else ""


class Condenser:
    def __init__(self, llm: DeepSeek, titles: list[str]):
        self.llm = llm
        self.system = SYSTEM.format(titles="\n".join(f"- {t}" for t in titles) or "- (none)")

    def condense(self, message: str, history: list[Message], memory: str = "") -> Condensed:
        user = f"Recent conversation:\n{history_block(history)}\n\n"
        if memory:
            user += f"Task memory (what has been established in this conversation):\n{memory}\n\n"
        user += f"New message: {message.strip()}\n\nReply with the JSON object."
        try:
            reply = self.llm.chat(self.system, user, json=True)
        except LLMError as e:
            return Condensed("question", message.strip(), error=str(e))
        try:
            kind, standalone = parse(reply.text)
        except LLMError as e:
            return Condensed("question", message.strip(), reply.prompt_tokens, reply.completion_tokens, reply.seconds, str(e))
        return Condensed(kind, standalone, reply.prompt_tokens, reply.completion_tokens, reply.seconds)
