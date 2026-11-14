#!/usr/bin/env bash
# Deletes the calm-backstage minikube profile and the files k8s/up.sh wrote. Other minikube profiles and your
# ~/.kube/config are not touched.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="calm-backstage"
export KUBECONFIG="$ROOT_DIR/.kube/config"
LOCAL_CONFIG="$ROOT_DIR/app-config.local.yaml"
MARKER="# Written by k8s/up.sh (yarn k8s:up)."

minikube delete -p "$PROFILE"

if [ -f "$LOCAL_CONFIG" ] && head -1 "$LOCAL_CONFIG" | grep -qF "$MARKER"; then
  rm -f "$LOCAL_CONFIG"
  echo "k8s:down: removed $LOCAL_CONFIG (restart Backstage)"
fi
rm -f "$KUBECONFIG"
echo "k8s:down: cluster $PROFILE deleted"
