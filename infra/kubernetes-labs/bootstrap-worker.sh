#!/usr/bin/env bash
# Before executing, deliver the control's agent-token over authenticated SSH to
# /etc/rancher/k3s/join-token (root:root 0600). Never use user-data or SSM arguments.
set -euo pipefail
source "$(dirname "$0")/bootstrap-common.sh"
test -s /etc/rancher/k3s/join-token
test "$(stat -c '%a:%U' /etc/rancher/k3s/join-token)" = 600:root
install_host_requirements
install_network_guard
curl -fsSL --retry 4 https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
printf 'deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n' > /etc/apt/sources.list.d/gvisor.list
apt-get update
apt-get install -y runsc
# Pin the resolved official release for this host; upgrades require another pilot.
apt-mark hold runsc
dpkg-query -W runsc > /opt/uniqassess-bootstrap/gvisor-version.txt
command -v runsc
command -v containerd-shim-runsc-v1
install -d -m 0755 /etc/containerd
cat > /etc/containerd/runsc.toml <<'EOF'
[runsc_config]
  platform = "systrap"
EOF
cat > /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl <<'EOF'
{{ template "base" . }}
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc.options]
  TypeUrl = "io.containerd.runsc.v1.options"
  ConfigPath = "/etc/containerd/runsc.toml"
EOF
install_k3s_binary
umask 077
cat > /etc/rancher/k3s/config.yaml <<EOF
server: https://$CONTROL_IP:6443
token-file: /etc/rancher/k3s/join-token
node-name: lab-sandbox
node-ip: $WORKER_IP
# Protected sandbox label is deliberately absent. Only the administrator sets it.
kubelet-arg:
  - pod-max-pids=256
  - max-pods=24
  - system-reserved=cpu=200m,memory=384Mi
  - kube-reserved=cpu=200m,memory=384Mi
  - eviction-hard=memory.available<512Mi,nodefs.available<10%,imagefs.available<15%
  - anonymous-auth=false
  - authorization-mode=Webhook
  - read-only-port=0
  - streaming-connection-idle-timeout=5m
EOF
install_k3s_service agent k3s-agent
printf 'Worker installed. Disable its EC2 metadata endpoint before any candidate pods.\n'
