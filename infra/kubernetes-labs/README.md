# Isolated AWS Kubernetes pilot

These assets create an assessment-only project in AWS account `891612540396`,
region `eu-west-1`. They do not constitute a separate AWS account. The new VPC has
no peering, transit gateway, VPN, production routes or production credentials.
The candidate worker has no IAM role. Production database reconciliation belongs
on trusted application infrastructure outside this VPC.

This is a disposable, single-control-node pilot. Begin with at most **two labs**
concurrently. Availability, durable backups, autoscaling and measured capacity
must be reviewed before general candidate use. Instance compute, two public IPv4
addresses, EBS, storage and data transfer are chargeable while provisioned.

## Files and fixed addresses

| File | Purpose |
| --- | --- |
| `pilot.cloudformation.json` | VPC, subnet, independent security groups, EC2 instances, encrypted disks, bootstrap bucket and restricted control IAM role |
| `bootstrap-common.sh` | Pinned K3s binary, prerequisites and persistent host network guard |
| `bootstrap-control.sh` | Control plane, API authorization, restricted Pod Security, node limits and internal-only CoreDNS |
| `bootstrap-worker.sh` | Official gVisor package, systrap runtime and K3s agent |
| `join-worker.sh` | Transfers the join token over authenticated SSH, then starts the worker |
| `runtime-class.yaml` | Requires candidate placement on the protected sandbox label |
| `management-placement.yaml` | Independently enforces trusted-control pod placement |
| `verify-isolation.py` | Live two-candidate RBAC, admission, networking, repair and cleanup checks |

The VPC is `10.88.0.0/16`; the subnet is `10.88.0.0/24`. Control is
`10.88.0.10`, worker is `10.88.0.20`, pods use `10.42.0.0/16`, services use
`10.43.0.0/16`, and the Kubernetes service is `10.43.0.1:443`.
The control's API also uses `10.88.0.10:6443`.

The template exposes TCP 443 for the authenticated HTTPS broker and TCP 80 for
ACME issuance/renewal. Configure the HTTP listener to serve only ACME challenges
and/or redirect to HTTPS; never proxy broker operations over HTTP. It exposes no
public SSH, kubelet or Kubernetes API. Worker SSH is reachable only from the
control security group. Node-to-node VXLAN UDP 8472 is limited to those groups.

Public host addresses allow OS and image pulls without a NAT gateway; they do
not grant candidate pod egress. Host nftables guards deny pod-originated
connections to node services, metadata, private networks and the internet. Only
pod destinations and the exact control API may continue to the CNI policy
checks. Namespace NetworkPolicies additionally allow only same-namespace pods,
CoreDNS TCP/UDP 53 and exact API endpoints. Existing connections are allowed for
return traffic, including kubelet probes. The guard uses a distinct nftables
table and never flushes K3s rules.

## Operator sequence

Confirm the AWS identity/region, review a change set and cost estimate, then
create the stack with `CAPABILITY_IAM`. Supply `WorkerKeyName` with a dedicated
ephemeral key. The template uses the official Ubuntu 24.04 amd64 gp3 image SSM
parameter. K3s is pinned to `v1.36.4+k3s1`, the official stable channel observed
on 23 September 2026; use kubectl `v1.36.4` for the images. The downloaded K3s
binary is validated against its release SHA-256 checksum.

`WorkerMetadataEndpoint=enabled` is a **bootstrap-only** state. Ubuntu cloud-init
must initially read IMDS to obtain its user-data and SSH public key. It requires
IMDSv2, disables IPv6 metadata, has a hop limit of one and has no IAM profile.
After cloud-init and joining, update the stack parameter to `disabled` and verify
the EC2 endpoint is disabled before creating any candidate pod. A replacement
worker requires this same staged process. Never enable candidate admission while
the worker bootstrap state remains enabled.

Upload only bootstrap artifacts to the output bucket under `bootstrap/`. The
control IAM role has read-only access to that prefix and SSM agent channels; it
cannot read Secrets Manager or Parameter Store values. If an ephemeral SSH key
is delivered using a temporary scoped secret permission, remove that permission
and key after provisioning. Never put secrets in user-data, stack parameters,
command arguments, SSM command text, logs or committed files.

Use SSM to operate the control. Wait for `cloud-init status --wait` and
`/opt/uniqassess-bootstrap/cloud-init-ready`. Copy this directory and
`lab-runner/` preserving their repository-relative paths. On the control, as
root, run:

```sh
bash infra/kubernetes-labs/bootstrap-control.sh
```

Verify the worker's SSH host key against AWS console output or another trusted
operator channel, then create a root-owned known-hosts file. Do not rely on an
unverified `ssh-keyscan` result. Deliver the ephemeral private key to a root-owned
`0600` file, and run:

```sh
bash infra/kubernetes-labs/join-worker.sh /root/pilot-bootstrap-key /root/pilot-known-hosts
```

