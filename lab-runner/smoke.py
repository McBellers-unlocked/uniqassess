"""Opt-in live acceptance check. Creates and then removes one real staging lab."""
from datetime import datetime, timedelta, timezone
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def main():
    base = os.environ["LAB_RUNNER_URL"].rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")):
        raise RuntimeError("Use a private HTTPS endpoint (HTTP is allowed only for localhost)")
    key = os.environ["LAB_RUNNER_API_KEY"]
    lab_id = "c" + uuid.uuid4().hex
    path = "/v1/labs/" + lab_id

    def request(method, route, body=None):
        req = urllib.request.Request(base + route, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)

    def poll(route, done, seconds=120):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            result = request("GET", route)
            if done(result):
                return result
            time.sleep(1)
        raise RuntimeError("Timed out waiting for " + route)

    def command(text, expected=0):
        body = {"id": str(uuid.uuid4()), "command": text}
        initial = request("POST", path + "/commands", body)
        repeated = request("POST", path + "/commands", body)
        assert initial["id"] == repeated["id"], "Idempotency failed"
        result = poll(path + "/commands/" + body["id"], lambda r: r["status"] not in ("queued", "running"), 30)
        assert result["status"] == "completed", result
        if expected is not None:
            assert result["exitCode"] == expected, result
        return result

    print("Staging smoke-test lab: " + lab_id, flush=True)
    try:
        expiry = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
        body = {"templateId": "kubernetes-troubleshooting-v1", "expiresAt": expiry}
        request("PUT", path, body)
        request("PUT", path, body)
        lab = poll(path, lambda r: r["status"] != "starting")
        assert lab["status"] == "ready", lab
        command("kubectl get pods,deployments,services")
        command("printf 'saved evidence\\n' > /workspace/smoke-note.txt")
        assert "saved evidence" in command("cat /workspace/smoke-note.txt")["stdout"]
        denied = command("kubectl auth can-i get pods -n kube-system", expected=1)
        assert denied["stdout"].strip() == "no", denied
        command("kubectl patch deployment checkout --type=json -p='[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/readinessProbe/httpGet/port\",\"value\":8080}]'")
        command("kubectl patch service checkout --type=merge -p='{\"spec\":{\"selector\":{\"app\":\"checkout\"}}}'")
        for attempt in range(5):
            rollout = command("kubectl rollout status deployment/checkout --timeout=8s", expected=None)
            if rollout["exitCode"] == 0:
                break
        else:
            raise RuntimeError("Checkout did not recover: " + rollout["stderr"])
        assert json.loads(command("curl --fail --silent --show-error --max-time 3 http://checkout/checkout")["stdout"])["status"] == "ok"
        print("Exercise repair, workspace persistence, idempotency and cross-namespace RBAC passed.")
    finally:
        request("DELETE", path)
        final = poll(path, lambda r: r.get("cleanupComplete") is True, 120)
        assert final["status"] in ("stopped", "failed", "expired"), final
        print("Namespace deletion confirmed; final snapshot " + ("recorded." if final.get("snapshot") else "unavailable."))


if __name__ == "__main__":
    main()
