#!/usr/bin/env bash
# Run against the disposable Kind cluster created by the workflow.
set -euo pipefail

namespace=open-compute
release=open-compute
pod=open-compute-0
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
evidence=${EVIDENCE_DIR:-"$root/.test-output"}
mkdir -p "$evidence"

diagnostics() {
  result=$?
  trap - EXIT
  kubectl get pods,pvc,svc -n "$namespace" -o wide > "$evidence/resources.txt" 2>&1 || true
  kubectl describe pod "$pod" -n "$namespace" > "$evidence/pod.txt" 2>&1 || true
  kubectl get events -n "$namespace" --sort-by=.metadata.creationTimestamp > "$evidence/events.txt" 2>&1 || true
  for container in initialize configure-origin open-compute; do
    kubectl logs -n "$namespace" "$pod" -c "$container" > "$evidence/$container.log" 2>&1 || true
  done
  kubectl exec -n "$namespace" "$pod" -c open-compute -- \
    cat /var/lib/open-compute/init-daemon.log > "$evidence/bootstrap.log" 2>&1 || true
  exit "$result"
}
trap diagnostics EXIT
trap 'echo "Smoke test failed at line $LINENO" >&2' ERR

kubectl create namespace "$namespace"
# These are disposable CI credentials, not deployment credentials.
kubectl create secret generic open-compute-auth -n "$namespace" \
  --from-literal=admin-token="ci-admin-literal-'\$-token" \
  --from-literal=deployer-token="ci-deployer-literal-'\$-token" \
  --from-literal=read-only-token="ci-reader-literal-'\$-token"

helm install "$release" "$root/charts/open-compute" -n "$namespace" \
  --set auth.existingSecret=open-compute-auth --set persistence.size=2Gi \
  --wait --timeout 10m

exec_oc() { kubectl exec -n "$namespace" "$pod" -c open-compute -- "$@"; }
api() {
  local token=$1
  shift
  # curl runs inside the Pod, so credentials are never printed in runner output.
  exec_oc curl --fail-with-body -sS -H "Authorization: Bearer $token" "$@"
}
admin="ci-admin-literal-'\$-token"
reader="ci-reader-literal-'\$-token"
deployer="ci-deployer-literal-'\$-token"
base=http://127.0.0.1:8787/client/v4

exec_oc /opt/open-compute/ocd --no-update-check --system instances --json > "$evidence/instances-before.json"
exec_oc sh -ec 'test "$(id -u)" = 65532; test "$(stat -c %a /var/lib/open-compute/instances/default/data/keys/master.key)" = 600'
exec_oc sha256sum /var/lib/open-compute/instances/default/data/keys/master.key > "$evidence/key-before.txt"
exec_oc curl -fsS http://127.0.0.1:8787/health/live
exec_oc curl -fsS http://127.0.0.1:8787/health/ready

# Reach the workload through Service DNS from another Pod.
kubectl run service-check -n "$namespace" --restart=Never \
  --image=ghcr.io/elliothux/open-compute:0.4.0 \
  --command -- /usr/bin/curl -fsS "http://open-compute:8787/health/live"
kubectl wait -n "$namespace" pod/service-check --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s

code=$(exec_oc curl -sS -o /dev/null -w '%{http_code}' "$base/accounts")
test "$code" = 401
for token in "$admin" "$deployer" "$reader"; do
  api "$token" "$base/user/tokens/verify" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["success"] and r["result"]["status"]=="active", r'
done
api "$admin" "$base/accounts" > "$evidence/accounts-before.json"
account=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["success"] and len(r["result"])==1, r; print(r["result"][0]["id"])' "$evidence/accounts-before.json")
code=$(exec_oc curl -sS -o /dev/null -w '%{http_code}' "$base/accounts/$account")
test "$code" = 401
kv="$base/accounts/$account/storage/kv/namespaces"

code=$(exec_oc curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $reader" -H 'Content-Type: application/json' \
  -d '{"title":"must-be-denied"}' "$kv")
test "$code" = 403
api "$deployer" -H 'Content-Type: application/json' -d '{"title":"helm-ci"}' "$kv" > "$evidence/namespace.json"
kv_id=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["success"], r; print(r["result"]["id"])' "$evidence/namespace.json")
api "$deployer" -X PUT -H 'Content-Type: text/plain' --data-binary 'survives-pod-recreation' "$kv/$kv_id/values/smoke" > /dev/null
test "$(api "$reader" "$kv/$kv_id/values/smoke")" = survives-pod-recreation
echo "Installation, Service DNS, authentication roles and KV writes passed."

# Recreate the whole Pod so init containers run again against the retained PVC.
old_uid=$(kubectl get pod "$pod" -n "$namespace" -o jsonpath='{.metadata.uid}')
kubectl delete pod "$pod" -n "$namespace" --wait=true
kubectl rollout status statefulset/"$release" -n "$namespace" --timeout=5m
new_uid=$(kubectl get pod "$pod" -n "$namespace" -o jsonpath='{.metadata.uid}')
test "$old_uid" != "$new_uid"
exec_oc /opt/open-compute/ocd --no-update-check --system instances --json > "$evidence/instances-after.json"
exec_oc sha256sum /var/lib/open-compute/instances/default/data/keys/master.key > "$evidence/key-after.txt"
cmp "$evidence/key-before.txt" "$evidence/key-after.txt"
test "$(api "$reader" "$kv/$kv_id/values/smoke")" = survives-pod-recreation
kubectl logs -n "$namespace" "$pod" -c initialize | tee "$evidence/reinitialize.log"
grep -Fq 'already initialized' "$evidence/reinitialize.log"
python3 - "$evidence" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1])
before,after=(json.loads((root/f'instances-{stage}.json').read_text())['instances'] for stage in ['before','after'])
assert len(before)==len(after)==1
assert before[0]['instance_id']==after[0]['instance_id']
assert before[0]['state']==after[0]['state']=='running'
PY
echo "Pod recreation preserved the instance, master key and KV data."

# Exercise Helm upgrade and the ConfigMap checksum-triggered rollout.
helm upgrade "$release" "$root/charts/open-compute" -n "$namespace" --reuse-values \
  --set config.publicOrigin=https://compute.example.com --wait --timeout 5m
exec_oc sh -ec 'grep -Fxq '\''public_origin = "https://compute.example.com"'\'' /var/lib/open-compute/instances/default/compute.toml'
test "$(api "$reader" "$kv/$kv_id/values/smoke")" = survives-pod-recreation
echo "Helm upgrade updated the origin and preserved KV data."

# StatefulSet-generated PVCs must survive release removal.
pvc=$(kubectl get pvc -n "$namespace" -o jsonpath='{.items[0].metadata.name}')
helm uninstall "$release" -n "$namespace" --wait --timeout 3m
kubectl get pvc "$pvc" -n "$namespace" > "$evidence/retained-pvc.txt"
echo "Kind smoke passed: install, Service, auth roles, KV persistence, Pod recreation, upgrade and PVC retention."
