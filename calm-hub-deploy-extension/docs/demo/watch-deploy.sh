#!/usr/bin/env bash
# watch-deploy.sh <architecture> <version> [timeout-seconds]: a live view of a deployment started from CALM Hub,
# redrawn every 2 s: the newest deployment recorded for the version (from the extension's history), Flux, the
# Deployments and the network policies in calm-<architecture>. Exits when the deployment is completed (and every
# Deployment is available) or failed. Uses $KUBECONFIG, context calm-backstage, and $EXT.
set -u
NAME="${1:?usage: watch-deploy.sh <architecture> <version> [timeout-seconds]}"
VERSION="${2:?usage: watch-deploy.sh <architecture> <version> [timeout-seconds]}"
LIMIT="${3:-300}"
NS="calm-$NAME"
K="kubectl --context calm-backstage"
START=$(date +%s)
B=$'\e[1m' DIM=$'\e[2m' G=$'\e[32m' Y=$'\e[33m' RED=$'\e[31m' R=$'\e[0m'

while :; do
  now=$(($(date +%s) - START))
  dep=$(curl -s "$EXT/history/namespaces/hackathon/architectures/$NAME/deployments" |
    jq -r --arg v "$VERSION" '[.deployments[] | select(.version == $v)][0] // empty | "\(.status)\t\(.notes // "")"')
  status="${dep%%$'\t'*}"
  notes="${dep#*$'\t'}"
  ks=$($K -n flux-system get kustomization "calm-$NAME" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status} {.status.lastAppliedRevision}' 2>/dev/null)
  read -r ready rev <<<"$ks"
  deploys=$($K -n "$NS" get deploy --no-headers 2>/dev/null)
  policies=$($K -n "$NS" get networkpolicy --no-headers -o custom-columns=N:.metadata.name 2>/dev/null)

  case "$status" in
    completed) s="${G}completed${R}" ;;
    failed) s="${RED}failed${R}" ;;
    "") s="${DIM}not recorded yet${R}" ;;
    *) s="${Y}${status}${R}" ;;
  esac
  frame="${B}Deploying $NAME $VERSION${R}  ${DIM}$(printf '%d:%02d' $((now / 60)) $((now % 60)))${R}"$'\n\n'
  frame+="CALM Hub  $s"$'\n'
  [ -n "$notes" ] && frame+="          ${DIM}$(fold -s -w 70 <<<"$notes" | sed '2,$s/^/          /')${R}"$'\n'
  frame+=$'\n'
  [ "${ready:-}" = True ] && fs="${G}Ready${R}" || fs="${Y}Applying${R}"
  frame+="Flux      $fs  ${DIM}${rev:-}${R}"$'\n\n'
  frame+="${B}Deployments${R}"$'\n'
  frame+=$(awk '{ split($2, r, "/"); c = (r[1] == r[2]) ? "\033[32m" : "\033[33m";
    printf "  %-22s %s%s\033[0m\n", $1, c, $2 }' <<<"$deploys")$'\n\n'
  frame+="${B}Network policies${R}  $(grep -c . <<<"$policies")"$'\n'
  frame+=$(sed 's/^/  /' <<<"$policies")$'\n'
  printf '\e[H\e[2J%s' "$frame"

  notready=$(awk '{ split($2, r, "/"); if (r[1] != r[2]) n++ } END { print n + 0 }' <<<"$deploys")
  if [ "$status" = completed ] && [ "$notready" = 0 ]; then
    printf '\n%sDeployed after %d:%02d%s\n' "$G" $((now / 60)) $((now % 60)) "$R"
    exit 0
  fi
  if [ "$status" = failed ]; then
    printf '\n%sThe deployment failed: nothing was changed in Git or the cluster%s\n' "$RED" "$R"
    exit 0
  fi
  if [ "$now" -ge "$LIMIT" ]; then
    printf '\nStill running after %d s\n' "$now"
    exit 1
  fi
  sleep 2
done
