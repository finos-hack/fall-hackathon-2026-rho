#!/usr/bin/env bash
# Seeds the local Gitea (hub/docker-compose.yml, http://localhost:3300) that stands in for GitHub:
#
# - the admin user calm / calm-local-dev (local development only; the same values are in app-config.yaml)
# - the public organisations calm-templates (bundle sources: calm-templates/bundles) and calm-services (one
#   repository per service created in Backstage, which Flux deploys from)
#
# Idempotent: each user and organisation is looked up first. Re-running creates nothing new and exits 0.
# The templates repository itself is created and filled by hub/push-bundles.cjs.
set -euo pipefail

GITEA_URL="${CALM_GITEA_URL:-http://localhost:3300}"
CONTAINER="${CALM_GITEA_CONTAINER:-calm-backstage-gitea}"
GITEA_USER="${CALM_GITEA_USER:-calm}"
GITEA_PASSWORD="${CALM_GITEA_PASSWORD:-calm-local-dev}"
ORGS=(calm-templates calm-services)

created=0
existing=0

wait_for_gitea() {
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "$GITEA_URL/api/healthz"; then return 0; fi
    sleep 2
  done
  echo "gitea-seed: Gitea not reachable at $GITEA_URL (start it with: yarn hub:up)" >&2
  exit 1
}

status_of() { curl -s -o /dev/null -w '%{http_code}' -u "$GITEA_USER:$GITEA_PASSWORD" "$1"; }

ensure_user() {
  # Anonymous lookup: the user may not exist yet, so its credentials cannot be used.
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$GITEA_URL/api/v1/users/$GITEA_USER")" = 200 ]; then
    echo "exists   user $GITEA_USER"; existing=$((existing + 1)); return
  fi
  docker exec -u git "$CONTAINER" gitea admin user create --username "$GITEA_USER" --password "$GITEA_PASSWORD" \
    --email "$GITEA_USER@calm-backstage.invalid" --admin --must-change-password=false >/dev/null
  echo "created  user $GITEA_USER"; created=$((created + 1))
}

ensure_org() {
  local org="$1" status
  if [ "$(status_of "$GITEA_URL/api/v1/orgs/$org")" = 200 ]; then
    echo "exists   org $org"; existing=$((existing + 1)); return
  fi
  status=$(curl -s -o /dev/null -w '%{http_code}' -u "$GITEA_USER:$GITEA_PASSWORD" -X POST \
    -H 'Content-Type: application/json' --data "{\"username\":\"$org\",\"visibility\":\"public\"}" \
    "$GITEA_URL/api/v1/orgs")
  case "$status" in
    2??) echo "created  org $org"; created=$((created + 1)) ;;
    *) echo "gitea-seed: POST /api/v1/orgs ($org) returned $status" >&2; exit 1 ;;
  esac
}

wait_for_gitea
ensure_user
for org in "${ORGS[@]}"; do ensure_org "$org"; done
echo "gitea-seed: $created created, $existing already there ($GITEA_URL)"
