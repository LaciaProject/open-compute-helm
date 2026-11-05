#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
export EVIDENCE_DIR=${EVIDENCE_DIR:-"$root/.test-output/weft"}
mkdir -p "$EVIDENCE_DIR"
namespace=weft-compat
pod=weft-runtime-0
forward_pid=
diagnostics() {
  result=$?
  trap - EXIT
  if [[ -n "$forward_pid" ]]; then kill "$forward_pid" 2>/dev/null || true; wait "$forward_pid" 2>/dev/null || true; fi
  kubectl get pods,pvc,svc -n "$namespace" -o wide > "$EVIDENCE_DIR/resources.txt" 2>&1 || true
  kubectl describe pod "$pod" -n "$namespace" > "$EVIDENCE_DIR/pod.txt" 2>&1 || true
  kubectl get events -n "$namespace" --sort-by=.metadata.creationTimestamp > "$EVIDENCE_DIR/events.txt" 2>&1 || true
  for container in initialize configure-origin open-compute; do
    kubectl logs -n "$namespace" "$pod" -c "$container" > "$EVIDENCE_DIR/$container.log" 2>&1 || true
    kubectl logs -n "$namespace" "$pod" -c "$container" --previous > "$EVIDENCE_DIR/$container-previous.log" 2>&1 || true
  done
  exit "$result"
}
trap diagnostics EXIT

kubectl create namespace "$namespace"
kubectl create secret generic weft-ci-auth -n "$namespace" \
  --from-literal=admin-token=weft-ci-admin-fixture \
  --from-literal=deployer-token=weft-ci-deployer-fixture \
  --from-literal=read-only-token=weft-ci-reader-fixture
runtime_digest=$(node -p 'JSON.parse(require("fs").readFileSync(".github/weft-compatibility.lock.json")).runtimeImage.split("@")[1]')
init_digest=$(node -p 'JSON.parse(require("fs").readFileSync(".github/weft-compatibility.lock.json")).initImage.split("@")[1]')
helm install weft-runtime "$root/charts/open-compute" -n "$namespace" \
  --set fullnameOverride=weft-runtime --set auth.existingSecret=weft-ci-auth \
  --set image.digest="$runtime_digest" --set initImage.digest="$init_digest" \
  --set persistence.size=4Gi --wait --timeout 5m
kubectl port-forward -n "$namespace" svc/weft-runtime 18789:8787 > "$EVIDENCE_DIR/port-forward.log" 2>&1 &
forward_pid=$!
for ((attempt=0; attempt<60; attempt++)); do
  if curl -fsS http://127.0.0.1:18789/health/live >/dev/null 2>&1; then break; fi
  sleep 1
done
export OPEN_COMPUTE_ORIGIN=http://127.0.0.1:18789
node "$root/.github/scripts/weft-compatibility.mjs" --strict
