"""Operator-only live pilot checks; never sets the runner's verification flags.

Creates two expiring namespaces using the real runner manifests, executes probes
through actual candidate credentials, then deletes only its own namespaces.
Run with an administrative kubeconfig on the dedicated control node.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sys
import time
import uuid

sys.path.insert(0, os.environ.get("LAB_RUNNER_SOURCE", str(Path(__file__).resolve().parents[2] / "lab-runner")))
from runner import Cluster, Config  # noqa: E402
from manifests import MANAGED, OWNER, admission, lab_resources, namespace_manifest, pod_spec  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-admission", action="store_true", help="Install the runner's exact current policies before checking (operator-only).")
    parser.add_argument("--image", default=os.environ.get("LAB_WORKSPACE_IMAGE"))
    parser.add_argument("--cluster-uid", default=os.environ.get("LAB_CLUSTER_UID"))
    parser.add_argument("--kubeconfig", default=os.environ.get("KUBECONFIG"))
    parser.add_argument("--control-ip", default="10.88.0.10")
    parser.add_argument("--worker-ip", default="10.88.0.20")
    parser.add_argument("--api-cidrs", default=os.environ.get("LAB_API_CIDRS", "10.43.0.1/32,10.88.0.10/32"))
    args = parser.parse_args()
    if not args.image or not re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}", args.image):
        parser.error("A digest-pinned --image/LAB_WORKSPACE_IMAGE is required")
    if not args.cluster_uid or not args.kubeconfig:
        parser.error("--cluster-uid/LAB_CLUSTER_UID and --kubeconfig/KUBECONFIG are required")
    ipaddress.ip_address(args.control_ip)
    ipaddress.ip_address(args.worker_ip)
    cidrs = tuple(args.api_cidrs.split(","))
    for cidr in cidrs:
        net = ipaddress.ip_network(cidr, strict=True)
        if net.prefixlen != net.max_prefixlen or net.is_link_local or net.is_loopback:
            parser.error("API CIDRs must be exact non-local endpoint addresses")
    # This Config is a test fixture, deliberately NOT Config.from_env(): the
    # production safety flags must remain false until this and host checks pass.
    config = Config(api_key="operator-fixture-not-a-server-key-000", owner="isolation-check",
                    cluster_uid=args.cluster_uid, runtime_class="assessment-sandbox", runtime_handler="runsc",
                    workspace_image=args.image, api_cidrs=cidrs, kubeconfig=args.kubeconfig, max_labs=2)
    cluster = Cluster(config)
    checks = []
    namespaces = []
    run_id = uuid.uuid4().hex[:12]

    def record(name, passed, detail=""):
        item = {"check": name, "passed": bool(passed)}
        if detail:
            item["detail"] = detail[:1200]
        checks.append(item)
        print(json.dumps(item), flush=True)
        return passed

    def candidate(namespace, argv, stdin=None, timeout=20):
        return cluster.call(["-n", namespace, "exec", "-i", "workspace", "-c", "workspace", "--", *argv],
                            stdin=stdin, timeout=timeout, check=False)

    def must(result, context):
        if result.exit_code or result.timed_out:
            raise RuntimeError(context + ": " + result.stderr[:1000])
        return result

    def denied(name, namespace, argv, stdin=None, reason=None):
        result = candidate(namespace, argv, stdin)
        text = result.stdout + result.stderr
        record(name, result.exit_code != 0 and not result.timed_out and
               ("forbidden" in text.lower() or "denied" in text.lower()) and
               (reason is None or reason.lower() in text.lower()), text)

    def dry_run(name, namespace, obj, reason=None):
        denied(name, namespace, ["kubectl", "create", "--dry-run=server", "-f", "-"], json.dumps(obj), reason)

    def curl(namespace, url):
        return candidate(namespace, ["curl", "--noproxy", "*", "--connect-timeout", "2", "--max-time", "4", "--insecure",
                                     "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}", url], timeout=10)

    def blocked(name, namespace, url):
        result = curl(namespace, url)
        record(name, result.exit_code in (7, 28) and result.stdout.strip() == "000" and not result.timed_out,
               "curl exit=" + str(result.exit_code) + " http=" + result.stdout.strip())

    try:
        fingerprint = cluster.get("namespace", "kube-system")
        if not fingerprint or fingerprint["metadata"]["uid"] != args.cluster_uid:
            raise RuntimeError("Cluster fingerprint mismatch; refusing any mutation")
        if args.install_admission:
            for item in admission(config):
                cluster.apply_resource(item)
        for attempt in range(30):
            try:
                cluster.preflight()
                break
            except RuntimeError:
                if attempt == 29:
                    raise
                time.sleep(1)
        record("runner_preflight_and_policy_typecheck", True)
        protected_label = cluster.call(["--as=system:node:lab-sandbox", "--as-group=system:nodes", "--as-group=system:authenticated",
            "patch", "node", "lab-sandbox", "--dry-run=server", "--type=merge", "-p",
            '{"metadata":{"labels":{"uniqassess.com.node-restriction.kubernetes.io/management":"true"}}}'], check=False)
        record("kubelet_cannot_set_protected_label", protected_label.exit_code != 0 and "forbidden" in protected_label.stderr.lower(), protected_label.stderr)
        node_config = json.loads(cluster.call(["get", "--raw", "/api/v1/nodes/lab-sandbox/proxy/configz"]).stdout)["kubeletconfig"]
        record("worker_process_and_node_reservations", node_config.get("podPidsLimit") == 256 and
               bool(node_config.get("systemReserved", {}).get("memory")) and bool(node_config.get("kubeReserved", {}).get("memory")) and
               node_config.get("readOnlyPort", 0) == 0,
               "podPidsLimit=" + str(node_config.get("podPidsLimit")) + "; node memory reservations present=" + str(bool(node_config.get("systemReserved")) and bool(node_config.get("kubeReserved"))))
        for suffix in ("a", "b"):
            name = f"lab-verify-{run_id}-{suffix}"
            expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat().replace("+00:00", "Z")
            lab_id = "verify-" + run_id + "-" + suffix
            cluster.apply_resource(namespace_manifest(name, lab_id, expires, config))
            namespace = cluster.get("namespace", name)
            namespaces.append({"name": name, "uid": namespace["metadata"]["uid"], "id": lab_id})
            for item in lab_resources(name, config):
                cluster.apply_resource(item)
            cluster.wait_ready(name, lambda: False)
            workspace = json.loads(cluster.call(["-n", name, "get", "pod", "workspace", "-o", "json"]).stdout)
            record(f"workspace_{suffix}_sandbox_placement", workspace["spec"].get("nodeName") == "lab-sandbox"
                   and workspace["spec"].get("runtimeClassName") == "assessment-sandbox")
        a, b = [item["name"] for item in namespaces]
        result = candidate(a, ["kubectl", "get", "pods", "-o", "name"])
        record("candidate_own_namespace_api", result.exit_code == 0 and "pod/workspace" in result.stdout, result.stderr)
        anonymous = curl(a, f"https://{args.control_ip}:6443/version")
        record("anonymous_api_access_denied", anonymous.exit_code == 0 and anonymous.stdout.strip() == "401", anonymous.stderr)
        for name, argv in [
            ("cross_namespace_read_denied", ["get", "pods", "-n", b]),
            ("kube_system_read_denied", ["get", "pods", "-n", "kube-system"]),
            ("nodes_read_denied", ["get", "nodes"]),
            ("secrets_read_denied", ["get", "secrets"]),
            ("network_policy_mutation_denied", ["delete", "networkpolicy", "isolation", "--dry-run=server"]),
            ("quota_mutation_denied", ["delete", "resourcequota", "budget", "--dry-run=server"]),
            ("identity_mutation_denied", ["delete", "serviceaccount", "candidate", "--dry-run=server"]),
            ("role_mutation_denied", ["delete", "role", "candidate", "--dry-run=server"]),
            ("workspace_delete_denied", ["delete", "pod", "workspace", "--dry-run=server"]),
        ]:
            denied(name, a, ["kubectl", *argv])
        base = {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": "admission-probe", "namespace": a}, "spec": pod_spec(config)}
        mutations = [
            ("privileged_pod_denied", lambda p: p["spec"]["containers"][0]["securityContext"].update(privileged=True, allowPrivilegeEscalation=True), "privileged"),
            ("host_network_denied", lambda p: p["spec"].update(hostNetwork=True), "hostNetwork"),
            ("host_path_denied", lambda p: p["spec"]["volumes"].append({"name": "host", "hostPath": {"path": "/"}}), None),
            ("runtime_bypass_denied", lambda p: p["spec"].pop("runtimeClassName"), "sandbox RuntimeClass"),
            ("unapproved_image_denied", lambda p: p["spec"]["containers"][0].update(image="docker.io/library/alpine:latest"), "digest-pinned"),
            ("placement_bypass_denied", lambda p: p["spec"].update(nodeName="lab-control"), "placement"),
            ("writable_root_denied", lambda p: p["spec"]["containers"][0]["securityContext"].update(readOnlyRootFilesystem=False), "read-only"),
            ("finalizer_denied", lambda p: p["metadata"].update(finalizers=["example.test/block-cleanup"]), "finalizers"),
        ]
        for name, change, reason in mutations:
            mutated = copy.deepcopy(base)
            change(mutated)
            dry_run(name, a, mutated, reason)
        dry_run("external_service_denied", a, {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "external-probe", "namespace": a},
                "spec": {"type": "ExternalName", "externalName": "example.com"}}, "external")
        dns = candidate(a, ["python", "-c", "import socket; print(socket.gethostbyname('kubernetes.default.svc.cluster.local'))"])
        record("cluster_dns_resolution", dns.exit_code == 0 and dns.stdout.strip() == "10.43.0.1", dns.stderr)
        external_dns = candidate(a, ["python", "-c", "import socket; socket.gethostbyname('example.com')"])
        record("external_dns_forwarding_disabled", external_dns.exit_code != 0 and not external_dns.timed_out)
        # Repair both actual exercises. Own-namespace HTTP succeeds before using
        # the second application's known-live PodIP as a cross-namespace probe.
        for ns in (a, b):
            must(candidate(ns, ["kubectl", "patch", "deployment", "checkout", "--type=json", "-p",
                 '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/port","value":8080}]']), "Repair readiness")
            must(candidate(ns, ["kubectl", "patch", "service", "checkout", "--type=merge", "-p", '{"spec":{"selector":{"app":"checkout"}}}']), "Repair selector")
            must(cluster.call(["-n", ns, "rollout", "status", "deployment/checkout", "--timeout=90s"], timeout=95), "Wait for repair")
            repaired = candidate(ns, ["curl", "--fail", "--silent", "--show-error", "--max-time", "4", "http://checkout/checkout"])
            record("repaired_http_" + ns[-1], repaired.exit_code == 0 and '"ok"' in repaired.stdout, repaired.stderr)
        # Full PodList JSON can exceed the runner's intentional 32KiB output cap;
        # select only the data needed by this probe before it crosses that cap.
        pod_rows = cluster.call(["-n", b, "get", "pods", "-l", "app=checkout", "--field-selector=status.phase=Running",
                                 "-o", 'jsonpath={range .items[*]}{.status.podIP}{" "}{.status.containerStatuses[0].ready}{"\\n"}{end}']).stdout
        target_ip = next(row.split()[0] for row in pod_rows.splitlines() if row.endswith(" true"))
        own_direct = curl(b, f"http://{target_ip}:8080/checkout")
        if not record("cross_namespace_target_proven_live", own_direct.exit_code == 0 and own_direct.stdout == "200"):
            raise RuntimeError("Cross-namespace network target was not healthy")
        blocked("cross_namespace_pod_http_denied", a, f"http://{target_ip}:8080/checkout")
        # Check live host services from the operator host first, avoiding a false
        # pass caused by a port which has no service behind it.
        for label, host, port in [("worker_ssh", args.worker_ip, 22), ("worker_kubelet", args.worker_ip, 10250), ("control_kubelet", args.control_ip, 10250)]:
            with socket.create_connection((host, port), timeout=5):
                pass
            record(label + "_target_proven_live", True)
            blocked(label + "_denied", a, f"https://{host}:{port}/")
        for label, url in [
            ("metadata_ipv4_denied", "http://169.254.169.254/latest/meta-data/"),
            ("metadata_ipv6_denied", "http://[fd00:ec2::254]/latest/meta-data/"),
            ("vpc_dns_http_denied", "http://10.88.0.2:80/"),
            ("public_https_denied", "https://1.1.1.1/"),
        ]:
            blocked(label, a, url)
    except Exception as exc:
        record("verification_completed", False, f"{type(exc).__name__}: {exc}")
    finally:
        for owned in namespaces:
            try:
                current = cluster.get("namespace", owned["name"])
                if current:
                    meta = current["metadata"]
                    if meta["uid"] != owned["uid"] or meta.get("labels", {}).get(MANAGED) != "true" or meta.get("labels", {}).get(OWNER) != config.owner or meta.get("annotations", {}).get("labs.uniqassess.com/id") != owned["id"]:
                        raise RuntimeError("Ownership mismatch; refusing namespace cleanup")
                    cluster.call(["delete", "namespace", owned["name"], "--wait=true", "--timeout=90s"], timeout=95)
                record("cleanup_" + owned["name"][-1], cluster.get("namespace", owned["name"]) is None)
            except Exception as exc:
                record("cleanup_" + owned["name"][-1], False, str(exc))
    passed = bool(checks) and all(check["passed"] for check in checks)
    print(json.dumps({"runId": run_id, "passed": passed, "checks": checks,
                      "verificationFlagsChanged": False, "remainingOperatorEvidence": ["actual worker runsc/systrap process", "worker IMDS disabled in EC2", "worker has no IAM instance profile", "nft rules on both hosts", "node PID reservations", "no production routes or credentials"]}), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
