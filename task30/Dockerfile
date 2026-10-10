# The gateway: FastAPI + qwen3's tokenizer (baked in at build, so the box needs no Hugging Face access).
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/app/.venv \
    TOKENIZER_PATH=/app/qwen3-tokenizer.json
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
ADD https://huggingface.co/Qwen/Qwen3-4B/resolve/main/tokenizer.json /app/qwen3-tokenizer.json
COPY gateway gateway
COPY web web
COPY checks checks
RUN uv sync --frozen --no-dev
RUN useradd -r app && chmod 644 /app/qwen3-tokenizer.json
USER app
EXPOSE 8030
CMD ["/app/.venv/bin/serve"]
