#!/usr/bin/env bash
# Fresh-droplet deploy for crowd-rapp. Ubuntu 22.04/24.04.
set -e
echo "== crowd-rapp deploy =="

# 1. Node 20 if missing
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 2. backend deps
npm install --omit=dev

# 3. build frontend
( cd frontend && npm install && npm run build )

# 4. env file
if [ ! -f .env ]; then
  cp .env.example .env
  echo ">> edit .env to set MODEL_PROVIDER / keys, then: pm2 restart crowd-rapp"
fi

# 5. pm2
if ! command -v pm2 >/dev/null; then sudo npm install -g pm2; fi
pm2 delete crowd-rapp 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
echo "== up on :3000 (point nginx at it). See nginx.conf =="
