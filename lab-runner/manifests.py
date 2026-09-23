"""Versioned lab resources and admission controls. JSON output is valid kubectl input."""
import argparse
import json
from pathlib import Path

TEMPLATE = "kubernetes-troubleshooting-v1"
MANAGED = "labs.uniqassess.com/managed"
OWNER = "labs.uniqassess.com/owner"
POLICY_VERSION = "v1"


def resource(kind, name, spec=None, api="v1", namespace=None, **extra):
    obj = {"apiVersion": api, "kind": kind, "metadata": {"name": name}, **extra}
    if namespace:
        obj["metadata"]["namespace"] = namespace
    if spec is not None:
        obj["spec"] = spec
    return obj


def admission(config):
    """The broker checks these exact specs before provisioning each new lab."""
    selector = {"matchLabels": {MANAGED: "true"}}
    pod_rules = [
        ("has(object.spec.runtimeClassName) && object.spec.runtimeClassName == " + json.dumps(config.runtime_class),
         "All assessment pods require the configured sandbox RuntimeClass."),
        ("object.spec.containers.all(c, c.image == " + json.dumps(config.workspace_image) + ") && (!has(object.spec.initContainers) || object.spec.initContainers.all(c, c.image == " + json.dumps(config.workspace_image) + "))",
         "Use the approved, digest-pinned assessment image."),
        ("!has(object.spec.ephemeralContainers) || size(object.spec.ephemeralContainers) == 0",
         "Ephemeral containers are disabled in assessment labs."),
        ("!has(object.spec.volumes) || object.spec.volumes.all(v, has(v.emptyDir) || has(v.configMap) || has(v.projected) || has(v.downwardAPI))",
         "Only ephemeral assessment volumes are allowed."),
        ("!has(object.spec.serviceAccountName) || object.spec.serviceAccountName in ['candidate', 'default']",
         "Only assessment service accounts are allowed."),
        ("(!has(object.spec.nodeName) || (request.operation == 'UPDATE' && has(oldObject.spec.nodeName) && object.spec.nodeName == oldObject.spec.nodeName)) && (!has(object.spec.nodeSelector) || (size(object.spec.nodeSelector) == 1 && 'uniqassess.com.node-restriction.kubernetes.io/sandbox' in object.spec.nodeSelector && object.spec.nodeSelector['uniqassess.com.node-restriction.kubernetes.io/sandbox'] == 'true')) && !has(object.spec.affinity) && (!has(object.spec.tolerations) || object.spec.tolerations.all(t, has(t.key) && t.key in ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'])) && (!has(object.spec.schedulerName) || object.spec.schedulerName == 'default-scheduler') && (!has(object.spec.priorityClassName) || object.spec.priorityClassName == '')",
         "Node placement and priority are controlled by the assessment operator."),
        ("object.spec.containers.all(c, has(c.securityContext) && has(c.securityContext.readOnlyRootFilesystem) && c.securityContext.readOnlyRootFilesystem) && (!has(object.spec.initContainers) || object.spec.initContainers.all(c, has(c.securityContext) && has(c.securityContext.readOnlyRootFilesystem) && c.securityContext.readOnlyRootFilesystem))",
         "Assessment containers require a read-only root filesystem."),
        ("!has(object.spec.terminationGracePeriodSeconds) || object.spec.terminationGracePeriodSeconds <= 30",
         "Pod termination must complete within the assessment cleanup window."),
    ]
    service_rules = [
        ("(!has(object.spec.type) || object.spec.type == 'ClusterIP') && (!has(object.spec.externalIPs) || size(object.spec.externalIPs) == 0) && (!has(object.spec.externalName) || object.spec.externalName == '')",
         "External services, NodePort, LoadBalancer and externalIPs are disabled."),
    ]
    cleanup_rules = [
        ("!has(object.metadata.finalizers) || size(object.metadata.finalizers) == 0",
         "Candidate-controlled finalizers are disabled so labs can expire reliably."),
    ]
    result = []
    for suffix, groups, resources, rules in [
        ("pods", [""], ["pods", "pods/ephemeralcontainers"], pod_rules),
        ("services", [""], ["services"], service_rules),
        ("cleanup", ["", "apps", "batch"], ["pods", "services", "configmaps", "deployments", "replicasets", "jobs"], cleanup_rules),
    ]:
        name = "uniqassess-lab-" + suffix + "-" + POLICY_VERSION
        result.append(resource("ValidatingAdmissionPolicy", name, {
            "failurePolicy": "Fail",
            "matchConstraints": {"namespaceSelector": selector, "resourceRules": [{
                "apiGroups": groups, "apiVersions": ["v1"], "operations": ["CREATE", "UPDATE"], "resources": resources,
            }]},
            "validations": [{"expression": expr, "message": message} for expr, message in rules],
        }, api="admissionregistration.k8s.io/v1"))
        result.append(resource("ValidatingAdmissionPolicyBinding", name, {
            "policyName": name, "validationActions": ["Deny"],
        }, api="admissionregistration.k8s.io/v1"))
    # Prevent a candidate from deleting/replacing the console or its credentials.
    name = "uniqassess-lab-workspace-" + POLICY_VERSION
    result.append(resource("ValidatingAdmissionPolicy", name, {
        "failurePolicy": "Fail",
        "matchConstraints": {"namespaceSelector": selector, "resourceRules": [{
            "apiGroups": [""], "apiVersions": ["v1"], "operations": ["CREATE", "UPDATE", "DELETE"], "resources": ["pods"],
        }]},
        "validations": [{
            "expression": "!(request.userInfo.username == 'system:serviceaccount:' + request.namespace + ':candidate' && request.name == 'workspace')",
            "message": "The assessment console is managed by the runner.",
        }],
    }, api="admissionregistration.k8s.io/v1"))
    result.append(resource("ValidatingAdmissionPolicyBinding", name, {
        "policyName": name, "validationActions": ["Deny"],
    }, api="admissionregistration.k8s.io/v1"))
    return result


