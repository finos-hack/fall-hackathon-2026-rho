#!/usr/bin/env bash
# Starts the local Kubernetes cluster for calm-backstage and tells Backstage how to read it.
#
# - minikube profile "calm-backstage" (docker driver, Calico so NetworkPolicies are enforced, 6 GiB and 4 CPUs
#   for the Java starters' builds), with Flux's source and kustomize controllers and cert-manager.
# - Its kubeconfig goes to <repo>/.kube/config (git-ignored). Your own ~/.kube/config, its current context and any
#   other minikube profiles are not touched.
# - A read-only service account lets the Backstage Kubernetes plugin list workloads. Its token, the API server URL
#   and the cluster CA are written to app-config.local.yaml (git-ignored). The docker driver can pick a new API
#   server port on each start, so this file is rewritten every time: restart Backstage after running this.
#
# Start: yarn k8s:up   Remove: yarn k8s:down
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="calm-backstage"
export KUBECONFIG="$ROOT_DIR/.kube/config"
LOCAL_CONFIG="$ROOT_DIR/app-config.local.yaml"
MARKER="# Written by k8s/up.sh (yarn k8s:up). Do not edit: it is rewritten on every start."

for bin in minikube kubectl; do
  command -v "$bin" >/dev/null || { echo "k8s:up: $bin not found on PATH" >&2; exit 1; }
done

if [ -f "$LOCAL_CONFIG" ] && ! head -1 "$LOCAL_CONFIG" | grep -qF "$MARKER"; then
  echo "k8s:up: $LOCAL_CONFIG exists and was not written by this script; move it away first." >&2
  exit 1
fi

kc() { kubectl --kubeconfig "$KUBECONFIG" --context "$PROFILE" "$@"; }

mkdir -p "$ROOT_DIR/.kube"
minikube start -p "$PROFILE" --driver=docker --cni=calico --memory=6144 --cpus=4

echo "k8s:up: waiting for Calico"
kc -n kube-system rollout status daemonset/calico-node --timeout=300s
kc -n kube-system rollout status deployment/calico-kube-controllers --timeout=300s

# Flux (source and kustomize controllers only, pinned in k8s/flux-install.cjs): deploys each service from its
# repository in the local Gitea (http://host.minikube.internal:3300 from inside the cluster).
echo "k8s:up: installing Flux"
node "$ROOT_DIR/k8s/flux-install.cjs" | kc apply --server-side --force-conflicts -f - >/dev/null
kc -n flux-system rollout status deployment/source-controller --timeout=300s
kc -n flux-system rollout status deployment/kustomize-controller --timeout=300s

# cert-manager (pinned release): the deployment rules k8s-deploy 1.3.0 and later issue the certificates for TLS
# between workloads (the gateway to the service) with its Issuer and Certificate resources.
CERT_MANAGER_VERSION="v1.16.2"
echo "k8s:up: installing cert-manager $CERT_MANAGER_VERSION"
kc apply -f "https://github.com/cert-manager/cert-manager/releases/download/$CERT_MANAGER_VERSION/cert-manager.yaml" >/dev/null
kc -n cert-manager rollout status deployment/cert-manager --timeout=300s
kc -n cert-manager rollout status deployment/cert-manager-cainjector --timeout=300s
kc -n cert-manager rollout status deployment/cert-manager-webhook --timeout=300s

kc apply -f "$ROOT_DIR/k8s/backstage-reader.yaml"

SERVER="$(kc config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
CA_DATA="$(kc config view --minify --raw --flatten -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
TOKEN=""
for _ in $(seq 1 30); do
  TOKEN="$(kc -n calm-backstage-system get secret backstage-reader-token -o jsonpath='{.data.token}' 2>/dev/null | base64 --decode || true)"
  [ -n "$TOKEN" ] && break
  sleep 1
done
[ -n "$TOKEN" ] || { echo "k8s:up: no token for service account backstage-reader" >&2; exit 1; }

umask 077
cat > "$LOCAL_CONFIG" <<EOF
$MARKER
kubernetes:
  serviceLocatorMethod:
    type: multiTenant
  clusterLocatorMethods:
    - type: config
      clusters:
        - name: $PROFILE
          url: $SERVER
          authProvider: serviceAccount
          serviceAccountToken: $TOKEN
          caData: $CA_DATA
          skipMetricsLookup: true
EOF

echo "k8s:up: cluster $PROFILE is up at $SERVER"
echo "k8s:up: wrote $LOCAL_CONFIG (restart Backstage to pick it up)"
echo "k8s:up: kubectl --kubeconfig $KUBECONFIG --context $PROFILE get pods -A"
