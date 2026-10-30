#!/usr/bin/env bash
# Creates .env from .env.example, filling every secret with a fresh random value.
# Refuses to touch an existing .env: rotating the encryption key would lock WuzAPI out of its own data.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -e .env ]]; then
  echo ".env already exists — not overwriting it." >&2
  exit 1
fi

rand() { openssl rand -hex "$1"; }

sed \
  -e "s|^WUZAPI_ADMIN_TOKEN=.*|WUZAPI_ADMIN_TOKEN=$(rand 24)|" \
  -e "s|^WUZAPI_GLOBAL_ENCRYPTION_KEY=.*|WUZAPI_GLOBAL_ENCRYPTION_KEY=$(rand 16)|" \
  -e "s|^WUZAPI_GLOBAL_HMAC_KEY=.*|WUZAPI_GLOBAL_HMAC_KEY=$(rand 32)|" \
  -e "s|^WUZAPI_USER_TOKEN=.*|WUZAPI_USER_TOKEN=$(rand 24)|" \
  -e "s|^FILES_ROOT=.*|FILES_ROOT=$HOME|" \
  -e "s|^DOWNLOADS_DIR=.*|DOWNLOADS_DIR=$HOME/Downloads/wuzapi-mcp|" \
  .env.example > .env
chmod 600 .env

# Show times in your own time zone.
tz=""
if [[ -L /etc/localtime ]]; then tz=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||'); fi
if [[ -z "$tz" && -f /etc/timezone ]]; then tz=$(cat /etc/timezone); fi
if [[ -n "$tz" ]]; then sed -i.bak "s|^TZ=.*|TZ=$tz|" .env && rm -f .env.bak; fi

echo "Created .env with random secrets. Next: docker compose up -d, then open http://127.0.0.1:8091"
