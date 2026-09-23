"""Private Kubernetes lab broker. Candidate commands only execute inside sandbox pods."""
from __future__ import annotations

import concurrent.futures
import dataclasses
from datetime import datetime, timedelta, timezone
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
import time
import uuid

from manifests import MANAGED, OWNER, TEMPLATE, admission, lab_resources, namespace_manifest

LOG = logging.getLogger("lab-runner")
ID_RE = re.compile(r"^[a-z][a-z0-9]{19,39}$")
LIVE = ("starting", "ready")
FINAL = ("failed", "stopped", "expired")
OUTPUT_LIMIT = 32768
COMMAND_TIMEOUT = 20


def utcnow():
    return datetime.now(timezone.utc)


def timestamp(value=None):
    return (value or utcnow()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value):
    if not isinstance(value, str):
        raise ApiError(400, "expiresAt must be an ISO timestamp with timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc)
    except ValueError:
        raise ApiError(400, "expiresAt must be an ISO timestamp with timezone") from None


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        super().__init__(message)


@dataclasses.dataclass(frozen=True)
class Config:
    api_key: str
    owner: str
    cluster_uid: str
    runtime_class: str
    runtime_handler: str
    workspace_image: str
    api_cidrs: tuple[str, ...]
    api_ports: tuple[int, ...] = (443, 6443)
    database: str = "/data/labs.sqlite3"
    kubeconfig: str = "/run/cluster/kubeconfig"
    max_labs: int = 10
    port: int = 8080
    listen: str = "127.0.0.1"

    @classmethod
    def from_env(cls):
        required = ["LAB_RUNNER_API_KEY", "LAB_RUNNER_OWNER", "LAB_CLUSTER_UID", "LAB_RUNTIME_CLASS", "LAB_RUNTIME_HANDLER", "LAB_WORKSPACE_IMAGE", "LAB_API_CIDRS", "KUBECONFIG"]
        missing = [key for key in required if not os.environ.get(key)]
        if missing:
            raise RuntimeError("Required configuration missing: " + ", ".join(missing))
        for key in ("LAB_DEDICATED_CLUSTER", "LAB_NETWORK_POLICY_VERIFIED", "LAB_NODE_ISOLATION_VERIFIED"):
            if os.environ.get(key) != "true":
                raise RuntimeError(key + " must be true after completing the deployment checks")
        if len(os.environ["LAB_RUNNER_API_KEY"]) < 32:
            raise RuntimeError("LAB_RUNNER_API_KEY requires at least 32 characters")
        for key in ("LAB_RUNNER_OWNER", "LAB_RUNTIME_CLASS"):
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", os.environ[key]):
                raise RuntimeError(key + " must be a DNS label")
        if not re.fullmatch(r"(?:runsc|kata)(?:[-a-z0-9]*)", os.environ["LAB_RUNTIME_HANDLER"]):
            raise RuntimeError("LAB_RUNTIME_HANDLER must identify an installed gVisor or Kata handler")
        if not re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}", os.environ["LAB_WORKSPACE_IMAGE"]):
            raise RuntimeError("LAB_WORKSPACE_IMAGE must be pinned by sha256 digest")
        cidrs = tuple(x.strip() for x in os.environ["LAB_API_CIDRS"].split(","))
        for cidr in cidrs:
            network = ipaddress.ip_network(cidr, strict=True)
            if network.prefixlen != network.max_prefixlen or network.is_loopback or network.is_link_local or network.is_multicast or network.is_unspecified:
                raise RuntimeError("LAB_API_CIDRS must contain only exact API endpoint /32 or /128 addresses")
        ports = tuple(int(x) for x in os.environ.get("LAB_API_PORTS", "443,6443").split(","))
        if not ports or any(p < 1 or p > 65535 for p in ports):
            raise RuntimeError("LAB_API_PORTS is invalid")
        max_labs = int(os.environ.get("LAB_MAX_CONCURRENT", "10"))
        if not 1 <= max_labs <= 100:
            raise RuntimeError("LAB_MAX_CONCURRENT must be 1..100")
        return cls(os.environ["LAB_RUNNER_API_KEY"], os.environ["LAB_RUNNER_OWNER"], os.environ["LAB_CLUSTER_UID"],
                   os.environ["LAB_RUNTIME_CLASS"], os.environ["LAB_RUNTIME_HANDLER"], os.environ["LAB_WORKSPACE_IMAGE"], cidrs,
                   ports, os.environ.get("LAB_DB_PATH", "/data/labs.sqlite3"), os.environ["KUBECONFIG"], max_labs,
                   int(os.environ.get("PORT", "8080")), os.environ.get("LAB_LISTEN", "127.0.0.1"))


