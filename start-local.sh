#!/bin/sh
# Start the local source workspace. The OpenAI key stays in this process.
set -eu
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [ ! -x "$NODE_BIN" ]; then
  printf '%s\n' 'Node.js is required. Install Node.js 20 or newer, then run ./start-local.sh again.' >&2
  exit 1
fi
NODE_DIR=$(dirname "$NODE_BIN")
export PATH="$NODE_DIR:$PATH"

if [ ! -d node_modules ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile
  elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm" ]; then
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm" install --frozen-lockfile
  elif command -v npm >/dev/null 2>&1; then
    npm ci
  else
    printf '%s\n' 'Install npm or pnpm, then run ./start-local.sh again.' >&2
    exit 1
  fi
fi

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import openai, pydantic, requests, bs4, reportlab, openpyxl, pandas, fitz' >/dev/null 2>&1; then
  .venv/bin/python -m pip install -r requirements.txt
fi
export PYTHON_BIN="$PWD/.venv/bin/python"
printf '%s\n' 'Open http://127.0.0.1:5173/ in your browser. Press Ctrl+C here to stop.'
exec "$NODE_BIN" node_modules/vite/bin/vite.js --configLoader runner --host 127.0.0.1 --strictPort
