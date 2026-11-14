#!/usr/bin/env bash
# Copies the CALM release meta-schemas (<version>/meta/*.json) from the @finos/calm-cli package into
# hub/.schemas/release, which MongoDB's init-mongo.js reads via CALM_RELEASE_SCHEMA_PATH.
set -euo pipefail

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HUB_DIR/.." && pwd)"
SRC="$ROOT_DIR/node_modules/@finos/calm-cli/dist/calm/release"
DEST="$HUB_DIR/.schemas/release"

if [ ! -d "$SRC" ]; then
  echo "copy-schemas: $SRC not found. Run 'yarn install' at the repository root first (needs @finos/calm-cli)." >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST"/
echo "copy-schemas: copied $(ls "$DEST" | tr '\n' ' ')from $SRC to $DEST"
