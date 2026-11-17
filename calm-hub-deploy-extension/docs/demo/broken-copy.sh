#!/usr/bin/env bash
# broken-copy.sh <decorator-id> [namespace]: posts a copy of a deployment decorator to CALM Hub with its
# data.kubernetes.namespace removed and a new unique-id, to show that CALM Hub validates a record against the standard
# in its $schema. Prints CALM Hub's answer. Exits 0 only when CALM Hub refuses the copy (HTTP 400); anything else is
# reported as an error, with the id of any copy CALM Hub stored by mistake.
set -euo pipefail
ID="${1:?usage: broken-copy.sh <decorator-id> [namespace]}"
NAMESPACE="${2:-hackathon}"
URL="${HUB:-http://localhost:8090}/api/calm/namespaces/$NAMESPACE/decorators"
# CALM Hub reads a decorator back in camel case; it takes one in kebab case, as the standard writes it.
copy=$(curl -sf "$URL/$ID" | jq --arg suffix "copy-$(date +%s)" '{
  "$schema": (.["$schema"] // .schema),
  "unique-id": "\(.uniqueId // .["unique-id"])-\($suffix)",
  type,
  target,
  "target-type": (.targetType // .["target-type"]),
  "applies-to": (.appliesTo // .["applies-to"]),
  data: (.data | del(.kubernetes.namespace))
}')
# CALM Hub validates only against the standards it bundles: a copy of any other record would be stored, not refused.
STANDARD=https://calm.finos.org/standards/deployment/1.0/kubernetes.decorator.standard.json
if [ "$(jq -r '."$schema" // empty' <<<"$copy")" != "$STANDARD" ]; then
  echo "Decorator $ID is not stamped with $STANDARD: CALM Hub would store the copy unvalidated, so nothing was posted" >&2
  exit 1
fi
jq -r '"Posting \(."unique-id"): data.kubernetes = \(.data.kubernetes | tojson)"' <<<"$copy"
answer=$(curl -s -w '\n%{http_code}' -H 'content-type: application/json' -d "$copy" "$URL")
code="${answer##*$'\n'}"
body="${answer%$'\n'*}"
echo "HTTP $code"
jq '{error, errors}' <<<"$body" 2>/dev/null || echo "$body"
if [ "$code" != 400 ]; then
  echo "CALM Hub did not refuse the copy (expected HTTP 400)" >&2
  exit 1
fi
