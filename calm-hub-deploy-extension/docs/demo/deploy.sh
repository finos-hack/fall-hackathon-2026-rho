#!/usr/bin/env bash
# deploy.sh <architecture> <version>: what "Deploy this version" does. Asks the Platform Connector, through CALM Hub's
# extension API, to deploy a version of a hackathon architecture, then follows the job (watch-deploy.sh).
set -euo pipefail
NAME="${1:?usage: deploy.sh <architecture> <version>}"
VERSION="${2:?usage: deploy.sh <architecture> <version>}"
EXT="${EXT:-http://localhost:8090/api/calm/extensions/platform-connector/api}"
curl -s -X POST -H 'content-type: application/json' -d '{}' \
  "$EXT/namespaces/hackathon/architectures/$NAME/versions/$VERSION/deployments" | jq -c .
exec "$(dirname "$0")/watch-deploy.sh" "$NAME" "$VERSION"
