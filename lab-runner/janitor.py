"""Independent expiry sweep: run once a minute even while the broker is unavailable."""
import logging
import os
import re
from types import SimpleNamespace

from manifests import MANAGED, OWNER
from runner import Cluster, ID_RE, parse_time, utcnow


def sweep(cluster, config):
    namespace = cluster.get("namespace", "kube-system")
    if not namespace or namespace["metadata"]["uid"] != config.cluster_uid:
        raise RuntimeError("Assessment cluster fingerprint does not match")
    # Names only keep the listing small; each namespace is re-read and ownership checked.
    result = cluster.call(["get", "namespaces", "-l", f"{MANAGED}=true,{OWNER}={config.owner}", "-o", "name"])
    if result.truncated:
        raise RuntimeError("Namespace inventory exceeded safe bounds; operator intervention required")
    deleted = 0
    for entry in result.stdout.splitlines():
        name = entry.removeprefix("namespace/")
        lab_id = name.removeprefix("ua-lab-")
        if name != "ua-lab-" + lab_id or not ID_RE.fullmatch(lab_id):
            continue
        current = cluster.get("namespace", name)
        if not current:
            continue
        metadata = current["metadata"]
        expiry = metadata.get("annotations", {}).get("labs.uniqassess.com/expires-at")
        if not expiry:
            logging.error("Owned lab is missing expiry: %s", name)
            continue
        if parse_time(expiry) <= utcnow():
            cluster.delete_namespace({"id": lab_id, "namespace": name, "namespace_uid": metadata["uid"]})
            deleted += 1
    return deleted


def main():
    owner = os.environ["LAB_RUNNER_OWNER"]
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", owner):
        raise RuntimeError("Invalid owner")
    config = SimpleNamespace(owner=owner, kubeconfig=os.environ["KUBECONFIG"], cluster_uid=os.environ["LAB_CLUSTER_UID"])
    print(f"Requested cleanup of {sweep(Cluster(config), config)} expired namespaces")


if __name__ == "__main__":
    main()