def namespace_manifest(namespace, lab_id, expires_at, config):
    return resource("Namespace", namespace, metadata={"name": namespace, "labels": {
        MANAGED: "true", OWNER: config.owner,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "latest",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
    }, "annotations": {"labs.uniqassess.com/id": lab_id, "labs.uniqassess.com/expires-at": expires_at}})


def security_context():
    return {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}


def pod_spec(config, *, workspace=False):
    container = {
        "name": "workspace" if workspace else "checkout",
        "image": config.workspace_image, "imagePullPolicy": "IfNotPresent",
        "command": ["python", "/opt/lab/workspace.py"] if workspace else ["python", "/opt/lab/app.py"],
        "securityContext": security_context(),
        "resources": {"requests": {"cpu": "100m", "memory": "128Mi", "ephemeral-storage": "128Mi"},
                      "limits": {"cpu": "500m", "memory": "256Mi", "ephemeral-storage": "512Mi"}},
        "volumeMounts": [{"name": "workspace", "mountPath": "/workspace"}, {"name": "tmp", "mountPath": "/tmp"}],
        "env": [{"name": "HOME", "value": "/workspace"}, {"name": "PYTHONDONTWRITEBYTECODE", "value": "1"}],
        "workingDir": "/workspace",
    }
    if workspace:
        container["env"].append({"name": "KUBECONFIG", "value": "/tmp/kubeconfig"})
        container["readinessProbe"] = {"exec": {"command": ["test", "-s", "/tmp/kubeconfig"]}, "initialDelaySeconds": 1, "periodSeconds": 2}
    else:
        container["ports"] = [{"containerPort": 8080}]
        container["readinessProbe"] = {"httpGet": {"path": "/health", "port": 8081}, "periodSeconds": 3}
        container["livenessProbe"] = {"httpGet": {"path": "/health", "port": 8080}, "initialDelaySeconds": 5, "periodSeconds": 10}
    return {
        "runtimeClassName": config.runtime_class,
        "serviceAccountName": "candidate" if workspace else "default",
        "automountServiceAccountToken": workspace,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 10001, "runAsGroup": 10001, "fsGroup": 10001, "seccompProfile": {"type": "RuntimeDefault"}},
        "enableServiceLinks": False, "terminationGracePeriodSeconds": 2,
        "containers": [container],
        "volumes": [{"name": "workspace", "emptyDir": {"sizeLimit": "256Mi"}}, {"name": "tmp", "emptyDir": {"sizeLimit": "64Mi"}}],
    }