The helper transfers the control's **agent-only** join token directly over SSH
stdin into a worker root-owned `0600` file. It never prints the token. The agent
token remains on the worker for rejoining; it is not the control/server token.
The worker installs gVisor from its official signed apt repository and records
the installed version in `/opt/uniqassess-bootstrap/gvisor-version.txt`.
That package is held; a package upgrade requires repeat validation. Its
containerd v3 template extends K3s's base configuration and selects real
`io.containerd.runsc.v1` with `platform=systrap`.

Now disable the worker metadata endpoint through the stack update, verify it
from EC2, and only then label the node and apply the RuntimeClass:

```sh
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl label node lab-sandbox uniqassess.com.node-restriction.kubernetes.io/sandbox=true --overwrite
kubectl apply -f infra/kubernetes-labs/runtime-class.yaml
kubectl apply -f infra/kubernetes-labs/management-placement.yaml
kubectl apply -f lab-runner/operator-rbac.yaml
```

Control/runner/cronjob pods must select
`uniqassess.com.node-restriction.kubernetes.io/management: "true"` and tolerate
`uniqassess.com/management=true:NoSchedule`. The control bootstrap sets that
protected label using the administrator identity. The worker cannot label itself
as isolated: the API enables Node authorization and NodeRestriction. CoreDNS is
pinned to the control and has no upstream forwarder; internal cluster resolution
still works. `coredns.yaml.skip` prevents a K3s restart from restoring the default
CoreDNS placement/forwarder. Review this deliberate override on every upgrade.

Build and digest-pin the workspace and runner images per `lab-runner/README.md`.
Cache/import the workspace image onto the worker using an operator transfer; do
not give the worker an ECR/cloud role or mount registry secrets into candidate
namespaces. Deploy the broker with its rotating projected service-account token,
persistent journal storage on the control, and a host HTTPS reverse proxy.

## Live isolation evidence before enabling the runner

The operator script does not require or modify any verification flag. Set
`LAB_WORKSPACE_IMAGE`, `LAB_CLUSTER_UID` and `KUBECONFIG` to the actual deployment
values, then run from the copied repository on the control:

```sh
export LAB_API_CIDRS=10.43.0.1/32,10.88.0.10/32
python3 infra/kubernetes-labs/verify-isolation.py --install-admission > /root/isolation-evidence.jsonl
```

It requires a matching cluster fingerprint and uses the runner's actual fixture
manifests. `--install-admission` explicitly installs those exact policies; omit
it on subsequent runs. It verifies two separate workspaces, policy type checks,
API/RBAC permissions, candidate denial of unsafe resources and workspace
deletion, internal DNS, disabled external DNS forwarding, exercise repair,
same-namespace HTTP and blocked cross-namespace/node/metadata/internet traffic.
The script proves cross-namespace HTTP and selected host targets are live before
checking access denial. JSON includes each assertion and namespace cleanup;
any failure exits nonzero. It deletes only its own namespaces after checking
their UIDs, labels and ownership annotations.

Separately capture the worker's actual `runsc`/systrap process while a pod is
running, containerd runtime configuration, host nftables rules/counters on both
nodes, kubelet process limits/reservations, EC2 metadata-disabled state and absent
worker IAM profile. These are explicit remaining operator checks in the script
report; the script cannot attest cloud/host state by looking at RuntimeClass.
Test node restart and policy persistence, expiry, submission lockout, lost
responses, broker restart, janitor cleanup and browser evidence flow using the
main deployment runbook. Set verification flags only after the corresponding
observed checks pass. Synthetic test success alone is not sufficient.

No candidate workload, cloud access key or production database secret is part of
this bootstrap. Application reconciliation stays outside the lab VPC. The broker
secret belongs only in trusted application/server configuration and the broker.

## Disposal and operational limits

Drain labs and retain assessment evidence in the application before deleting the
stack. Instance volumes are encrypted gp3 and delete on termination. The bootstrap
bucket is deliberately retained and expires objects after seven days; explicitly
review and remove that retained bucket, ephemeral key pair, temporary secret,
image repositories and DNS records when retiring the pilot. EBS and elastic IP
charges continue until the relevant resources are removed. Instances use
**standard** CPU credits to prevent unlimited-credit charges; monitor throttling
before interpreting performance assessments.

The nftables guard and CNI behavior require a new live check after runtime,
Kubernetes, image, node, network or admission changes. This pilot is an assessment
workload sandbox, not cluster-admin access, an AWS credentials lab, or a claim of
complete protection against unknown hypervisor/runtime/kernel vulnerabilities.

## Primary references checked

- [K3s stable channel](https://update.k3s.io/v1-release/channels)
- [K3s containerd v3 templates](https://docs.k3s.io/advanced#configuring-containerd)
- [K3s hardening](https://docs.k3s.io/security/hardening-guide)
- [K3s packaged component overrides](https://docs.k3s.io/installation/packaged-components)
- [gVisor signed apt installation](https://gvisor.dev/docs/user_guide/install/)
- [gVisor containerd runtime options](https://gvisor.dev/docs/user_guide/containerd/configuration/)
