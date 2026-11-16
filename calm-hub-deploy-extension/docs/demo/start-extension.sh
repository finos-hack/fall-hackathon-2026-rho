#!/usr/bin/env bash
# start-extension.sh [auto|manual]: (re)starts the gitops-deploy backend in the background, logging to
# .work/extension.log (started afresh), and waits until it listens. manual: each change waits for a person to merge
# its pull request.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
approval="${1:-auto}"
log="$here/.work/extension.log"
pkill -f "$here/node_modules/.bin/tsx src/main.ts" 2>/dev/null && sleep 1 || true
mkdir -p "$here/.work"
cd "$here"
APPROVAL="$approval" nohup npm start >"$log" 2>&1 &
for _ in $(seq 1 60); do
  if grep -q 'listening on' "$log" 2>/dev/null; then
    grep 'listening on' "$log" | sed -E 's/^[^ ]+ [a-z]+ +//'
    exit 0
  fi
  sleep 0.5
done
echo "The extension did not start; see $log" >&2
exit 1
