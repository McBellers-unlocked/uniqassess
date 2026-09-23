"""Opt-in broker lifecycle acceptance on real disposable labs.

Run explicitly with LAB_RUNNER_URL and LAB_RUNNER_API_KEY after runner readiness:
    python lab-runner/live_lifecycle.py

Creates at most one active lab at a time, each with a five-minute lease. All known
labs are stopped in finally, including after a failed check. This does not restart
the broker or replace host-side janitor, admission, network or isolation checks.
Only a JSON check summary is printed; credentials and command output are omitted.
"""
from datetime import datetime, timedelta, timezone
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


TEMPLATE = "kubernetes-troubleshooting-v1"
OUTPUT_LIMIT = 32_768
TERMINAL = {"failed", "stopped", "expired"}
ACTIVE_COMMAND = {"queued", "running"}


class AcceptanceFailure(Exception):
    """Only fixed, non-sensitive descriptions are raised to the report."""


def require(condition, message):
    if not condition:
        raise AcceptanceFailure(message)


def timestamp(value):
    return value.isoformat().replace("+00:00", "Z")


class LiveChecks:
    def __init__(self):
        self.base = os.environ.get("LAB_RUNNER_URL", "").rstrip("/")
        parsed = urllib.parse.urlsplit(self.base)
        local_http = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
        require(bool(parsed.hostname) and (parsed.scheme == "https" or local_http)
                and not parsed.username and not parsed.password and not parsed.query
                and not parsed.fragment and not parsed.path,
                "LAB_RUNNER_URL must be an HTTPS origin, or a local HTTP origin.")
        self.key = os.environ.get("LAB_RUNNER_API_KEY", "")
        require(bool(self.key), "LAB_RUNNER_API_KEY is required.")
        self.labs = {}
        self.results = []

    def request(self, method, path, body=None, expected=(200,)):
        request = urllib.request.Request(
            self.base + path,
            method=method,
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                status, payload = response.status, response.read(200_000)
        except urllib.error.HTTPError as error:
            status, payload = error.code, error.read(200_000)
            error.close()
        except Exception:
            raise AcceptanceFailure("Broker connection failed; no request or credential values were logged.") from None
        require(status in expected, "Broker returned an unexpected HTTP status (" + str(status) + ").")
        try:
            result = json.loads(payload)
        except (ValueError, UnicodeError):
            raise AcceptanceFailure("Broker returned invalid JSON.") from None
        require(isinstance(result, dict), "Broker response was not a JSON object.")
        return result

    def poll(self, path, done, seconds, label):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            result = self.request("GET", path)
            if done(result):
                return result
            time.sleep(0.5)
        raise AcceptanceFailure(label + " did not finish within its bounded wait.")

    def allocate(self):
        lab_id = "c" + uuid.uuid4().hex
        path = "/v1/labs/" + lab_id
        body = {"templateId": TEMPLATE, "expiresAt": timestamp(datetime.now(timezone.utc) + timedelta(minutes=5))}
        # Track before the first request so lost create responses are also cleaned up.
        self.labs[path] = {"body": body, "cleaned": False}
        return path, body

    def start(self):
        path, body = self.allocate()
        first = self.request("PUT", path, body)
        require(first.get("status") in ("starting", "ready"), "A new lab did not enter provisioning.")
        lab = self.poll(path, lambda value: value.get("status") != "starting", 120, "Lab provisioning")
        require(lab.get("status") == "ready", "The disposable lab failed to become ready.")
        return path, body, lab

    def enqueue(self, path, command, command_id=None):
        body = {"id": command_id or str(uuid.uuid4()), "command": command}
        result = self.request("POST", path + "/commands", body, expected=(202,))
        require(result.get("id") == body["id"], "Broker returned a different command ID.")
        return body, result

    def completed(self, path, body, seconds=35):
        return self.poll(path + "/commands/" + body["id"],
                         lambda value: value.get("status") not in ACTIVE_COMMAND,
                         seconds, "Command execution")

    def run(self, path, command):
        body, _ = self.enqueue(path, command)
        result = self.completed(path, body)
        require(result.get("status") == "completed" and result.get("exitCode") == 0,
                "A bounded acceptance command did not complete successfully.")
        return result

    def stop(self, path, snapshot=False):
        self.request("DELETE", path)
        final = self.poll(path, lambda value: value.get("cleanupComplete") is True, 90, "Namespace cleanup")
        require(final.get("status") in TERMINAL, "A removed lab still reports an active state.")
        if snapshot:
            require(isinstance(final.get("snapshot"), dict) and bool(final["snapshot"].get("content"))
                    and not final["snapshot"].get("error"), "Final observed resource snapshot was not retained.")
        self.labs[path]["cleaned"] = True
        return final

    def check(self, name, action):
        started = time.monotonic()
        try:
            details = action()
        except Exception as error:
            self.results.append({"check": name, "passed": False, "seconds": round(time.monotonic() - started, 2),
                                 "error": str(error) if isinstance(error, AcceptanceFailure) else "Unexpected acceptance-check failure."})
            raise
        self.results.append({"check": name, "passed": True, "seconds": round(time.monotonic() - started, 2),
                             **(details or {})})

    def tombstone(self):
        path, body = self.allocate()
        stopped = self.request("DELETE", path)
        require(stopped.get("status") == "stopped", "Deleting an unknown lab did not create a closed tombstone.")
        repeated = self.request("PUT", path, body)
        require(repeated.get("status") == "stopped", "Create resurrected a previously deleted lab ID.")
        self.request("POST", path + "/commands", {"id": str(uuid.uuid4()), "command": "true"}, expected=(409,))
        self.stop(path)
        repeated = self.request("PUT", path, body)
        require(repeated.get("status") == "stopped" and repeated.get("cleanupComplete") is True,
                "A cleaned tombstone was resurrected.")

    def normal(self):
        path, body, ready = self.start()

        def idempotent_start():
            repeated = self.request("PUT", path, body)
            require(repeated.get("id") == ready.get("id") and repeated.get("status") == "ready"
                    and repeated.get("expiresAt") == ready.get("expiresAt"), "Repeated start changed the existing lab.")
            original_expiry = datetime.fromisoformat(body["expiresAt"].replace("Z", "+00:00"))
            conflicting = {**body, "expiresAt": timestamp(original_expiry - timedelta(seconds=1))}
            self.request("PUT", path, conflicting, expected=(409,))
            observed = self.request("GET", path)
            require(observed.get("expiresAt") == ready.get("expiresAt"), "Conflicting start altered the lease.")

        self.check("idempotent_start_and_conflicting_expiry", idempotent_start)

        def command_once():
            command = "printf 'once\\n' >> /workspace/lifecycle-counter; sleep 5; cat /workspace/lifecycle-counter"
            entry, _ = self.enqueue(path, command)
            repeated = self.request("POST", path + "/commands", entry, expected=(202,))
            require(repeated.get("id") == entry["id"], "Command retry changed its identifier.")
            self.request("POST", path + "/commands", {**entry, "command": "printf 'different\\n'"}, expected=(409,))
            self.request("POST", path + "/commands", {"id": str(uuid.uuid4()), "command": "true"}, expected=(409,))
            result = self.completed(path, entry)
            require(result.get("status") == "completed" and result.get("exitCode") == 0
                    and result.get("stdout") == "once\n", "The idempotent command did not execute exactly once.")
            repeated = self.request("POST", path + "/commands", entry, expected=(202,))
            require(repeated == result, "Retry after completion did not return the retained command result.")
            require(self.run(path, "cat /workspace/lifecycle-counter").get("stdout") == "once\n",
                    "The completed command retry ran again.")
            return {"singleActiveCommandEnforced": True}

        self.check("command_retry_once_and_conflicting_text", command_once)

        def truncation():
            result = self.run(path, "python -c \"import sys; sys.stdout.write('x'*100000); sys.stderr.write('y'*100000)\"")
            require(result.get("truncated") is True, "Excessive output was not marked truncated.")
            require(result.get("stdout") == "x" * OUTPUT_LIMIT and result.get("stderr") == "y" * OUTPUT_LIMIT,
                    "Both output streams were not independently capped at the retention limit.")
            return {"retainedStdoutCharacters": len(result["stdout"]), "retainedStderrCharacters": len(result["stderr"])}

        self.check("both_output_streams_truncated", truncation)

        def closed_lab():
            final = self.stop(path, snapshot=True)
            self.request("POST", path + "/commands", {"id": str(uuid.uuid4()), "command": "true"}, expected=(409,))
            repeated = self.request("PUT", path, body)
            require(repeated.get("status") == final.get("status") and repeated.get("cleanupComplete") is True,
                    "Repeated start reopened a closed lab.")
            return {"cleanupComplete": True, "snapshotRetained": True}

        self.check("explicit_stop_cleanup_and_lockout", closed_lab)

    def timeout(self):
        path, body, _ = self.start()
        entry, _ = self.enqueue(path, "printf 'before-timeout\\n'; sleep 45; printf 'must-not-complete\\n'")
        result = self.completed(path, entry, seconds=40)
        require(result.get("status") == "failed", "A timed-out command was not marked failed.")
        require("must-not-complete" not in result.get("stdout", ""), "A command continued beyond the time limit.")
        # Do not send DELETE until the runner has independently retired and cleaned it.
        final = self.poll(path, lambda value: value.get("cleanupComplete") is True, 90, "Timeout retirement")
        require(final.get("status") == "failed", "Command timeout did not independently retire the lab.")
        require(isinstance(final.get("snapshot"), dict), "Timed-out lab has no retained final-state record.")
        self.labs[path]["cleaned"] = True
        self.request("POST", path + "/commands", {"id": str(uuid.uuid4()), "command": "true"}, expected=(409,))
        repeated = self.request("PUT", path, body)
        require(repeated.get("status") == "failed" and repeated.get("cleanupComplete") is True,
                "A start retry revived a timed-out lab.")
        return {"cleanupComplete": True, "independentRetirement": True}

    def stop_running(self):
        path, body, _ = self.start()
        entry, _ = self.enqueue(path, "printf 'running\\n'; sleep 15; printf 'must-not-complete\\n'")
        observed = self.poll(path + "/commands/" + entry["id"],
                             lambda value: value.get("status") != "queued", 10, "Running command")
        require(observed.get("status") == "running", "Stop race did not reach an in-flight command.")
        self.request("DELETE", path)
        result = self.completed(path, entry)
        require(result.get("status") == "failed" and "must-not-complete" not in result.get("stdout", ""),
                "Stopping an in-flight lab did not fail its command.")
        repeated = self.request("PUT", path, body)
        require(repeated.get("status") == "stopped", "Start raced with stop and revived the lab.")
        self.stop(path, snapshot=True)
        retained = self.request("GET", path + "/commands/" + entry["id"])
        require(retained.get("status") == "failed", "In-flight command failure was not retained after cleanup.")
        return {"cleanupComplete": True, "commandFailureRetained": True}

    def cleanup_all(self):
        failures = 0
        for path, lab in self.labs.items():
            try:
                # DELETE is idempotent. Issue it for every known lab, even those
                # already cleaned, so failure handling never leaves a live lease.
                self.stop(path)
            except Exception:
                failures += 1
        self.results.append({"check": "finally_stop_all_labs", "passed": failures == 0,
                             "labsTracked": len(self.labs), "cleanupFailures": failures,
                             "cleanupConfirmed": sum(lab["cleaned"] for lab in self.labs.values())})
        return failures == 0


def main():
    started = time.monotonic()
    suite = None
    passed = False
    setup_error = None
    try:
        suite = LiveChecks()
        suite.check("delete_before_create_tombstone", suite.tombstone)
        suite.normal()
        suite.check("long_command_timeout_retires_and_cleans_lab", suite.timeout)
        suite.check("stop_during_command", suite.stop_running)
        passed = True
    except Exception as error:
        setup_error = str(error) if isinstance(error, AcceptanceFailure) else "Unexpected lifecycle acceptance failure."
    finally:
        if suite is not None:
            passed = suite.cleanup_all() and passed
    report = {"suite": "live_broker_lifecycle", "passed": passed,
              "seconds": round(time.monotonic() - started, 2), "checks": suite.results if suite else []}
    if setup_error:
        report["error"] = setup_error
    print(json.dumps(report, indent=2), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
