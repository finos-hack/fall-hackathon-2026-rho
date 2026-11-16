#!/usr/bin/env bash
# ext-log.sh [lines]: the newest lines of the extension's log, without timestamps, and without the history calls
# watch-deploy.sh makes every 2 s. Calls CALM Hub made (and the backend verified) are in blue.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
grep -E '^[0-9]{4}-' "$here/.work/extension.log" | grep -v 'route=history' | tail -n "${1:-8}" |
  sed -E 's/^[^ ]+ [a-z]+ +\[platform-connector\] //' |
  sed -E $'s/^(.*← CALM Hub.*)$/\e[1;34m\\1\e[0m/' | fold -s -w 96