def lab_resources(namespace, config):
    def obj(kind, name, spec=None, api="v1", **extra):
        return resource(kind, name, spec, api, namespace, **extra)
    candidate_rules = [
        {"apiGroups": [""], "resources": ["pods", "services", "configmaps"], "verbs": ["get", "list", "watch", "create", "update", "patch", "delete"]},
        {"apiGroups": [""], "resources": ["pods/log", "events", "endpoints"], "verbs": ["get", "list", "watch"]},
        {"apiGroups": [""], "resources": ["pods/exec"], "verbs": ["create"]},
        {"apiGroups": ["apps"], "resources": ["deployments", "deployments/scale", "replicasets"], "verbs": ["get", "list", "watch", "create", "update", "patch", "delete"]},
        {"apiGroups": ["discovery.k8s.io"], "resources": ["endpointslices"], "verbs": ["get", "list", "watch"]},
    ]
    return [
        obj("ResourceQuota", "budget", {"hard": {
            "requests.cpu": "2", "limits.cpu": "4", "requests.memory": "2Gi", "limits.memory": "4Gi",
            "requests.ephemeral-storage": "2Gi", "limits.ephemeral-storage": "4Gi",
            "pods": "8", "services": "5", "configmaps": "10", "secrets": "0", "persistentvolumeclaims": "0",
            "services.loadbalancers": "0", "services.nodeports": "0",
            "count/deployments.apps": "5", "count/replicasets.apps": "10", "count/jobs.batch": "5",
        }}),
        obj("LimitRange", "container-budget", {"limits": [{"type": "Container",
            "defaultRequest": {"cpu": "100m", "memory": "128Mi", "ephemeral-storage": "128Mi"},
            "default": {"cpu": "500m", "memory": "256Mi", "ephemeral-storage": "512Mi"},
            "max": {"cpu": "1", "memory": "512Mi", "ephemeral-storage": "1Gi"},
        }]}),
        obj("NetworkPolicy", "isolation", {"podSelector": {}, "policyTypes": ["Ingress", "Egress"],
            "ingress": [{"from": [{"podSelector": {}}]}],
            "egress": [
                {"to": [{"podSelector": {}}]},
                {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]},
                {"to": [{"ipBlock": {"cidr": cidr}} for cidr in config.api_cidrs], "ports": [{"protocol": "TCP", "port": port} for port in config.api_ports]},
            ],
        }, "networking.k8s.io/v1"),
        obj("ServiceAccount", "candidate", automountServiceAccountToken=False),
        obj("Role", "candidate", api="rbac.authorization.k8s.io/v1", rules=candidate_rules),
        obj("RoleBinding", "candidate", api="rbac.authorization.k8s.io/v1",
            roleRef={"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "candidate"},
            subjects=[{"kind": "ServiceAccount", "name": "candidate", "namespace": namespace}]),
        obj("ConfigMap", "brief", data={"README.md": (Path(__file__).parent / "exercises" / TEMPLATE / "README.md").read_text(encoding="utf-8")}),
        obj("Pod", "workspace", pod_spec(config, workspace=True)),
        obj("Deployment", "checkout", {"replicas": 2, "revisionHistoryLimit": 2,
            "selector": {"matchLabels": {"app": "checkout"}},
            "template": {"metadata": {"labels": {"app": "checkout"}}, "spec": pod_spec(config)},
        }, "apps/v1"),
        obj("Service", "checkout", {"type": "ClusterIP", "selector": {"app": "checkout-previous"}, "ports": [{"port": 80, "targetPort": 8080}]}),
    ]


if __name__ == "__main__":
    from runner import Config
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["admission"])
    args = parser.parse_args()
    config = Config.from_env()
    print(json.dumps({"apiVersion": "v1", "kind": "List", "items": admission(config)}, indent=2))
