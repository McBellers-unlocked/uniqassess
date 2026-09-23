#!/usr/bin/env bash
# Run via Systems Manager on the dedicated control host, after unpacking source.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
test -f /opt/uniqassess-bootstrap/cloud-init-ready
ROOT=/opt/uniqassess-bootstrap/source
cd "$ROOT"
apt-get update
apt-get install -y python3-boto3 docker.io nginx certbot
systemctl enable --now docker
python3 - <<'PY'
import boto3,json,os
s=boto3.client('secretsmanager',region_name='eu-west-1')
key=json.loads(s.get_secret_value(SecretId='uniqassess/labs/pilot/bootstrap')['SecretString'])['privateKey']
p='/opt/uniqassess-bootstrap/worker-key'
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:f.write(key)
PY
SSH=(ssh -i /opt/uniqassess-bootstrap/worker-key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/opt/uniqassess-bootstrap/known-hosts ubuntu@10.88.0.20)
"${SSH[@]}" 'sudo test -f /opt/uniqassess-bootstrap/cloud-init-ready'
bash infra/kubernetes-labs/bootstrap-control.sh
# Deliver only the agent join token to the worker. It never receives a server
# token, broker credential, cloud credential or production application secret.
"${SSH[@]}" 'sudo install -d -m 0700 /etc/rancher/k3s; sudo sh -c "umask 077; cat > /etc/rancher/k3s/join-token"' < /var/lib/rancher/k3s/server/agent-token
tar -czf - infra/kubernetes-labs/bootstrap-common.sh infra/kubernetes-labs/bootstrap-worker.sh | "${SSH[@]}" 'sudo tar -xzf - -C /opt/uniqassess-bootstrap'
"${SSH[@]}" 'sudo bash /opt/uniqassess-bootstrap/infra/kubernetes-labs/bootstrap-worker.sh'
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl wait --for=create node/lab-sandbox --timeout=180s
kubectl wait --for=condition=Ready node/lab-sandbox --timeout=180s
kubectl label node lab-sandbox uniqassess.com.node-restriction.kubernetes.io/sandbox=true --overwrite
kubectl apply -f infra/kubernetes-labs/runtime-class.yaml
kubectl get nodes -o wide
printf 'Hosts joined. Disable worker metadata before isolation test pods.\n'
