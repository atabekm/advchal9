"""`uv run serve`: the gateway on HOST:PORT (default 0.0.0.0:8030), configured from the environment."""

from __future__ import annotations

import logging
import os

import uvicorn

from .app import create_app
from .config import from_env
from .limits import TokenCounter
from .ollama import Ollama

log = logging.getLogger("gateway")

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    settings = from_env()
    backend = Ollama(settings.ollama_url, settings.model, settings.max_context, settings.request_timeout,
                     settings.num_thread)
    app = create_app(settings, backend, TokenCounter(settings.tokenizer_path))

    @app.on_event("startup")
    async def warm():
        try:
            await backend.warm()
            log.info("%s loaded with %s", settings.model, backend.options)
        except Exception as e:  # the service still starts; the first request loads it instead
            log.warning("could not load %s yet: %r", settings.model, e)
    log.info(
        "serving %s from %s for %d key(s): context %d, output %d, %d rpm, %d at once + %d queued",
        settings.model, settings.ollama_url, len(settings.keys), settings.max_context, settings.max_output,
        settings.rate_limit_rpm, settings.max_concurrent, settings.max_queue)
    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", 8030)),
                log_level="warning", timeout_graceful_shutdown=5)
