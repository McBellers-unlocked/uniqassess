"""Console container entry point; uses only its projected namespace-scoped token."""
import json
import os
from pathlib import Path
import shutil
import signal
import time

TOKEN_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")
namespace = (TOKEN_DIR / "namespace").read_text().strip()
host = os.environ["KUBERNETES_SERVICE_HOST"]
if ":" in host:
    host = "[" + host + "]"
port = os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443")
config = {
    "apiVersion": "v1", "kind": "Config",
    "clusters": [{"name": "assessment", "cluster": {"server": f"https://{host}:{port}", "certificate-authority": str(TOKEN_DIR / "ca.crt")}}],
    "users": [{"name": "candidate", "user": {"tokenFile": str(TOKEN_DIR / "token")}}],
    "contexts": [{"name": "assessment", "context": {"cluster": "assessment", "user": "candidate", "namespace": namespace}}],
    "current-context": "assessment",
}
Path("/tmp/kubeconfig").write_text(json.dumps(config))
os.chmod("/tmp/kubeconfig", 0o600)
shutil.copyfile("/opt/lab/brief.md", "/workspace/README.md")


def reap(_signal, _frame):
    try:
        while os.waitpid(-1, os.WNOHANG)[0]:
            pass
    except ChildProcessError:
        pass


signal.signal(signal.SIGCHLD, reap)
while True:
    time.sleep(30)
