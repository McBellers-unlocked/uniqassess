#!/usr/bin/env bash
set -euo pipefail
cd /opt/uniqassess-bootstrap/source
REGISTRY=891612540396.dkr.ecr.eu-west-1.amazonaws.com
TAG="pilot-$(date -u +%Y%m%d%H%M%S)"
export REGISTRY TAG
python3 - <<'PY'
import boto3,base64,subprocess,os
auth=boto3.client('ecr',region_name='eu-west-1').get_authorization_token()['authorizationData'][0]
user,password=base64.b64decode(auth['authorizationToken']).decode().split(':',1)
subprocess.run(['docker','login','--username',user,'--password-stdin',os.environ['REGISTRY']],input=password,text=True,check=True,stdout=subprocess.DEVNULL)
PY
cache_flags=(--no-cache)
for image in workspace broker; do
  file=lab-runner/Dockerfile
  if [ "$image" = workspace ]; then file=lab-runner/workspace/Dockerfile; fi
  ref="$REGISTRY/uniqassess-labs/$image:$TAG"
  if ! docker build --pull "${cache_flags[@]}" --build-arg KUBECTL_VERSION=v1.36.4 -f "$file" -t "$ref" lab-runner > "/opt/uniqassess-bootstrap/build-$image.log" 2>&1; then
    tail -80 "/opt/uniqassess-bootstrap/build-$image.log"
    exit 1
  fi
  docker push "$ref" > "/opt/uniqassess-bootstrap/push-$image.log" 2>&1
  # The broker may reuse the tools stage freshly rebuilt in this invocation.
  cache_flags=()
done
python3 - <<'PY'
import subprocess,json,os,boto3,base64
images={}
auth=boto3.client('ecr',region_name='eu-west-1').get_authorization_token()['authorizationData'][0]
credential=base64.b64decode(auth['authorizationToken']).decode()
for name in ['workspace','broker']:
    tag=f"{os.environ['REGISTRY']}/uniqassess-labs/{name}:{os.environ['TAG']}"
    data=json.loads(subprocess.check_output(['docker','image','inspect',tag]))[0]
    images[name]=data['RepoDigests'][0]
    images[name+'Tag']=tag
    # Pull the exact registry manifest, then transfer an OCI archive. A Docker
    # archive may reserialize a manifest and should not be relabelled as its digest.
    result=subprocess.run(['ctr','-n','k8s.io','images','pull','--user',credential,images[name]],capture_output=True,text=True)
    if result.returncode:raise SystemExit('Import of registry digest failed for '+name)
    subprocess.run(['ctr','-n','k8s.io','images','export',f'/opt/uniqassess-bootstrap/{name}.tar',images[name]],check=True)
with open('/opt/uniqassess-bootstrap/images.json','w') as f:json.dump(images,f)
print(json.dumps(images))
PY
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
SSH=(ssh -i /opt/uniqassess-bootstrap/worker-key -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/opt/uniqassess-bootstrap/known-hosts ubuntu@10.88.0.20)
cat /opt/uniqassess-bootstrap/workspace.tar | "${SSH[@]}" 'sudo ctr -n k8s.io images import -'
docker logout "$REGISTRY" >/dev/null
printf 'Digest-pinned images loaded without granting worker registry credentials.\n'
