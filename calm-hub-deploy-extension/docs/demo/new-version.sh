#!/usr/bin/env bash
# new-version.sh <architecture> (--choose "<decision>=<choice>" | --connect <source>:<destination> | --no-pattern):
# stores a new version of a hackathon architecture in CALM Hub (scripts/new-version.ts, which says what each does).
set -euo pipefail
cd "${CALM_DEMO_DIR:-$(dirname "$0")/../..}"
exec npx tsx scripts/new-version.ts hackathon "$@"
