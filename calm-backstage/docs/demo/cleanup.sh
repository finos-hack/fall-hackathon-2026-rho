#!/usr/bin/env bash
# docs/demo/cleanup.sh <service>... : removes what a Template run made for a service, so the name can be used again
# (for example before recording the demo again with the same suffix): the Flux objects (Flux prunes what it applied),
# the service account and its namespace ClusterRole, the namespace, the Gitea repository, output/<name> and its
# catalog location. The architecture stays in CALM Hub (versions cannot be deleted; a new run stores the next patch
# version).
#
# CALM_BACKEND (default http://localhost:7107) is the Backstage backend whose catalog is cleaned.
set -u
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="${CALM_BACKEND:-http://localhost:7107}"
K="kubectl --kubeconfig $R/.kube/config --context calm-backstage"
TOKEN=$(curl -s "$BACKEND/api/auth/guest/refresh" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).backstageIdentity.token)}catch{}})')
for n in "$@"; do
  case "$n" in *[!a-z0-9-]*|"") echo "skipped $n: not a service name"; continue ;; esac
  # Flux prunes as the service account, so it goes only once the Kustomization is gone: without the account Flux
  # cannot prune (it orphans the objects, or the Kustomization stays Terminating).
  if ! $K -n flux-system delete kustomization "calm-$n" --ignore-not-found --wait=true --timeout=120s >/dev/null; then
    echo "Kustomization flux-system/calm-$n is still there (Flux could not prune it); kept its service account. Check: $K -n flux-system get kustomization calm-$n -o yaml" >&2
    exit 1
  fi
  $K -n flux-system delete serviceaccount "calm-$n" --ignore-not-found >/dev/null
  $K delete clusterrolebinding "calm-$n-namespace" --ignore-not-found >/dev/null
  $K delete clusterrole "calm-$n-namespace" --ignore-not-found >/dev/null
  $K -n flux-system delete gitrepository "calm-$n" --ignore-not-found >/dev/null
  $K delete namespace "calm-$n" --ignore-not-found --wait=true --timeout=180s >/dev/null
  curl -s -o /dev/null -u calm:calm-local-dev -X DELETE "http://localhost:3300/api/v1/repos/calm-services/$n"
  if [ -n "$TOKEN" ]; then
    curl -s -H "Authorization: Bearer $TOKEN" "$BACKEND/api/catalog/locations" | node -e '
      let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
        for (const l of JSON.parse(s)) if (l.data.target.endsWith(`/output/${process.argv[1]}/catalog-info.yaml`)) console.log(l.data.id) })' "$n" |
      while read -r id; do curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$BACKEND/api/catalog/locations/$id"; done
  fi
  rm -rf "$R/output/$n"
  echo "cleaned $n"
done
