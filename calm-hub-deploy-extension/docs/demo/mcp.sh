#!/usr/bin/env bash
# mcp.sh <tool> <arguments-json>: calls one tool on CALM Hub's MCP server (streamable HTTP) and prints its structured
# result, as an agent would. e.g. mcp.sh ext_platform-connector_status '{"namespace":"hackathon","architecture":"x"}'
# mcp.sh --list [prefix]: the names and descriptions of the tools (starting with prefix).
set -euo pipefail
TOOL="${1:?usage: mcp.sh <tool> <arguments-json>}"
ARGS="${2:-{\}}"
URL="${HUB:-http://localhost:8090}/mcp"
H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
SESSION=$(curl -s -D - -o /dev/null -X POST "$URL" "${H[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}' |
  tr -d '\r' | awk 'tolower($1) == "mcp-session-id:" { print $2 }')
curl -s -X POST "$URL" "${H[@]}" -H "mcp-session-id: $SESSION" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
if [ "$TOOL" = --list ]; then
  # tools/list comes in pages of 50: follow nextCursor.
  cursor=""
  while :; do
    params=$([ -n "$cursor" ] && printf '{"cursor":"%s"}' "$cursor" || echo '{}')
    page=$(curl -s -X POST "$URL" "${H[@]}" -H "mcp-session-id: $SESSION" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":$params}" | sed -n 's/^data: //p; /^{/p')
    jq -r --arg p "${2:-}" '.result.tools[] | select(.name | startswith($p)) | "\(.name)\n    \(.description | .[0:90])"' <<<"$page"
    cursor=$(jq -r '.result.nextCursor // empty' <<<"$page")
    [ -n "$cursor" ] || break
  done
  exit 0
fi
curl -s -X POST "$URL" "${H[@]}" -H "mcp-session-id: $SESSION" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}" |
  sed -n 's/^data: //p; /^{/p' | jq '.result.structuredContent // .result // .error'
