"""The configurations being compared: one factor changes at a time, starting from Ollama's defaults.

  baseline   qwen3:8b Q4_K_M as pulled: thinking on, temperature 0.6, default context, naive prompt
  params     thinking off, then temperature 0, then a capped output length
  context    num_ctx: what the context window costs in memory and speed
  prompt     task 27's prompt in JSON mode, then the tuned prompt with a JSON schema
  quant      the best settings on Q8_0, on qwen3:4b, and with a q8_0 KV cache
  final      the result: `qwen3-rag`, built from the Modelfile with the winning settings
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .ollama import DEFAULT_HOST
from .prompts import CHECK_SCHEMA, TUNED_SCHEMA

KV_HOST = "http://127.0.0.1:11435"  # a second `ollama serve` with OLLAMA_KV_CACHE_TYPE=q8_0, see README

TUNED_OPTIONS = {"temperature": 0, "num_ctx": 8192, "num_predict": 1024}


@dataclass(frozen=True)
class Variant:
    name: str
    group: str
    note: str
    model: str = "qwen3:8b"
    template: str = "naive"
    think: bool | None = None  # None: the model's default
    format: str | dict | None = None
    options: dict = field(default_factory=dict)
    host: str = DEFAULT_HOST
    system_in_modelfile: bool = False

    @property
    def format_label(self) -> str:
        return "schema" if isinstance(self.format, dict) else (self.format or "-")


VARIANTS = [
    Variant("baseline", "baseline", "Ollama defaults, naive prompt"),
    Variant("no-think", "params", "thinking off", think=False),
    Variant("temp0", "params", "+ temperature 0", think=False, options={"temperature": 0}),
    Variant("cap", "params", "+ num_predict 1024", think=False, options={"temperature": 0, "num_predict": 1024}),
    Variant("ctx4k", "context", "num_ctx 4096", think=False, options={"temperature": 0, "num_predict": 1024, "num_ctx": 4096}),
    Variant("ctx8k", "context", "num_ctx 8192", think=False, options={"temperature": 0, "num_predict": 1024, "num_ctx": 8192}),
    Variant("ctx16k", "context", "num_ctx 16384 (task 27)", think=False, options={"temperature": 0, "num_predict": 1024, "num_ctx": 16384}),
    Variant("task27", "prompt", "task 27 prompt, JSON mode", template="task27", think=False, format="json", options=TUNED_OPTIONS),
    Variant("tuned", "prompt", "tuned prompt + JSON schema", template="tuned", think=False, format=TUNED_SCHEMA, options=TUNED_OPTIONS),
    Variant("tuned-rules", "prompt", "tuned + a rule per remaining failure", template="tuned-rules", think=False, format=TUNED_SCHEMA, options=TUNED_OPTIONS),
    Variant("tuned-check", "prompt", "tuned-rules + a \"check\" field before the JSON", template="tuned-check", think=False, format=CHECK_SCHEMA, options=TUNED_OPTIONS),
    Variant("tuned-think", "prompt", "tuned, thinking on", template="tuned", think=True, format=TUNED_SCHEMA, options={**TUNED_OPTIONS, "num_predict": 4096}),
    Variant("q8", "quant", "tuned on Q8_0", model="qwen3:8b-q8_0", template="tuned", think=False, format=TUNED_SCHEMA, options=TUNED_OPTIONS),
    Variant("4b", "quant", "tuned on qwen3:4b (Q4_K_M)", model="qwen3:4b", template="tuned", think=False, format=TUNED_SCHEMA, options=TUNED_OPTIONS),
    Variant("4b-think", "quant", "qwen3:4b, thinking on", model="qwen3:4b", template="tuned", think=True, format=TUNED_SCHEMA, options={**TUNED_OPTIONS, "num_predict": 4096}),
    Variant("kv-q8", "quant", "tuned, KV cache q8_0 + flash attention", template="tuned", think=False, format=TUNED_SCHEMA, options=TUNED_OPTIONS, host=KV_HOST),
    Variant("qwen3-rag", "final", "Modelfile: qwen3:4b + tuned prompt + parameters", model="qwen3-rag", template="tuned", think=False, format=TUNED_SCHEMA, system_in_modelfile=True),
]

BY_NAME = {v.name: v for v in VARIANTS}

FINAL_BASE = "qwen3:4b"  # the model the comparison picked: as accurate as 8b here, twice as fast, 40% of the memory


def modelfile(base: str = FINAL_BASE) -> str:
    """The `qwen3-rag` Modelfile: the tuned system prompt and options baked into a named model.
    Thinking (`think: false`) and the JSON schema are per-request fields, so the client still sends them."""
    from .prompts import TUNED_SYSTEM

    params = "\n".join(f"PARAMETER {k} {v}" for k, v in TUNED_OPTIONS.items())
    return f'FROM {base}\n{params}\nSYSTEM """{TUNED_SYSTEM}"""\n'

