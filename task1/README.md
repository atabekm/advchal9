# DeepSeek CLI

Ask a question, get an answer from the DeepSeek API, printed in your terminal.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env    # then paste your key into .env
```

Get a key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys).

## Usage

One-shot — ask and exit:

```bash
python main.py "Explain recursion in one paragraph"
```

Interactive chat — remembers the conversation:

```bash
python main.py
You> What is a monad?
AI > ...
You> Give me an example in Python
AI > ...
You> /exit
```

`/reset` clears the history, `/exit` (or Ctrl-C) quits.

## Options

| Flag | Purpose |
| --- | --- |
| `--model NAME` | `deepseek-chat` (default) or `deepseek-reasoner` |
| `--system TEXT` | System prompt to steer the answer |
| `--no-stream` | Wait for the full reply instead of streaming it |

```bash
python main.py --model deepseek-reasoner "Is 8191 prime? Show your work."
python main.py --system "Answer only in haiku." "Describe the ocean."
```

## Layout

- `main.py` — CLI: argument parsing, chat loop, output
- `deepseek_client.py` — HTTP calls to DeepSeek, error handling

The client is independent of the CLI, so `ask()` / `ask_stream()` can be imported
from other code.
