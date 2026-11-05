#!/usr/bin/env python3
"""Render supported configurations and check contracts that Kubernetes cannot enforce."""
import os
from pathlib import Path
import subprocess
import tempfile

import yaml

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / "charts/open-compute"
HELM = os.environ.get("HELM", "helm")


def render(values=None, valid=True):
    values = {"auth": {"existingSecret": "fixture-auth"}, **(values or {})}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "values.yaml"
        path.write_text(yaml.safe_dump(values or {}))
        result = subprocess.run(
            [HELM, "template", "test", str(CHART), "--namespace", "test", "-f", str(path)],
            text=True, capture_output=True,
        )
    if not valid:
        assert result.returncode != 0, f"Invalid values were accepted: {values}"
        return []
    assert result.returncode == 0, result.stderr
    return list(yaml.safe_load_all(result.stdout))


def workload(docs):
    return next(d for d in docs if d["kind"] == "StatefulSet")


default = render()
statefulset = workload(default)
assert statefulset["spec"]["replicas"] == 1
assert len(statefulset["spec"]["volumeClaimTemplates"]) == 1
claim = statefulset["spec"]["volumeClaimTemplates"][0]
assert "storageClassName" not in claim["spec"]
spec = statefulset["spec"]["template"]["spec"]
assert spec["automountServiceAccountToken"] is False
assert spec["containers"][0]["securityContext"]["runAsNonRoot"] is True
assert spec["initContainers"][0]["securityContext"]["runAsUser"] == 0
assert spec["containers"][0]["livenessProbe"]["httpGet"]["path"] == "/health/live"
assert "instances --json" in spec["containers"][0]["readinessProbe"]["exec"]["command"][-1]
assert not any(d["kind"] == "Secret" for d in default)
assert all(m["subPath"] == "open-compute" for c in spec["containers"] + spec["initContainers"]
           for m in c["volumeMounts"] if m["name"] == "data")
assert all(c["image"].endswith(":0.4.0") for c in spec["containers"] + spec["initContainers"])

for filename in ["default-values.yaml", "ingress-values.yaml", "s3-values.yaml"]:
    values = yaml.safe_load((CHART / "ci" / filename).read_text())
    docs = render(values)
    if filename == "ingress-values.yaml":
        ingress = next(d for d in docs if d["kind"] == "Ingress")
        assert ingress["spec"]["tls"][0]["secretName"] == "compute-tls"
    if filename == "s3-values.yaml":
        pod = workload(docs)["spec"]["template"]["spec"]
        for c in [pod["initContainers"][0], pod["containers"][0]]:
            env = {e["name"]: e for e in c["env"]}
            assert env["OC_S3_ACCESS_KEY_ID"]["valueFrom"]["secretKeyRef"]["name"] == "open-compute-s3"

for values in [
    {"persistence": {"enabled": False}},
    {"persistence": {"existingClaim": "existing-data"}},
]:
    obj = workload(render(values))
    assert "volumeClaimTemplates" not in obj["spec"]
    data = next(v for v in obj["spec"]["template"]["spec"]["volumes"] if v["name"] == "data")
    if values["persistence"].get("existingClaim"):
        assert data["persistentVolumeClaim"]["claimName"] == "existing-data"
    else:
        assert "emptyDir" in data

obj = workload(render({"persistence": {"storageClass": ""}}))
assert obj["spec"]["volumeClaimTemplates"][0]["spec"]["storageClassName"] == ""

digest = "sha256:" + "a" * 64
pod = workload(render({"image": {"digest": digest}}))["spec"]["template"]["spec"]
assert pod["containers"][0]["image"].endswith("@" + digest)
docs = render({"fullnameOverride": "custom", "service": {"type": "NodePort", "port": 80, "nodePort": 30787}})
service = next(d for d in docs if d["kind"] == "Service" and d["metadata"]["name"] == "custom")
assert service["spec"]["ports"][0]["nodePort"] == 30787

for values in [
    {"replicaCount": 2},
    {"auth": {"existingSecret": ""}},
    {"storage": {"backend": "invalid"}},
    {"storage": {"backend": "s3"}},
    {"persistence": {"subPath": "../escape"}},
    {"persistence": {"accessModes": ["ReadWriteMany"]}},
    {"config": {"publicOrigin": "https://example.com/path"}},
    {"service": {"port": 0}},
]:
    render(values, valid=False)

print("Chart render checks passed (defaults, Ingress, S3, existing PVC, emptyDir, image digest, validation).")
