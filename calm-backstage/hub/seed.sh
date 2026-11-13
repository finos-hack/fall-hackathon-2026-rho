#!/usr/bin/env bash
# Seeds the local CALM Hub with the calm-backstage content in seed/.
#
# Idempotent: every document is POSTed to the URL in its own "$id" (the Hub's name-based API), after a GET
# to that URL shows it is not there yet. Namespace and domain are checked against their list endpoints first.
# Re-running creates nothing new and exits 0.
set -euo pipefail

HUB_URL="${CALM_HUB_URL:-http://localhost:8090}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED_DIR="$ROOT_DIR/seed"
NAMESPACE="hackathon"
NAMESPACE_DESCRIPTION="CALM Backstage hackathon patterns and architectures"
DOMAIN="hackathon-security"

created=0
existing=0

json_field() { # json_field <file> <field>
  node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(d[process.argv[2]] ?? ""))' "$1" "$2"
}

wait_for_hub() {
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "$HUB_URL/api/calm/namespaces"; then return 0; fi
    sleep 2
  done
  echo "seed: CALM Hub not reachable at $HUB_URL (start it with: yarn hub:up)" >&2
  exit 1
}

ensure_namespace() {
  if curl -sf "$HUB_URL/api/calm/namespaces" | node -e '
      let s = ""; process.stdin.on("data", c => s += c).on("end", () =>
        process.exit(JSON.parse(s).values.some(v => v.name === process.argv[1]) ? 0 : 1))' "$NAMESPACE"; then
    echo "exists   namespace $NAMESPACE"; existing=$((existing + 1)); return
  fi
  local body status
  body=$(printf '{"name":"%s","description":"%s"}' "$NAMESPACE" "$NAMESPACE_DESCRIPTION")
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    --data "$body" "$HUB_URL/api/calm/namespaces")
  case "$status" in
    2??) echo "created  namespace $NAMESPACE"; created=$((created + 1)) ;;
    *) echo "seed: POST /api/calm/namespaces returned $status" >&2; exit 1 ;;
  esac
}

ensure_domain() {
  if curl -sf "$HUB_URL/calm/domains" | node -e '
      let s = ""; process.stdin.on("data", c => s += c).on("end", () =>
        process.exit(JSON.parse(s).values.includes(process.argv[1]) ? 0 : 1))' "$DOMAIN"; then
    echo "exists   domain $DOMAIN"; existing=$((existing + 1)); return
  fi
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    --data "{\"name\":\"$DOMAIN\"}" "$HUB_URL/calm/domains")
  case "$status" in
    2??) echo "created  domain $DOMAIN"; created=$((created + 1)) ;;
    *) echo "seed: POST /calm/domains returned $status" >&2; exit 1 ;;
  esac
}

# Posts a CALM document to its own $id unless a GET of that $id already returns it.
ensure_document() { # ensure_document <file>
  local file="$1" id status response
  id=$(json_field "$file" '$id')
  case "$id" in
    "$HUB_URL"/calm/*) ;;
    *) echo "seed: $file has \$id '$id', expected it under $HUB_URL/calm/" >&2; exit 1 ;;
  esac
  local path="${id#"$HUB_URL"}"
  status=$(curl -s -o /dev/null -w '%{http_code}' "$id")
  if [ "$status" = "200" ]; then
    echo "exists   $path"; existing=$((existing + 1)); return
  fi
  response=$(mktemp)
  status=$(curl -s -o "$response" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    --data-binary "@$file" "$id")
  case "$status" in
    2??) echo "created  $path"; created=$((created + 1)) ;;
    409) echo "exists   $path (409)"; existing=$((existing + 1)) ;;
    *) echo "seed: POST $path returned $status: $(cat "$response")" >&2; rm -f "$response"; exit 1 ;;
  esac
  rm -f "$response"
}

wait_for_hub
ensure_namespace
ensure_domain

# Requirements before their configurations: a configuration's control must exist.
for file in "$SEED_DIR"/controls/"$DOMAIN"/*.requirement.json; do ensure_document "$file"; done
for file in "$SEED_DIR"/controls/"$DOMAIN"/*.config.json; do ensure_document "$file"; done
for file in "$SEED_DIR"/patterns/*.pattern.json; do ensure_document "$file"; done
for file in "$SEED_DIR"/architectures/*.architecture.json; do
  [ -e "$file" ] || continue
  ensure_document "$file"
done

echo "seed: done against $HUB_URL ($created created, $existing already present)"
