#!/usr/bin/env bash
# Deploy (or update) the service on a VPS over SSH:  deploy/deploy.sh root@203.0.113.7
#
# First run on a fresh Ubuntu/Debian box: installs Docker, opens the firewall for SSH and the
# service port only, copies .env.example to .env with fresh random keys (printed once), and
# starts the stack. Later runs: copy the code and rebuild; .env and the pulled model stay.
set -euo pipefail
HOST=${1:?usage: deploy/deploy.sh user@host}
DIR=${REMOTE_DIR:-llm-service}
cd "$(dirname "$0")/.."

rsync -az --delete --exclude .venv --exclude .env --exclude results --exclude __pycache__ \
  --exclude .pytest_cache ./ "$HOST:$DIR/"

ssh "$HOST" DIR="$DIR" bash -s <<'REMOTE'
set -euo pipefail
cd "$DIR"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
if [ ! -f .env ]; then
  k1=sk-$(openssl rand -hex 24); k2=sk-$(openssl rand -hex 24); k3=sk-$(openssl rand -hex 24)
  sed "s|^API_KEYS=.*|API_KEYS=me:$k1,demo:$k2:3,load:$k3:1000|" .env.example > .env
  chmod 600 .env
  echo "API keys (also in ~/$DIR/.env):"; grep ^API_KEYS .env
fi
PORT=$(grep ^PORT= .env | cut -d= -f2)
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null && ufw allow "${PORT:-8030}/tcp" >/dev/null && ufw --force enable >/dev/null
fi
docker compose up -d --build
docker compose ps
echo "service: http://$(curl -fsS4 https://ifconfig.me 2>/dev/null || hostname -I | cut -d' ' -f1):${PORT:-8030}/"
REMOTE
