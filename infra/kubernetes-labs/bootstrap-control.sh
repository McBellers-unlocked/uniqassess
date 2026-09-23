#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/bootstrap-common.sh"
install_host_requirements
install_network_guard
install_k3s_binary
umask 077
test -s /etc/rancher/k3s/agent-token || openssl rand -hex 32 > /etc/rancher/k3s/agent-token
cat > /etc/rancher/k3s/pod-security.yaml <<'EOF'
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
  - name: PodSecurity
    configuration:
      apiVersion: pod-security.admission.config.k8s.io/v1
      kind: PodSecurityConfiguration
      defaults:
        enforce: restricted
        enforce-version: latest
        audit: restricted
        audit-version: latest
        warn: restricted
        warn-version: latest
      exemptions:
        usernames: []
        runtimeClasses: []
        namespaces: [kube-system]
EOF
cat > /etc/rancher/k3s/audit-policy.yaml <<'EOF'
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: Metadata
omitStages: [RequestReceived]
EOF
cat > /etc/rancher/k3s/config.yaml <<EOF
node-name: lab-control
node-ip: $CONTROL_IP
advertise-address: $CONTROL_IP
bind-address: 0.0.0.0
tls-san:
  - $CONTROL_IP
cluster-cidr: $POD_CIDR
service-cidr: $SERVICE_CIDR
cluster-dns: 10.43.0.10
flannel-backend: vxlan
disable:
  - traefik
  - servicelb
  - local-storage
  - metrics-server
secrets-encryption: true
write-kubeconfig-mode: "0600"
agent-token-file: /etc/rancher/k3s/agent-token
node-taint:
  - uniqassess.com/management=true:NoSchedule
kube-apiserver-arg:
  - authorization-mode=Node,RBAC
  - anonymous-auth=false
  - enable-admission-plugins=NodeRestriction,PodSecurity
  - admission-control-config-file=/etc/rancher/k3s/pod-security.yaml
  - audit-policy-file=/etc/rancher/k3s/audit-policy.yaml
  - audit-log-path=/var/lib/rancher/k3s/server/logs/audit.log
  - audit-log-maxage=7
  - audit-log-maxbackup=2
  - audit-log-maxsize=50
kubelet-arg:
  - pod-max-pids=256
  - max-pods=20
  - system-reserved=cpu=200m,memory=256Mi
  - kube-reserved=cpu=200m,memory=512Mi
  - eviction-hard=memory.available<256Mi,nodefs.available<10%,imagefs.available<15%
  - anonymous-auth=false
  - authorization-mode=Webhook
  - read-only-port=0
  - streaming-connection-idle-timeout=5m
EOF
install_k3s_service server k3s
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl wait --for=create node/lab-control --timeout=180s
kubectl wait --for=condition=Ready node/lab-control --timeout=180s
kubectl label node lab-control uniqassess.com.node-restriction.kubernetes.io/management=true --overwrite
# K3s rewrites packaged manifests at each start. A .skip file keeps later starts
# from re-applying the original placement/upstream DNS over this reviewed config.
for attempt in $(seq 1 60); do
  kubectl -n kube-system get deployment coredns >/dev/null 2>&1 && break
  sleep 2
done
kubectl -n kube-system get deployment coredns >/dev/null
touch /var/lib/rancher/k3s/server/manifests/coredns.yaml.skip
# CoreDNS stays on the trusted node; remove upstream DNS forwarding to avoid
# arbitrary external DNS queries from candidate code. Hosts still resolve normally.
kubectl -n kube-system patch deployment coredns --type=merge -p '{"spec":{"template":{"spec":{"nodeSelector":{"uniqassess.com.node-restriction.kubernetes.io/management":"true"},"tolerations":[{"key":"uniqassess.com/management","operator":"Equal","value":"true","effect":"NoSchedule"}]}}}}'
kubectl -n kube-system get configmap coredns -o json | python3 -c 'import json,sys; d=json.load(sys.stdin); d["data"]["Corefile"]="\n".join(line for line in d["data"]["Corefile"].splitlines() if not line.strip().startswith("forward "))+"\n"; print(json.dumps(d))' | kubectl apply -f -
kubectl -n kube-system rollout restart deployment coredns
kubectl -n kube-system rollout status deployment coredns --timeout=180s
printf 'Control installed. No candidate lab or verification flag has been enabled.\n'
