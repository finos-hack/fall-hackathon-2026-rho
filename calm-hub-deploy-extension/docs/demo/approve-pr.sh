#!/usr/bin/env bash
# approve-pr.sh <repository> <pull-request>: merges a pull request in Gitea's calm-services organisation, as the
# person approving the change would. Gitea answers 405 until it has worked out that the branch merges, so retry.
set -euo pipefail
REPO="${1:?usage: approve-pr.sh <repository> <pull-request>}"
PR="${2:?usage: approve-pr.sh <repository> <pull-request>}"
URL="${GITEA_URL:-http://localhost:3300}/api/v1/repos/calm-services/$REPO/pulls/$PR/merge"
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "${GITEA_USER:-calm}:${GITEA_PASSWORD:-calm-local-dev}" \
    -H 'content-type: application/json' -d '{"Do":"merge"}' "$URL")
  if [ "$code" = 200 ]; then echo "Merged pull request #$PR"; exit 0; fi
  sleep 1
done
echo "Could not merge pull request #$PR (last answer $code)" >&2
exit 1