@dataclasses.dataclass
class Result:
    stdout: str
    stderr: str
    exit_code: int
    truncated: bool = False
    timed_out: bool = False
    cancelled: bool = False


def run_bounded(argv, *, timeout=30, stdin=None, cancel=None):
    """No shell interpolation. Drain both streams while retaining only bounded bytes."""
    process = subprocess.Popen(argv, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
    buffers = [bytearray(), bytearray()]
    truncated = [False, False]

    def drain(stream, index):
        try:
            while chunk := stream.read(4096):
                room = OUTPUT_LIMIT - len(buffers[index])
                buffers[index].extend(chunk[:max(0, room)])
                if len(chunk) > room:
                    truncated[index] = True
        finally:
            stream.close()

    readers = [threading.Thread(target=drain, args=(stream, index), daemon=True)
               for index, stream in enumerate((process.stdout, process.stderr))]
    for reader in readers:
        reader.start()
    if stdin is not None:
        try:
            process.stdin.write(stdin.encode("utf-8"))
            process.stdin.close()
        except BrokenPipeError:
            pass
    deadline = time.monotonic() + timeout
    cancelled = timed_out = False
    while process.poll() is None:
        cancelled = cancel is not None and cancel()
        timed_out = time.monotonic() >= deadline
        if cancelled or timed_out:
            process.kill()
            break
        time.sleep(0.05)
    process.wait()
    for reader in readers:
        reader.join(timeout=2)
    return Result(*(bytes(value).decode("utf-8", "replace") for value in buffers),
                  process.returncode, any(truncated), timed_out, cancelled)


class Cluster:
    def __init__(self, config):
        self.config = config

    def call(self, args, *, stdin=None, timeout=30, cancel=None, check=True):
        result = run_bounded(["kubectl", "--kubeconfig", self.config.kubeconfig, "--request-timeout=25s", *args],
                             stdin=stdin, timeout=timeout, cancel=cancel)
        if check and (result.exit_code or result.timed_out or result.cancelled):
            # Detailed diagnostics belong in operator logs, never candidate API responses.
            LOG.error("Cluster operation failed: %s", result.stderr[:1000])
            raise RuntimeError("The assessment cluster operation failed")
        return result

    def get(self, kind, name):
        result = self.call(["get", kind, name, "--ignore-not-found", "-o", "json"])
        return json.loads(result.stdout) if result.stdout.strip() else None

    def preflight(self):
        ns = self.get("namespace", "kube-system")
        if not ns or ns["metadata"]["uid"] != self.config.cluster_uid:
            raise RuntimeError("Assessment cluster fingerprint does not match")
        runtime = self.get("runtimeclass", self.config.runtime_class)
        if not runtime or runtime.get("handler") != self.config.runtime_handler:
            raise RuntimeError("Required sandbox RuntimeClass is not installed")
        # RuntimeClass scheduling must select isolated sandbox worker nodes, with no permissive fallback.
        selector = runtime.get("scheduling", {}).get("nodeSelector", {})
        if selector.get("uniqassess.com.node-restriction.kubernetes.io/sandbox") != "true":
            raise RuntimeError("RuntimeClass must select isolated assessment worker nodes")
        for expected in admission(self.config):
            actual = self.get(expected["kind"], expected["metadata"]["name"])
            if not actual or not policy_matches(actual.get("spec", {}), expected["spec"]):
                raise RuntimeError("Required admission policy is missing or differs from this runner")
            if expected["kind"] == "ValidatingAdmissionPolicy":
                state = actual.get("status", {})
                if "typeChecking" not in state or state["typeChecking"].get("expressionWarnings"):
                    raise RuntimeError("Admission policy type checking has not passed")

    def create_namespace(self, namespace, lab_id, expires_at):
        self.call(["create", "-f", "-"], stdin=json.dumps(namespace_manifest(namespace, lab_id, expires_at, self.config)))
        return self.get("namespace", namespace)["metadata"]["uid"]

    def apply_resource(self, item):
        self.call(["apply", "-f", "-"], stdin=json.dumps(item))

    def wait_ready(self, namespace, cancel):
        return self.call(["--request-timeout=95s", "-n", namespace, "wait", "--for=condition=Ready", "pod/workspace", "--timeout=90s"],
                         timeout=95, cancel=cancel)

    def execute(self, namespace, command, cancel):
        # The user text is a remote sh argument. It never reaches a shell on the broker/app host.
        return self.call(["-n", namespace, "exec", "workspace", "-c", "workspace", "--",
                          "timeout", "--signal=TERM", "--kill-after=1s", "19s", "sh", "-c", command],
                         timeout=COMMAND_TIMEOUT, cancel=cancel, check=False)

    def owned_namespace(self, lab):
        cluster_namespace = self.get("namespace", "kube-system")
        if not cluster_namespace or cluster_namespace["metadata"]["uid"] != self.config.cluster_uid:
            raise RuntimeError("Assessment cluster fingerprint does not match")
        current = self.get("namespace", lab["namespace"])
        if current is None:
            return None
        meta = current["metadata"]
        if (meta.get("labels", {}).get(MANAGED) != "true"
                or meta.get("labels", {}).get(OWNER) != self.config.owner
                or meta.get("annotations", {}).get("labs.uniqassess.com/id") != lab["id"]
                or (lab["namespace_uid"] and meta["uid"] != lab["namespace_uid"])):
            raise RuntimeError("Refusing to delete a namespace without matching ownership")
        return current

    def delete_namespace(self, lab):
        current = self.owned_namespace(lab)
        if current is None:
            return True
        meta = current["metadata"]
        if "deletionTimestamp" not in meta:
            # UID precondition prevents deleting a replacement namespace in a get/delete race.
            self.call(["delete", "--raw", "/api/v1/namespaces/" + lab["namespace"], "-f", "-"],
                      stdin=json.dumps({"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": meta["uid"]}, "propagationPolicy": "Foreground"}))
        return False  # Keep polling until Kubernetes confirms the namespace no longer exists.

    def snapshot(self, lab):
        if not self.owned_namespace(lab):
            return {"capturedAt": timestamp(), "content": "", "truncated": False, "error": "Namespace was already removed"}
        result = self.call(["-n", lab["namespace"], "get", "deployments,services,pods,events", "-o", "json"], check=False)
        return {"capturedAt": timestamp(), "content": result.stdout[:OUTPUT_LIMIT],
                "truncated": result.truncated, "error": "State capture was unavailable" if result.exit_code else None}


