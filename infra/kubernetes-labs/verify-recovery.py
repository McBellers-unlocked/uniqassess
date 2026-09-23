"""Operator-only restart and independent expiry checks on the dedicated pilot.

Run on the control host after broker readiness, with no candidate sessions active.
The runner key is read from Secrets Manager into memory; SQLite is read-only.
Only this run's synthetic namespaces are deleted. The broker is restored in
finally even if a check fails. No application feature flags or direct SQL writes.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.parse
import uuid

import boto3

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lab-runner"))
from live_lifecycle import AcceptanceFailure, LiveChecks, require, timestamp  # noqa: E402

CONTROL = "uniqassess-control"
MANAGED = "labs.uniqassess.com/managed"
OWNER = "labs.uniqassess.com/owner"
LAB_ID = "labs.uniqassess.com/id"
RUN_ID = "labs.uniqassess.com/recovery-check"
DATABASE = Path("/var/lib/uniqassess-labs/evidence/labs.sqlite3")


class RecoveryChecks(LiveChecks):
    def __init__(self, args):
        self.kubeconfig = args.kubeconfig
        self.labs, self.results, self.namespaces = {}, [], {}
        self.run_id = uuid.uuid4().hex[:12]
        self.original_replicas = None
        self.disrupted = False
        deployment = self.kube_json("get", "deployment", "lab-broker", "-n", CONTROL, "-o", "json")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        environment = {item["name"]: item.get("value") for item in container["env"]}
        fingerprint = self.kube_json("get", "namespace", "kube-system", "-o", "json")
        require(environment.get("LAB_CLUSTER_UID") == fingerprint["metadata"]["uid"],
                "Broker and operator cluster fingerprints differ.")
        require(environment.get("LAB_RUNNER_OWNER") == "pilot" and
                environment.get("LAB_DB_PATH") == "/data/labs.sqlite3" and
                environment.get("LAB_DEDICATED_CLUSTER") == "true",
                "The deployment is not the expected dedicated pilot broker.")
        require(deployment["spec"].get("replicas") == 1 and DATABASE.is_file(),
                "The pilot must have one broker replica and its durable SQLite store.")
        self.original_replicas = 1
        self.assert_exclusive()
        secret = json.loads(boto3.client("secretsmanager", region_name="eu-west-1").get_secret_value(
            SecretId="uniqassess/labs/pilot/runner")["SecretString"])
        self.base, self.key = secret["url"].rstrip("/"), secret["key"]
        parsed = urllib.parse.urlsplit(self.base)
        require(parsed.scheme == "https" and parsed.hostname == "lab-runner.uniqassess.org" and
                not parsed.username and not parsed.password and not parsed.query and
                not parsed.fragment and not parsed.path and len(self.key) >= 32,
                "Runner configuration is not the expected authenticated public TLS origin.")
        self.wait_broker()

    def kube(self, *args, data=None, timeout=35):
        try:
            result = subprocess.run(["kubectl", "--kubeconfig", self.kubeconfig,
                                     "--request-timeout=25s", *args],
                                    input=data, capture_output=True, text=True, timeout=timeout, check=False)
        except Exception:
            raise AcceptanceFailure("A bounded operator Kubernetes request failed.") from None
        require(result.returncode == 0, "An operator Kubernetes request was rejected.")
        return result.stdout

    def kube_json(self, *args):
        result = self.kube(*args)
        return json.loads(result) if result.strip() else None

    def sql(self, query, parameters=()):
        # mode=ro forbids SQL writes; parameterized reads are limited to lab state.
        with closing(sqlite3.connect(DATABASE.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(query, parameters).fetchall()]

    def own_ids(self):
        return {path.rsplit("/", 1)[1] for path in self.labs}

    def assert_exclusive(self):
        known = self.own_ids()
        namespaces = self.kube_json("get", "namespaces", "-l", MANAGED + "=true", "-o", "json")["items"]
        require(all(item["metadata"].get("annotations", {}).get(LAB_ID) in known for item in namespaces),
                "An unrelated assessment namespace is active; refusing broker disruption.")
        rows = self.sql("SELECT id FROM labs WHERE status IN ('starting','ready') OR cleanup_pending=1")
        require(all(row["id"] in known for row in rows),
                "An unrelated broker lab is active; refusing broker disruption.")

    def wait_broker(self):
        self.kube("rollout", "status", "deployment/lab-broker", "-n", CONTROL,
                  "--timeout=120s", timeout=130)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                self.request("GET", "/v1/labs/r" + self.run_id + "00000000", expected=(404,))
                return
            except AcceptanceFailure:
                time.sleep(1)
        raise AcceptanceFailure("Broker did not recover through its public TLS endpoint.")

    def namespace(self, lab_id):
        return self.kube_json("get", "namespace", "ua-lab-" + lab_id, "--ignore-not-found", "-o", "json")

    def start_with_lease(self, seconds=300):
        lab_id = "recovery" + uuid.uuid4().hex[:24]
        path = "/v1/labs/" + lab_id
        body = {"templateId": "kubernetes-troubleshooting-v1",
                "expiresAt": timestamp(datetime.now(timezone.utc) + timedelta(seconds=seconds))}
        self.labs[path] = {"body": body, "cleaned": False}
        self.request("PUT", path, body)
        lab = self.poll(path, lambda row: row.get("status") != "starting", min(120, seconds), "Synthetic provisioning")
        require(lab.get("status") == "ready", "A synthetic recovery lab did not become ready.")
        namespace = self.namespace(lab_id)
        require(namespace is not None and namespace["metadata"].get("labels", {}).get(OWNER) == "pilot" and
                namespace["metadata"].get("annotations", {}).get(LAB_ID) == lab_id,
                "Synthetic namespace ownership could not be verified.")
        self.namespaces[lab_id] = namespace["metadata"]["uid"]
        self.kube("annotate", "namespace", "ua-lab-" + lab_id, RUN_ID + "=" + self.run_id)
        return path, body, lab

    def restart(self, interrupt=False):
        self.assert_exclusive()
        old_pods = self.kube_json("get", "pods", "-n", CONTROL, "-l", "app=lab-broker", "-o", "json")["items"]
        old = {pod["metadata"]["uid"] for pod in old_pods}
        require(len(old_pods) == 1, "A recovery restart requires exactly one broker pod.")
        self.disrupted = True
        if interrupt:
            # A normal rollout grants 30 seconds for a 19-second bounded command
            # to finish. Use a one-second pod termination deadline to exercise
            # genuinely interrupted work; do not use force deletion, which can
            # leave the old process running alongside its replacement.
            self.kube("delete", "pod", old_pods[0]["metadata"]["name"], "-n", CONTROL,
                      "--grace-period=1", "--wait=true", "--timeout=60s", timeout=70)
        else:
            self.kube("rollout", "restart", "deployment/lab-broker", "-n", CONTROL)
        self.wait_broker()
        new = {pod["metadata"]["uid"] for pod in self.kube_json(
            "get", "pods", "-n", CONTROL, "-l", "app=lab-broker", "-o", "json")["items"]}
        require(bool(new) and not old.intersection(new), "The broker pod was not replaced by the restart.")

    def idle_restart(self):
        path, _, _ = self.start_with_lease()
        command, _ = self.enqueue(path, "printf 'retained\\n' > /workspace/recovery-retained; cat /workspace/recovery-retained")
        before = self.completed(path, command)
        require(before.get("status") == "completed" and before.get("stdout") == "retained\n",
                "The pre-restart marker command did not complete.")
        lab_id = path.rsplit("/", 1)[1]
        sql_before = self.sql("SELECT * FROM commands WHERE lab_id=? AND id=?", (lab_id, command["id"]))
        require(len(sql_before) == 1, "Completed command was not persisted in SQLite.")
        self.restart()
        require(self.request("GET", path).get("status") == "ready", "An idle ready lab did not survive restart.")
        require(self.request("GET", path + "/commands/" + command["id"]) == before and
                self.sql("SELECT * FROM commands WHERE lab_id=? AND id=?", (lab_id, command["id"])) == sql_before,
                "Restart altered the retained command or SQLite record.")
        require(self.run(path, "cat /workspace/recovery-retained").get("stdout") == "retained\n",
                "The existing workspace file did not survive broker restart.")
        self.stop(path, snapshot=True)
        return {"workspaceRetained": True, "commandAndSqliteRetained": True, "cleanupComplete": True}

    def active_restart(self):
        path, body, _ = self.start_with_lease()
        lab_id = path.rsplit("/", 1)[1]
        command, _ = self.enqueue(path, "printf 'once\\n' >> /workspace/recovery-once; sleep 15; printf 'must-not-complete\\n'")
        running = self.poll(path + "/commands/" + command["id"], lambda row: row.get("status") != "queued", 5, "Active command")
        require(running.get("status") == "running", "Recovery probe did not reach an active command.")
        before = self.sql("SELECT started_at FROM commands WHERE lab_id=? AND id=?", (lab_id, command["id"]))
        self.restart(interrupt=True)
        final = self.poll(path, lambda row: row.get("cleanupComplete") is True, 90, "Interrupted lab cleanup")
        result = self.request("GET", path + "/commands/" + command["id"])
        require(final.get("status") == "failed" and result.get("status") == "failed" and
                "must-not-complete" not in result.get("stdout", ""),
                "An interrupted lab or command was not safely failed.")
        retry = self.request("POST", path + "/commands", command, expected=(202,))
        require(retry == result and self.request("PUT", path, body).get("status") == "failed",
                "A retry replayed an interrupted command or reopened the lab.")
        after = self.sql("SELECT started_at FROM commands WHERE lab_id=? AND id=?", (lab_id, command["id"]))
        require(before == after and not self.sql("SELECT id FROM commands WHERE lab_id=? AND status IN ('queued','running')", (lab_id,)) and
                self.namespace(lab_id) is None, "Interrupted work remained active or its namespace remained.")
        self.labs[path]["cleaned"] = True
        return {"commandFailedWithoutReplay": True, "namespaceRemoved": True}

    def independent_janitor(self):
        janitor = self.kube_json("get", "cronjob", "uniqassess-lab-janitor", "-n", CONTROL, "-o", "json")
        require(janitor["spec"].get("schedule") == "* * * * *" and not janitor["spec"].get("suspend"),
                "The independent minute janitor is not scheduled.")
        path, body, _ = self.start_with_lease(90)
        lab_id = path.rsplit("/", 1)[1]
        expiry = datetime.fromisoformat(body["expiresAt"].replace("Z", "+00:00"))
        self.assert_exclusive()
        started = time.monotonic()
        self.disrupted = True
        self.kube("scale", "deployment/lab-broker", "-n", CONTROL, "--replicas=0")
        # Scale-down alone grants the normal 30-second termination grace. End
        # the sole broker pod promptly so the short lease tests cleanup
        # while its broker is actually offline, before expiry is observed.
        self.kube("delete", "pods", "-n", CONTROL, "-l", "app=lab-broker", "--grace-period=1",
                  "--ignore-not-found", "--wait=true", "--timeout=60s", timeout=70)
        pods = self.kube_json("get", "pods", "-n", CONTROL, "-l", "app=lab-broker", "-o", "json")["items"]
        while pods and time.monotonic() - started < 60:
            time.sleep(1)
            pods = self.kube_json("get", "pods", "-n", CONTROL, "-l", "app=lab-broker", "-o", "json")["items"]
        offline_since = time.monotonic()
        require(not pods and datetime.now(timezone.utc) < expiry and
                self.sql("SELECT status FROM labs WHERE id=?", (lab_id,)) == [{"status": "ready"}],
                "Broker was not proven offline with a live lease and unchanged SQLite state.")
        while time.monotonic() - offline_since < 150:
            if self.namespace(lab_id) is None:
                break
            time.sleep(2)
        elapsed = round(time.monotonic() - offline_since, 2)
        require(self.namespace(lab_id) is None and elapsed < 150,
                "The independent janitor did not remove the namespace within 150 seconds offline.")
        require(self.kube_json("get", "deployment", "lab-broker", "-n", CONTROL, "-o", "json")["spec"]["replicas"] == 0,
                "Broker unexpectedly resumed during independent cleanup.")
        job_deadline, janitor_finished = time.monotonic() + 15, False
        while time.monotonic() < job_deadline:
            jobs = self.kube_json("get", "jobs", "-n", CONTROL, "-o", "json")["items"]
            janitor_finished = any(job.get("status", {}).get("succeeded") == 1 and
                                   any(ref.get("uid") == janitor["metadata"]["uid"] for ref in job["metadata"].get("ownerReferences", [])) and
                                   datetime.fromisoformat(job["status"]["completionTime"].replace("Z", "+00:00")) >= expiry
                                   for job in jobs)
            if janitor_finished:
                break
            time.sleep(1)
        require(janitor_finished, "No independently scheduled janitor job completed after the lease expired.")
        # SQLite remains ready until the broker returns: the separate janitor
        # only deletes expired owned namespaces, never accesses the broker store.
        require(self.sql("SELECT status FROM labs WHERE id=?", (lab_id,)) == [{"status": "ready"}],
                "Broker state changed while the broker was expected to be offline.")
        self.restore()
        final = self.poll(path, lambda row: row.get("cleanupComplete") is True, 60, "Expired evidence reconciliation")
        snapshot = final.get("snapshot")
        require(final.get("status") == "expired" and isinstance(snapshot, dict) and
                bool(snapshot.get("error")) and not snapshot.get("content"),
                "Expired evidence did not honestly report that the namespace was already removed.")
        self.labs[path]["cleaned"] = True
        return {"brokerOfflineBeforeExpiry": True, "brokerOfflineDuringRemoval": True,
                "leaseSeconds": 90, "namespaceRemovedSecondsAfterBrokerOffline": elapsed,
                "expiredAndCleanupConfirmed": True, "snapshotUnavailableReported": True}

    def restore(self):
        if self.disrupted and self.original_replicas is not None:
            self.kube("scale", "deployment/lab-broker", "-n", CONTROL, "--replicas=" + str(self.original_replicas))
            self.wait_broker()

    def finalize(self):
        restored = False
        try:
            self.restore()
            restored = True
        except Exception:
            pass
        clean = self.cleanup_all() if restored else False
        for lab_id in self.own_ids():
            try:
                current = self.namespace(lab_id)
                if current:
                    meta = current["metadata"]
                    require(meta.get("labels", {}).get(MANAGED) == "true" and
                            meta.get("labels", {}).get(OWNER) == "pilot" and
                            meta.get("annotations", {}).get(LAB_ID) == lab_id and
                            (lab_id not in self.namespaces or meta["uid"] == self.namespaces[lab_id]),
                            "Refusing cleanup because test namespace ownership changed.")
                    self.kube("delete", "--raw", "/api/v1/namespaces/ua-lab-" + lab_id, "-f", "-",
                              data=json.dumps({"apiVersion": "v1", "kind": "DeleteOptions",
                                               "preconditions": {"uid": meta["uid"]}, "propagationPolicy": "Foreground"}))
                    self.kube("wait", "--for=delete", "namespace/ua-lab-" + lab_id, "--timeout=90s", timeout=100)
                require(self.namespace(lab_id) is None, "A synthetic namespace remained after final cleanup.")
            except Exception:
                clean = False
        self.results.append({"check": "broker_restored_and_all_test_namespaces_removed", "passed": restored and clean})
        return restored and clean


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubeconfig", default="/etc/rancher/k3s/k3s.yaml")
    parser.add_argument("--check", action="append", choices=("idle", "interrupted", "janitor"),
                        help="Run only selected checks; omit for the complete recovery suite.")
    args = parser.parse_args()
    suite, passed, error = None, False, None
    started = time.monotonic()
    try:
        suite = RecoveryChecks(args)
        requested = args.check or ("idle", "interrupted", "janitor")
        if "idle" in requested:
            suite.check("idle_lab_survives_broker_restart", suite.idle_restart)
        if "interrupted" in requested:
            suite.check("interrupted_command_fails_without_replay", suite.active_restart)
        if "janitor" in requested:
            suite.check("independent_janitor_removes_expired_lab_while_broker_offline", suite.independent_janitor)
        passed = True
    except Exception as exc:
        if isinstance(exc, AcceptanceFailure):
            error = str(exc)
        else:
            frame = traceback.extract_tb(exc.__traceback__)[-1]
            # Type and source location expose no request, credential or command values.
            error = f"Unexpected {type(exc).__name__} at {Path(frame.filename).name}:{frame.lineno}; no values were logged."
    finally:
        if suite is not None:
            passed = suite.finalize() and passed
    report = {"suite": "live_broker_recovery", "passed": passed,
              "requestedChecks": args.check or ["idle", "interrupted", "janitor"],
              "seconds": round(time.monotonic() - started, 2), "checks": suite.results if suite else []}
    if error:
        report["error"] = error
    print(json.dumps(report, indent=2), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
