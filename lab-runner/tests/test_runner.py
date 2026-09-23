import copy
from datetime import timedelta
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from manifests import MANAGED, OWNER, TEMPLATE, admission, lab_resources, namespace_manifest
from runner import ApiError, Broker, Cluster, Config, Handler, OUTPUT_LIMIT, Result, policy_matches, public_lab, run_bounded, timestamp, utcnow
from janitor import sweep

LAB = "c" + "a" * 24
OTHER = "c" + "b" * 24
IMAGE = "registry.test/lab@sha256:" + "a" * 64


class FakeCluster:
    def __init__(self):
        self.deleted = []
        self.created = []
        self.resources = []
        self.commands = []
        self.result = Result("hello\n", "", 0)

    def preflight(self):
        pass

    def create_namespace(self, namespace, lab_id, expires_at):
        self.created.append(namespace)
        return "namespace-uid"

    def apply_resource(self, resource):
        self.resources.append(resource)

    def wait_ready(self, namespace, cancel):
        if cancel():
            raise RuntimeError("cancelled")

    def execute(self, namespace, command, cancel):
        self.commands.append(command)
        return self.result

    def snapshot(self, lab):
        return {"capturedAt": timestamp(), "content": '{"items":[]}', "truncated": False}

    def delete_namespace(self, lab):
        self.deleted.append(lab["namespace"])
        return True


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config("secret" * 8, "test", "cluster-uid", "gvisor", "runsc", IMAGE,
                             ("10.0.0.1/32",), database=str(Path(self.temp.name) / "state.sqlite3"), max_labs=1)
        self.cluster = FakeCluster()
        self.broker = Broker(self.config, self.cluster, start_workers=False)
        self.broker.submit = lambda *_: None
        self.body = {"templateId": TEMPLATE, "expiresAt": timestamp(utcnow() + timedelta(minutes=30))}

    def tearDown(self):
        self.broker.close()
        self.temp.cleanup()

    def ready(self):
        self.broker.create(LAB, self.body)
        self.broker.provision(LAB)

    def assert_error(self, code, action):
        with self.assertRaises(ApiError) as caught:
            action()
        self.assertEqual(caught.exception.status, code)

    def test_provision_idempotency_and_immutable_expiry(self):
        self.assertEqual(self.broker.create(LAB, self.body)["status"], "starting")
        self.assertEqual(self.broker.create(LAB, self.body)["status"], "starting")
        self.broker.provision(LAB)
        self.assertEqual(self.broker.create(LAB, self.body)["status"], "ready")
        self.assertEqual(len(self.cluster.created), 1)
        self.assert_error(409, lambda: self.broker.create(LAB, {**self.body, "expiresAt": timestamp(utcnow() + timedelta(minutes=60))}))

    def test_unknown_delete_is_tombstone_even_when_put_delayed(self):
        stopped = self.broker.stop(LAB)
        self.assertEqual(stopped["status"], "stopped")
        self.assertFalse(stopped["cleanupComplete"])
        self.assertEqual(self.broker.create(LAB, self.body)["status"], "stopped")
        self.broker.cleanup(LAB)
        self.assertTrue(public_lab(self.broker.lab(LAB))["cleanupComplete"])
        self.assertEqual(self.cluster.created, [])

    def test_invalid_identifiers_and_expiry_never_create(self):
        self.assert_error(400, lambda: self.broker.create("../../default", self.body))
        self.assert_error(400, lambda: self.broker.create(LAB, {**self.body, "templateId": "unknown"}))
        for expiry in ["2026-01-01", "garbage", timestamp(utcnow() - timedelta(minutes=1)), timestamp(utcnow() + timedelta(hours=3))]:
            self.assert_error(400, lambda: self.broker.create(LAB, {**self.body, "expiresAt": expiry}))
        self.assertEqual(self.cluster.created, [])

    def test_capacity_includes_pending_deletion(self):
        self.ready()
        self.broker.stop(LAB)
        self.assert_error(429, lambda: self.broker.create(OTHER, self.body))
        self.broker.cleanup(LAB)
        self.assertEqual(self.broker.create(OTHER, self.body)["status"], "starting")

    def test_command_idempotency_one_active_and_multiline(self):
        self.ready()
        command = {"id": str(uuid.uuid4()), "command": "cat > /workspace/note <<'EOF'\nhello\nEOF\ncat /workspace/note"}
        first = self.broker.enqueue(LAB, command)
        self.assertEqual(first["status"], "queued")
        self.assertEqual(first, self.broker.enqueue(LAB, command))
        self.assert_error(409, lambda: self.broker.enqueue(LAB, {**command, "command": "different"}))
        self.assert_error(409, lambda: self.broker.enqueue(LAB, {**command, "id": str(uuid.uuid4())}))
        self.broker.execute(LAB)
        self.assertEqual(self.broker.enqueue(LAB, command)["status"], "completed")
        self.assertEqual(self.cluster.commands, [command["command"]])

    def test_command_validation_and_limit(self):
        self.ready()
        for text in ["", " ", "x" * 8001, "a\x00b"]:
            self.assert_error(400, lambda: self.broker.enqueue(LAB, {"id": str(uuid.uuid4()), "command": text}))
        self.assert_error(400, lambda: self.broker.enqueue(LAB, {"id": "not-a-uuid", "command": "true"}))
        for _ in range(100):
            self.broker.store.write("INSERT INTO commands(id,lab_id,command,status,created_at) VALUES(?,?,?,'completed',?)", (str(uuid.uuid4()), LAB, "true", timestamp()))
        self.assert_error(429, lambda: self.broker.enqueue(LAB, {"id": str(uuid.uuid4()), "command": "true"}))

    def test_expiry_blocks_new_commands_and_preserves_evidence(self):
        self.ready()
        command = {"id": str(uuid.uuid4()), "command": "echo hello"}
        self.broker.enqueue(LAB, command)
        self.broker.execute(LAB)
        self.broker.store.write("UPDATE labs SET expires_at=? WHERE id=?", (timestamp(utcnow() - timedelta(seconds=1)), LAB))
        self.assertEqual(self.broker.lab(LAB)["status"], "expired")
        self.assert_error(409, lambda: self.broker.enqueue(LAB, {**command, "id": str(uuid.uuid4())}))
        self.broker.cleanup(LAB)
        self.assertEqual(self.broker.command(LAB, command["id"])["stdout"], "hello\n")
        result = public_lab(self.broker.lab(LAB))
        self.assertTrue(result["cleanupComplete"])
        self.assertEqual(result["snapshot"]["content"], '{"items":[]}')

    def test_stop_during_provision_does_not_publish_ready(self):
        self.broker.create(LAB, self.body)
        self.cluster.apply_resource = lambda _resource: self.broker.stop(LAB)
        self.broker.provision(LAB)
        self.assertEqual(self.broker.lab(LAB)["status"], "stopped")
        self.broker.cleanup(LAB)
        self.assertEqual(self.cluster.deleted, ["ua-lab-" + LAB])

    def test_command_timeout_retires_lab(self):
        self.ready()
        command = {"id": str(uuid.uuid4()), "command": "sleep 60"}
        self.cluster.result = Result("partial", "", 124)
        self.broker.enqueue(LAB, command)
        self.broker.execute(LAB)
        self.assertEqual(self.broker.command(LAB, command["id"])["status"], "failed")
        self.assertEqual(self.broker.lab(LAB)["status"], "failed")
        self.assertTrue(self.broker.lab(LAB)["cleanup_pending"])

    def test_recovery_never_replays_interrupted_commands(self):
        self.ready()
        command = {"id": str(uuid.uuid4()), "command": "kubectl patch service checkout --type=merge -p '{}'"}
        self.broker.enqueue(LAB, command)
        self.broker.close()
        self.broker = Broker(self.config, self.cluster, start_workers=False)
        self.broker.recover()
        self.assertEqual(self.broker.lab(LAB)["status"], "failed")
        self.assertEqual(self.broker.command(LAB, command["id"])["status"], "failed")
        self.assertEqual(self.cluster.commands, [])

    def test_broker_recovery_retains_idle_ready_lab(self):
        self.ready()
        self.broker.recover()
        self.assertEqual(self.broker.lab(LAB)["status"], "ready")

    def test_cleanup_failure_remains_pending(self):
        self.ready()
        self.broker.stop(LAB)
        self.cluster.delete_namespace = lambda _lab: False
        self.broker.cleanup(LAB)
        self.assertFalse(public_lab(self.broker.lab(LAB))["cleanupComplete"])

    def test_resources_scope_credentials_and_lock_network(self):
        resources = lab_resources("ua-lab-" + LAB, self.config)
        role = next(r for r in resources if r["kind"] == "Role")
        resources_granted = {v for rule in role["rules"] for v in rule["resources"]}
        self.assertFalse({"secrets", "serviceaccounts", "roles", "rolebindings", "networkpolicies", "namespaces", "nodes"} & resources_granted)
        pod = next(r for r in resources if r["kind"] == "Pod")
        self.assertEqual(pod["spec"]["runtimeClassName"], "gvisor")
        self.assertTrue(pod["spec"]["containers"][0]["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(pod["spec"]["serviceAccountName"], "candidate")
        policy = next(r for r in resources if r["kind"] == "NetworkPolicy")
        self.assertEqual(policy["spec"]["policyTypes"], ["Ingress", "Egress"])
        self.assertEqual(policy["spec"]["egress"][2]["to"], [{"ipBlock": {"cidr": "10.0.0.1/32"}}])

    def test_preflight_checks_runtime_cluster_and_policy_drift(self):
        cluster = Cluster(self.config)
        policies = {(item["kind"], item["metadata"]["name"]): {**item, "status": {"typeChecking": {}}} for item in admission(self.config)}
        namespace = {"metadata": {"uid": self.config.cluster_uid}}
        runtime = {"handler": "runsc", "scheduling": {"nodeSelector": {"uniqassess.com.node-restriction.kubernetes.io/sandbox": "true"}}}
        def lookup(kind, name):
            if kind == "namespace":
                return namespace
            if kind == "runtimeclass":
                return runtime
            return policies[(kind, name)]
        cluster.get = lookup
        cluster.preflight()
        runtime["handler"] = "runc"
        with self.assertRaisesRegex(RuntimeError, "RuntimeClass"):
            cluster.preflight()
        runtime["handler"] = "runsc"
        policies[("ValidatingAdmissionPolicy", "uniqassess-lab-pods-v1")]["spec"]["failurePolicy"] = "Ignore"
        with self.assertRaisesRegex(RuntimeError, "admission"):
            cluster.preflight()
        namespace["metadata"]["uid"] = "production-uid"
        with self.assertRaisesRegex(RuntimeError, "fingerprint"):
            cluster.preflight()

    def test_independent_janitor_expires_owned_namespaces_without_broker(self):
        lab_namespace = namespace_manifest("ua-lab-" + LAB, LAB, timestamp(utcnow() - timedelta(seconds=1)), self.config)
        lab_namespace["metadata"]["uid"] = "expired-uid"
        future_namespace = namespace_manifest("ua-lab-" + OTHER, OTHER, self.body["expiresAt"], self.config)
        future_namespace["metadata"]["uid"] = "future-uid"
        namespaces = {"kube-system": {"metadata": {"uid": self.config.cluster_uid}},
                      "ua-lab-" + LAB: lab_namespace, "ua-lab-" + OTHER: future_namespace}
        cluster = Cluster(self.config)
        cluster.get = lambda _kind, name: namespaces.get(name)
        cluster.call = lambda *_args, **_kwargs: Result("namespace/ua-lab-" + LAB + "\nnamespace/ua-lab-" + OTHER + "\n", "", 0)
        deleted = []
        cluster.delete_namespace = lambda row: deleted.append(row)
        self.assertEqual(sweep(cluster, self.config), 1)
        self.assertEqual(deleted[0]["id"], LAB)
        self.assertEqual(deleted[0]["namespace_uid"], "expired-uid")

    def test_delete_checks_ownership_and_uid_precondition(self):
        self.ready()
        lab = self.broker.lab(LAB)
        cluster = Cluster(self.config)
        namespace = namespace_manifest(lab["namespace"], LAB, lab["expires_at"], self.config)
        namespace["metadata"]["uid"] = "namespace-uid"
        cluster.get = lambda _kind, name: {"metadata": {"uid": self.config.cluster_uid}} if name == "kube-system" else namespace
        calls = []
        cluster.call = lambda args, **kwargs: calls.append((args, kwargs))
        self.assertFalse(cluster.delete_namespace(lab))
        self.assertEqual(json.loads(calls[0][1]["stdin"])["preconditions"], {"uid": "namespace-uid"})
        namespace["metadata"]["labels"][OWNER] = "someone-else"
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            cluster.delete_namespace(lab)
        self.assertEqual(len(calls), 1)

    def test_shell_text_only_passed_to_remote_exec(self):
        cluster = Cluster(self.config)
        script = "echo hello; $(touch /tmp/no-host-execution)\ncat <<'EOF'\nanything\nEOF"
        with patch("runner.run_bounded", return_value=Result("", "", 0)) as run:
            cluster.execute("ua-lab-" + LAB, script, lambda: False)
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "kubectl")
        self.assertEqual(argv[-3:], ["sh", "-c", script])
        self.assertIn("--", argv)
        self.assertEqual(run.call_args.kwargs["timeout"], 20)

    def test_http_auth_routes_and_tombstone(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.broker = self.broker
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}/v1/labs/{LAB}"
        try:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(base)
            self.assertEqual(caught.exception.code, 401)
            request = urllib.request.Request(base, method="DELETE", headers={"Authorization": "Bearer " + self.config.api_key})
            with urllib.request.urlopen(request) as response:
                result = json.load(response)
            self.assertEqual(result["status"], "stopped")
            request = urllib.request.Request(base, data=json.dumps(self.body).encode(), method="PUT", headers={"Authorization": "Bearer " + self.config.api_key})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)["status"], "stopped")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class SafetyTests(unittest.TestCase):
    def test_policy_comparison_rejects_added_bypass_but_accepts_api_defaults(self):
        expected = {"failurePolicy": "Fail", "matchConstraints": {"resourceRules": [{"apiGroups": [""]}]}}
        defaulted = copy.deepcopy(expected)
        defaulted["matchConstraints"].update({"matchPolicy": "Equivalent", "objectSelector": {}})
        defaulted["matchConstraints"]["resourceRules"][0]["scope"] = "*"
        self.assertTrue(policy_matches(defaulted, expected))
        defaulted["matchConditions"] = [{"name": "bypass", "expression": "false"}]
        self.assertFalse(policy_matches(defaulted, expected))

    def test_configuration_fails_closed(self):
        env = {"LAB_RUNNER_API_KEY": "a" * 32, "LAB_RUNNER_OWNER": "test", "LAB_CLUSTER_UID": "uid", "LAB_RUNTIME_CLASS": "gvisor",
               "LAB_RUNTIME_HANDLER": "runsc", "LAB_WORKSPACE_IMAGE": IMAGE, "LAB_API_CIDRS": "10.0.0.1/32", "KUBECONFIG": "/run/config",
               "LAB_DEDICATED_CLUSTER": "true", "LAB_NETWORK_POLICY_VERIFIED": "true", "LAB_NODE_ISOLATION_VERIFIED": "true"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(Config.from_env().api_cidrs, ("10.0.0.1/32",))
        for key, value in [("LAB_DEDICATED_CLUSTER", "false"), ("LAB_API_CIDRS", "0.0.0.0/0"), ("LAB_API_CIDRS", "169.254.169.254/32"), ("LAB_RUNTIME_HANDLER", "runc"), ("LAB_WORKSPACE_IMAGE", "image:latest"), ("LAB_RUNNER_API_KEY", "short")]:
            with patch.dict(os.environ, {**env, key: value}, clear=True):
                with self.assertRaises((RuntimeError, ValueError)):
                    Config.from_env()

    def test_subprocess_output_is_drained_but_bounded(self):
        result = run_bounded([sys.executable, "-c", "import sys; sys.stdout.write('x'*100000); sys.stderr.write('y'*100000)"], timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(len(result.stdout), OUTPUT_LIMIT)
        self.assertEqual(len(result.stderr), OUTPUT_LIMIT)
        self.assertTrue(result.truncated)

    def test_subprocess_timeout_and_cancellation(self):
        result = run_bounded([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.1)
        self.assertTrue(result.timed_out)
        result = run_bounded([sys.executable, "-c", "import time; time.sleep(10)"], timeout=5, cancel=lambda: True)
        self.assertTrue(result.cancelled)


if __name__ == "__main__":
    unittest.main()
