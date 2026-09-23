#!/usr/bin/env bash
# Run on the trusted control host after bootstrap-control.sh. Paths contain no
# secrets; never inline the SSH private key or K3s token into remote commands.
set -euo pipefail
test "$(id -u)" = 0
test "$#" = 2 || { echo 'Usage: join-worker.sh PRIVATE_KEY_PATH VERIFIED_KNOWN_HOSTS_PATH' >&2; exit 2; }
private_key=$1
known_hosts=$2
test -s "$private_key"
test -s "$known_hosts"
test "$(stat -c '%a:%U' "$private_key")" = 600:root
here=$(cd "$(dirname "$0")" && pwd)
ssh_options=(-i "$private_key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known_hosts" -o ConnectTimeout=10)
remote=ubuntu@10.88.0.20
ssh "${ssh_options[@]}" "$remote" 'sudo cloud-init status --wait; sudo test -f /opt/uniqassess-bootstrap/cloud-init-ready; mkdir -p /home/ubuntu/uniqassess-bootstrap'
scp "${ssh_options[@]}" "$here/bootstrap-common.sh" "$here/bootstrap-worker.sh" "$remote:/home/ubuntu/uniqassess-bootstrap/"
ssh "${ssh_options[@]}" "$remote" 'sudo install -d -m 0755 /etc/rancher/k3s; sudo install -m 0600 -o root -g root /dev/stdin /etc/rancher/k3s/join-token' < /var/lib/rancher/k3s/server/agent-token
ssh "${ssh_options[@]}" "$remote" 'sudo bash /home/ubuntu/uniqassess-bootstrap/bootstrap-worker.sh'
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl wait --for=create node/lab-sandbox --timeout=300s
kubectl wait --for=condition=Ready node/lab-sandbox --timeout=300s
printf 'Worker joined. Do not label it or start candidate pods before disabling EC2 metadata.\n'
