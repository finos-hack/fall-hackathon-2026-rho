#!/usr/bin/env bash
# Starts (or restarts) CALM Hub from calm-backstage/hub/docker-compose.yml with the gitops-deploy extension loaded.
#
#   scripts/hub-up.sh            # uses ../calm-backstage/hub/docker-compose.yml
#   CALM_BACKSTAGE_DIR=/path/to/calm-backstage scripts/hub-up.sh
#
# Creates a P-256 signing key pair in .keys/ on first run. The keys are for local development only: the private key
# is made readable by the container user (185), which a real deployment must not do.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
backstage="${CALM_BACKSTAGE_DIR:-$here/../calm-backstage}"
backstage="$(cd "$backstage" && pwd)"
keys="$here/.keys"

mkdir -p "$keys"
if [[ ! -f "$keys/hub-private.pem" ]]; then
  # Node, not openssl: macOS's LibreSSL writes the curve as explicit parameters, which CALM Hub refuses
  # ("must be an RSA key (RS256) or a P-256 key (ES256)"). CALM Hub needs PKCS#8 with the named curve.
  node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const fs = require("node:fs");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    fs.writeFileSync(process.argv[1], privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.writeFileSync(process.argv[2], publicKey.export({ type: "spki", format: "pem" }));
  ' "$keys/hub-private.pem" "$keys/hub-public.pem"
fi
chmod 644 "$keys/hub-private.pem" "$keys/hub-public.pem"

export EXT_DIR="$here/extension"
export KEYS_DIR="$keys"

compose=(docker compose -f "$backstage/hub/docker-compose.yml" -f "$here/hub/compose.override.yml")

if [[ "${1:-}" == "config" ]]; then
  "${compose[@]}" config calmhub
  exit 0
fi

# The schemas the base file mounts into MongoDB must exist (calm-backstage's yarn hub:up does this).
"$backstage/hub/copy-schemas.sh"
"${compose[@]}" up -d --no-deps --force-recreate calmhub

echo "Waiting for CALM Hub on http://localhost:8090 ..."
for _ in $(seq 1 60); do
  if curl -fs http://localhost:8090/api/calm/extensions >/dev/null 2>&1; then
    curl -fs http://localhost:8090/api/calm/extensions | head -c 400
    echo
    exit 0
  fi
  sleep 2
done
echo "CALM Hub did not answer; see: docker logs calm-backstage-hub" >&2
exit 1