def policy_matches(actual, expected):
    """Only permit Kubernetes' known defaults; reject added exclusions/matchConditions."""
    actual = json.loads(json.dumps(actual))
    constraints = actual.get("matchConstraints")
    if constraints:
        if constraints.get("matchPolicy") == "Equivalent":
            constraints.pop("matchPolicy")
        if constraints.get("objectSelector") == {}:
            constraints.pop("objectSelector")
        for rule in constraints.get("resourceRules", []):
            if rule.get("scope") == "*":
                rule.pop("scope")
    return actual == expected


class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS labs (
                id TEXT PRIMARY KEY, template TEXT NOT NULL, namespace TEXT NOT NULL UNIQUE,
                namespace_uid TEXT, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
                error TEXT, cleanup_pending INTEGER NOT NULL DEFAULT 0, snapshot TEXT
            );
            CREATE TABLE IF NOT EXISTS commands (
                id TEXT NOT NULL, lab_id TEXT NOT NULL REFERENCES labs(id), command TEXT NOT NULL,
                status TEXT NOT NULL, stdout TEXT NOT NULL DEFAULT '', stderr TEXT NOT NULL DEFAULT '',
                exit_code INTEGER, truncated INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                PRIMARY KEY(lab_id,id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_command ON commands(lab_id)
                WHERE status IN ('queued','running');
        """)

    def one(self, query, values=()):
        with self.lock:
            row = self.db.execute(query, values).fetchone()
            return dict(row) if row else None

    def all(self, query, values=()):
        with self.lock:
            return [dict(row) for row in self.db.execute(query, values).fetchall()]

    def write(self, query, values=()):
        with self.lock, self.db:
            return self.db.execute(query, values).rowcount


def public_lab(row):
    result = {"id": row["id"], "status": row["status"], "expiresAt": row["expires_at"],
              "cleanupComplete": row["status"] in FINAL and not bool(row["cleanup_pending"])}
    if row.get("error"):
        result["error"] = row["error"]
    if row.get("snapshot"):
        result["snapshot"] = json.loads(row["snapshot"])
    return result


def public_command(row):
    result = {"id": row["id"], "status": row["status"], "stdout": row["stdout"], "stderr": row["stderr"],
              "exitCode": row["exit_code"], "truncated": bool(row["truncated"])}
    for source, target in (("started_at", "startedAt"), ("finished_at", "finishedAt")):
        if row[source]:
            result[target] = row[source]
    return result


class Broker:
    def __init__(self, config, cluster=None, *, start_workers=True):
        self.config = config
        self.store = Store(config.database)
        self.cluster = cluster or Cluster(config)
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=config.max_labs * 2 + 2)
        self.stopping = threading.Event()
        self.jobs_lock = threading.Lock()
        self.jobs = set()
        self.lab_locks = {}
        self.worker_thread = None
        if start_workers:
            self.recover()
            self.worker_thread = threading.Thread(target=self.maintain, daemon=True)
            self.worker_thread.start()

    def lab(self, lab_id):
        if not ID_RE.fullmatch(lab_id):
            raise ApiError(400, "Invalid lab id")
        row = self.store.one("SELECT * FROM labs WHERE id=?", (lab_id,))
        if not row:
            raise ApiError(404, "Lab not found")
        if row["status"] in LIVE and parse_time(row["expires_at"]) <= utcnow():
            self.stop(lab_id, "expired")
            row = self.store.one("SELECT * FROM labs WHERE id=?", (lab_id,))
        return row

    def command(self, lab_id, command_id):
        self.lab(lab_id)
        row = self.store.one("SELECT * FROM commands WHERE lab_id=? AND id=?", (lab_id, command_id))
        if not row:
            raise ApiError(404, "Command not found")
        return row

    def create(self, lab_id, body):
        if not ID_RE.fullmatch(lab_id) or body.get("templateId") != TEMPLATE:
            raise ApiError(400, "Invalid lab id or unknown templateId")
        expiry = timestamp(parse_time(body.get("expiresAt")))
        with self.store.lock:
            existing = self.store.one("SELECT * FROM labs WHERE id=?", (lab_id,))
            if existing:
                if existing["template"] == "tombstone":
                    return public_lab(existing)
                if existing["template"] != body["templateId"] or existing["expires_at"] != expiry:
                    raise ApiError(409, "Lab id already exists with different configuration")
                return public_lab(self.lab(lab_id))
            if not utcnow() < parse_time(expiry) <= utcnow() + timedelta(minutes=120):
                raise ApiError(400, "expiresAt must be in the future and no more than 120 minutes away")
            count = self.store.one("SELECT COUNT(*) AS n FROM labs WHERE status IN ('starting','ready') OR cleanup_pending=1")["n"]
            if count >= self.config.max_labs:
                raise ApiError(429, "The assessment cluster is at capacity")
            self.store.write("INSERT INTO labs(id,template,namespace,status,expires_at,created_at) VALUES(?,?,?,'starting',?,?)",
                             (lab_id, TEMPLATE, "ua-lab-" + lab_id, expiry, timestamp()))
        self.submit("provision", lab_id, self.provision)
        return public_lab(self.lab(lab_id))

    def enqueue(self, lab_id, body):
        command_id, command = body.get("id"), body.get("command")
        try:
            if not isinstance(command_id, str) or str(uuid.UUID(command_id)) != command_id:
                raise ValueError()
        except (ValueError, AttributeError):
            raise ApiError(400, "Command id must be a canonical UUID") from None
        if not isinstance(command, str) or not command.strip() or len(command) > 8000 or "\x00" in command:
            raise ApiError(400, "Command must contain 1..8000 characters and no NUL bytes")
        with self.store.lock:
            lab = self.lab(lab_id)
            existing = self.store.one("SELECT * FROM commands WHERE lab_id=? AND id=?", (lab_id, command_id))
            if existing:
                if existing["command"] != command:
                    raise ApiError(409, "Command id already exists with different text")
                return public_command(existing)
            if lab["status"] != "ready":
                raise ApiError(409, "Lab is not ready")
            if self.store.one("SELECT id FROM commands WHERE lab_id=? AND status IN ('queued','running')", (lab_id,)):
                raise ApiError(409, "A command is already running")
            if self.store.one("SELECT COUNT(*) AS n FROM commands WHERE lab_id=?", (lab_id,))["n"] >= 100:
                raise ApiError(429, "The lab command limit has been reached")
            self.store.write("INSERT INTO commands(id,lab_id,command,status,created_at) VALUES(?,?,?,'queued',?)", (command_id, lab_id, command, timestamp()))
        self.submit("command", lab_id, self.execute)
        return public_command(self.command(lab_id, command_id))

    def stop(self, lab_id, status="stopped", error=None):
        if not ID_RE.fullmatch(lab_id):
            raise ApiError(400, "Invalid lab id")
        with self.store.lock:
            row = self.store.one("SELECT * FROM labs WHERE id=?", (lab_id,))
            if not row:
                self.store.write("INSERT INTO labs(id,template,namespace,status,expires_at,created_at,cleanup_pending) VALUES(?,'tombstone',?,'stopped',?,?,1)",
                                 (lab_id, "ua-lab-" + lab_id, timestamp(), timestamp()))
                return public_lab(self.store.one("SELECT * FROM labs WHERE id=?", (lab_id,)))
            if row["status"] in LIVE:
                self.store.write("UPDATE labs SET status=?,error=?,cleanup_pending=1 WHERE id=?", (status, error, lab_id))
                self.store.write("UPDATE commands SET status='failed',stderr=?,finished_at=? WHERE lab_id=? AND status IN ('queued','running')",
                                 ("The lab ended before this command completed.", timestamp(), lab_id))
        return public_lab(self.store.one("SELECT * FROM labs WHERE id=?", (lab_id,)))

    def cancelled(self, lab_id):
        return self.stopping.is_set() or self.lab(lab_id)["status"] not in LIVE

    def submit(self, kind, lab_id, action):
        key = (kind, lab_id)
        with self.jobs_lock:
            if key in self.jobs or self.stopping.is_set():
                return
            self.jobs.add(key)
            lock = self.lab_locks.setdefault(lab_id, threading.Lock())

        def work():
            try:
                with lock:
                    action(lab_id)
            except Exception:
                LOG.exception("Lab operation failed: %s %s", kind, lab_id)
                if kind != "cleanup":
                    self.stop(lab_id, "failed", "The lab could not complete this operation. Contact the assessor.")
            finally:
                with self.jobs_lock:
                    self.jobs.discard(key)
        self.executor.submit(work)

    def provision(self, lab_id):
        lab = self.lab(lab_id)
        if self.cancelled(lab_id):
            return
        self.cluster.preflight()
        if self.cancelled(lab_id):
            return
        uid = self.cluster.create_namespace(lab["namespace"], lab_id, lab["expires_at"])
        self.store.write("UPDATE labs SET namespace_uid=? WHERE id=?", (uid, lab_id))
        for item in lab_resources(lab["namespace"], self.config):
            if self.cancelled(lab_id):
                return
            self.cluster.apply_resource(item)
        self.cluster.wait_ready(lab["namespace"], lambda: self.cancelled(lab_id))
        if not self.cancelled(lab_id):
            self.store.write("UPDATE labs SET status='ready' WHERE id=? AND status='starting'", (lab_id,))

    def execute(self, lab_id):
        lab = self.lab(lab_id)
        if lab["status"] != "ready":
            return
        command = self.store.one("SELECT * FROM commands WHERE lab_id=? AND status='queued'", (lab_id,))
        if not command:
            return
        changed = self.store.write("UPDATE commands SET status='running',started_at=? WHERE lab_id=? AND id=? AND status='queued'", (timestamp(), lab_id, command["id"]))
        if not changed:
            return
        result = self.cluster.execute(lab["namespace"], command["command"], lambda: self.cancelled(lab_id))
        timeout = result.timed_out or result.exit_code in (124, 137)
        stderr = result.stderr[:OUTPUT_LIMIT]
        if timeout:
            stderr = (stderr + "\nCommand exceeded the time limit; this lab has been stopped.")[:OUTPUT_LIMIT]
        self.store.write("UPDATE commands SET status=?,stdout=?,stderr=?,exit_code=?,truncated=?,finished_at=? WHERE lab_id=? AND id=? AND status='running'",
                         ("failed" if timeout or result.cancelled else "completed", result.stdout[:OUTPUT_LIMIT], stderr,
                          result.exit_code, int(result.truncated), timestamp(), lab_id, command["id"]))
        if timeout:
            # Killing kubectl alone does not prove remote/background processes stopped.
            self.stop(lab_id, "failed", "A command exceeded the time limit. The lab is being removed.")

    def cleanup(self, lab_id):
        lab = self.lab(lab_id)
        if lab["status"] in FINAL and lab["cleanup_pending"]:
            if lab["namespace_uid"] and not lab["snapshot"]:
                try:
                    snapshot = self.cluster.snapshot(lab)
                except Exception:
                    LOG.exception("Final state capture failed for %s", lab_id)
                    snapshot = {"capturedAt": timestamp(), "content": "", "truncated": False, "error": "State capture was unavailable"}
                self.store.write("UPDATE labs SET snapshot=? WHERE id=?", (json.dumps(snapshot), lab_id))
            if self.cluster.delete_namespace(lab):
                self.store.write("UPDATE labs SET cleanup_pending=0 WHERE id=?", (lab_id,))

    def recover(self):
        # Never replay a possibly executed command or overwrite partially repaired exercises.
        interrupted = self.store.all("SELECT DISTINCT labs.id FROM labs LEFT JOIN commands ON labs.id=commands.lab_id WHERE labs.status='starting' OR commands.status IN ('queued','running')")
        for row in interrupted:
            self.stop(row["id"], "failed", "The runner restarted during an operation. The lab is being removed.")

    def tick(self):
        for lab in self.store.all("SELECT * FROM labs WHERE status IN ('starting','ready') OR cleanup_pending=1"):
            if lab["status"] in LIVE and parse_time(lab["expires_at"]) <= utcnow():
                self.stop(lab["id"], "expired")
            if lab["cleanup_pending"] or parse_time(lab["expires_at"]) <= utcnow():
                self.submit("cleanup", lab["id"], self.cleanup)
        # Covers a new enqueue racing the previous worker's final bookkeeping.
        for command in self.store.all("SELECT lab_id FROM commands WHERE status='queued'"):
            self.submit("command", command["lab_id"], self.execute)

    def maintain(self):
        while not self.stopping.is_set():
            try:
                self.tick()
            except Exception:
                LOG.exception("Lifecycle reconciliation failed")
            self.stopping.wait(2)

    def close(self):
        self.stopping.set()
        if self.worker_thread:
            self.worker_thread.join(timeout=3)
        self.executor.shutdown(wait=True)
        self.store.db.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "LabBroker"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, fmt, *args):
        # Never log body, credentials or candidate command output.
        LOG.info("HTTP %s %s", self.command, args[1] if len(args) > 1 else "")

    def send_json(self, status, value):
        payload = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def body(self):
        length = self.headers.get("Content-Length", "")
        if not length.isdecimal() or not 0 < int(length) <= 40000 or self.headers.get("Transfer-Encoding"):
            raise ApiError(400, "A bounded JSON Content-Length is required")
        try:
            value = json.loads(self.rfile.read(int(length)))
        except (ValueError, UnicodeError):
            raise ApiError(400, "Invalid JSON") from None
        if not isinstance(value, dict):
            raise ApiError(400, "Expected a JSON object")
        return value

    def dispatch(self):
        broker = self.server.broker
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode(), ("Bearer " + broker.config.api_key).encode()):
            raise ApiError(401, "Unauthorized")
        path = re.fullmatch(r"/v1/labs/([a-z][a-z0-9]{19,39})(?:/commands(?:/([a-f0-9-]{36}))?)?", self.path)
        if not path:
            raise ApiError(404, "Route not found")
        lab_id, command_id = path.groups()
        is_commands = "/commands" in self.path
        if self.command == "PUT" and not is_commands:
            return 200, broker.create(lab_id, self.body())
        if self.command == "GET":
            if command_id:
                return 200, public_command(broker.command(lab_id, command_id))
            if not is_commands:
                return 200, public_lab(broker.lab(lab_id))
        if self.command == "POST" and is_commands and not command_id:
            return 202, broker.enqueue(lab_id, self.body())
        if self.command == "DELETE" and not is_commands:
            return 200, broker.stop(lab_id)
        raise ApiError(405, "Method not allowed")

    def handle_request(self):
        try:
            status, value = self.dispatch()
        except ApiError as error:
            status, value = error.status, {"error": error.message}
        except Exception:
            LOG.exception("Request failed")
            status, value = 500, {"error": "The lab service could not complete the request"}
        self.send_json(status, value)

    do_GET = do_PUT = do_POST = do_DELETE = handle_request


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = Config.from_env()
    # This broker is intentionally single-instance: SQLite, one active process, durable disk.
    import fcntl
    Path(config.database).parent.mkdir(parents=True, exist_ok=True)
    lock_file = open(config.database + ".lock", "a")
    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    cluster = Cluster(config)
    # Safety drift blocks new provisioning; it must never prevent expiry/cleanup after restart.
    broker = Broker(config, cluster)
    server = ThreadingHTTPServer((config.listen, config.port), Handler)
    server.broker = broker
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        broker.close()
        lock_file.close()


if __name__ == "__main__":
    main()
