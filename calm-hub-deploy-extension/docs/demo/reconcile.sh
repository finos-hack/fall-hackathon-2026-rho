#!/usr/bin/env bash
# reconcile.sh <name>: asks Flux to reconcile the Kustomization calm-<name> in flux-system now (rather than at its next
# interval), by annotating reconcile.fluxcd.io/requestedAt, and waits until Flux has handled the request.
# Uses $KUBECONFIG and context calm-backstage.
set -euo pipefail
NAME="${1:?usage: reconcile.sh <name>}"
KS="calm-$NAME"
K=(kubectl --context calm-backstage -n flux-system)
TOKEN="$(date +%s)"
"${K[@]}" annotate --overwrite "kustomization/$KS" "reconcile.fluxcd.io/requestedAt=$TOKEN" >/dev/null
echo "Asked Flux to reconcile $KS"
for _ in $(seq 1 120); do
  handled=$("${K[@]}" get "kustomization/$KS" -o jsonpath='{.status.lastHandledReconcileAt}' 2>/dev/null || true)
  if [ "$handled" = "$TOKEN" ]; then
    rev=$("${K[@]}" get "kustomization/$KS" -o jsonpath='{.status.lastAppliedRevision}')
    echo "Flux reconciled $KS: applied $rev"
    exit 0
  fi
  sleep 0.5
done
echo "Flux did not handle the request within 60 s" >&2
exit 1
