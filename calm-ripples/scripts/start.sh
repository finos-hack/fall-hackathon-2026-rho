#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! docker info >/dev/null 2>&1; then echo 'Start Docker (or Colima) first.' >&2; exit 1; fi
mkdir -p .keys
if [[ ! -f .keys/hub-private.pem || ! -f .keys/hub-public.pem ]]; then
  openssl genrsa -out .keys/temp-rsa.pem 2048 2>/dev/null
  openssl pkcs8 -topk8 -nocrypt -in .keys/temp-rsa.pem -out .keys/hub-private.pem
  openssl rsa -in .keys/temp-rsa.pem -pubout -out .keys/hub-public.pem 2>/dev/null
  rm .keys/temp-rsa.pem
  chmod 644 .keys/hub-private.pem .keys/hub-public.pem
fi
if docker compose version >/dev/null 2>&1; then compose=(docker compose); else compose=(docker-compose); fi
"${compose[@]}" -f compose.yml up -d --build
python3 scripts/seed.py
printf '\nOpen CALM Hub: http://localhost:8091/#/namespace/demo\n'
