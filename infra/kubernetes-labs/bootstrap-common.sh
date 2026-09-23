#!/usr/bin/env bash
# Source as root. No credentials are logged; do not enable shell tracing.
set -euo pipefail
test "$(id -u)" = 0
export DEBIAN_FRONTEND=noninteractive
K3S_VERSION='v1.36.4+k3s1'
CONTROL_IP='10.88.0.10'
WORKER_IP='10.88.0.20'
POD_CIDR='10.42.0.0/16'
SERVICE_CIDR='10.43.0.0/16'

install_host_requirements() {
  apt-get update
  apt-get install -y ca-certificates curl jq python3 nftables openssl gnupg conntrack socat
  swapoff -a
  modprobe br_netfilter
  modprobe overlay
  printf 'br_netfilter\noverlay\n' > /etc/modules-load.d/uniqassess.conf
  cat > /etc/sysctl.d/90-uniqassess.conf <<'EOF'
net.ipv4.ip_forward=1
net.bridge.bridge-nf-call-iptables=1
net.bridge.bridge-nf-call-ip6tables=1
net.ipv6.conf.all.disable_ipv6=1
net.ipv6.conf.default.disable_ipv6=1
EOF
  sysctl --system >/dev/null
  install -d -m 0755 /etc/rancher/k3s /var/lib/rancher/k3s/agent/etc/containerd
}

install_k3s_binary() {
  local tmp
  tmp=$(mktemp -d)
  curl -fL --retry 4 "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION}/k3s" -o "$tmp/k3s"
  curl -fL --retry 4 "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION}/sha256sum-amd64.txt" -o "$tmp/checksums"
  (cd "$tmp"; awk '$2 == "k3s" { print }' checksums > selected; test -s selected; sha256sum -c selected)
  install -m 0755 "$tmp/k3s" /usr/local/bin/k3s
  rm -f "$tmp/k3s" "$tmp/checksums" "$tmp/selected"
  rmdir "$tmp"
  ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl
  ln -sf /usr/local/bin/k3s /usr/local/bin/crictl
  ln -sf /usr/local/bin/k3s /usr/local/bin/ctr
}

install_network_guard() {
  # Runs after DNAT and before kube-router's iptables filter hooks. Returning here
  # does not bypass those hooks. All pod->pod isolation remains with NetworkPolicy.
  # Apply equally on BOTH hosts: Flannel encapsulates cross-node pod traffic.
  cat > /etc/uniqassess-network-guard.nft <<EOF
table inet uniqassess_guard {
  chain input {
    type filter hook input priority -10; policy accept;
    ip saddr $POD_CIDR ct state established,related return
    ip saddr $POD_CIDR ip daddr $CONTROL_IP tcp dport 6443 return
    ip saddr $POD_CIDR counter drop
    iifname "cni0" meta nfproto ipv6 counter drop
    iifname "flannel.1" meta nfproto ipv6 counter drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    ip saddr $POD_CIDR ct state established,related return
    ip saddr $POD_CIDR ip daddr $POD_CIDR return
    ip saddr $POD_CIDR ip daddr $CONTROL_IP tcp dport 6443 return
    ip saddr $POD_CIDR counter drop
    iifname "cni0" meta nfproto ipv6 counter drop
    iifname "flannel.1" meta nfproto ipv6 counter drop
  }
}
EOF
  cat > /usr/local/sbin/uniqassess-network-guard <<'EOF'
#!/bin/bash
set -euo pipefail
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT
if nft list table inet uniqassess_guard >/dev/null 2>&1; then
  printf 'delete table inet uniqassess_guard\n' > "$rules"
fi
cat /etc/uniqassess-network-guard.nft >> "$rules"
# Replacement is one atomic nft transaction; never flush the cluster ruleset.
nft --check --file "$rules"
nft --file "$rules"
EOF
  chmod 0755 /usr/local/sbin/uniqassess-network-guard
  cat > /etc/systemd/system/uniqassess-network-guard.service <<'EOF'
[Unit]
Description=UNIQassess pod to host and external network isolation
Before=k3s.service k3s-agent.service
After=network-pre.target
Wants=network-pre.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/uniqassess-network-guard
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now uniqassess-network-guard.service
  /usr/local/sbin/uniqassess-network-guard
}

install_k3s_service() {
  local mode=$1 service=$2
  cat > "/etc/systemd/system/$service.service" <<EOF
[Unit]
Description=UNIQassess dedicated K3s $mode
Wants=network-online.target
After=network-online.target uniqassess-network-guard.service
Requires=uniqassess-network-guard.service
[Service]
Type=notify
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/local/bin/k3s $mode --config /etc/rancher/k3s/config.yaml
KillMode=process
Delegate=yes
LimitNOFILE=1048576
LimitNPROC=infinity
TasksMax=infinity
Restart=always
RestartSec=5s
TimeoutStartSec=300
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$service"
}
