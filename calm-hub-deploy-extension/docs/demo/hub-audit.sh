#!/usr/bin/env bash
# hub-audit.sh <audit-id>: CALM Hub's audit log line for one call (the jti CALM Hub signed it with), one field a line.
set -euo pipefail
JTI="${1:?usage: hub-audit.sh <audit-id>}"
docker logs "${CALM_HUB_CONTAINER:-calm-backstage-hub}" 2>&1 | grep -F "jti=[$JTI]" | tail -n 1 | grep -o 'AUDIT.*' |
  grep -oE '[a-zA-Z]+=\[[^]]*\]' | grep -vE '^(domain|sourceIp|entityId)=' | sed 's/^/  /'
