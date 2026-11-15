#!/usr/bin/env bash
# watch-cluster.sh <service> [timeout-seconds]: a live view of a service arriving in the cluster, redrawn every 2 s
# until its Flux Kustomization is ready and every pod in calm-<service> is ready (or the timeout, default 600 s).
# Uses $KUBECONFIG, context calm-backstage.
set -u
NAME="${1:?usage: watch-cluster.sh <service> [timeout-seconds]}"
LIMIT="${2:-600}"
NS="calm-$NAME"
K="kubectl --context calm-backstage"
START=$(date +%s)
B=$'\e[1m' DIM=$'\e[2m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[0m'

while :; do
  now=$(($(date +%s) - START))
  ks=$($K -n flux-system get kustomization "calm-$NAME" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status} {.status.lastAppliedRevision}' 2>/dev/null)
  pods=$($K -n "$NS" get pods --no-headers 2>/dev/null)
  policies=$($K -n "$NS" get networkpolicy --no-headers 2>/dev/null | wc -l | tr -d ' ')
  frame="${B}$NS${R}  ${DIM}$(printf '%d:%02d' $((now / 60)) $((now % 60)))${R}"$'\n\n'
  if [ -z "$ks" ]; then
    frame+="Flux  ${DIM}no Kustomization yet: Backstage is generating, pushing to Git and building${R}"$'\n'
  else
    read -r ready rev <<<"$ks"
    [ "$ready" = True ] && state="${G}Ready${R}" || state="${Y}Applying${R}"
    frame+="Flux  calm-$NAME  $state  ${DIM}${rev:-}${R}"$'\n'
  fi
  frame+=$'\n'
  if [ -n "$pods" ]; then
    frame+="${B}Pods${R}"$'\n'
    frame+=$(awk '{ split($2, r, "/"); c = (r[1] == r[2] && $3 == "Running") ? "\033[32m" : "\033[33m";
      printf "  %-40s %s%-6s %s\033[0m\n", $1, c, $2, $3 }' <<<"$pods")$'\n\n'
    frame+="${B}Network policies${R}  $policies"$'\n'
  else
    frame+="${DIM}namespace $NS: no pods yet${R}"$'\n'
  fi
  printf '\e[H\e[2J%s' "$frame"
  notready=$(awk '{ split($2, r, "/"); if (r[1] != r[2] || $3 != "Running") n++ } END { print n + 0 }' <<<"$pods")
  if [ "${ready:-}" = True ] && [ -n "$pods" ] && [ "$notready" = 0 ]; then
    printf '\n%sAll %d pods ready after %d:%02d%s\n' "$G" "$(wc -l <<<"$pods" | tr -d ' ')" $((now / 60)) $((now % 60)) "$R"
    exit 0
  fi
  if [ "$now" -ge "$LIMIT" ]; then
    printf '\nStill not ready after %d s\n' "$now"
    exit 1
  fi
  sleep 2
done
