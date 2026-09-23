# Kubernetes assessment runner: pilot implementation

This service provisions a real Kubernetes troubleshooting exercise and runs a
candidate's commands inside its console pod. It is a separate deployment from
UNIQassess. No candidate command is run by a shell on the application or broker
host. The application must authenticate/authorize each candidate, bind each lab to
one assessment attempt, and call this broker over a private TLS connection. The
broker accepts a server API key; it is not a browser-facing endpoint.

The implementation and tests are ready for infrastructure integration. No cluster
has been created, deployed to, or live-tested by this change. Do not enable this for
real candidates until the complete smoke/security checks below pass on your own
assessment cluster. The Python unit tests do not demonstrate runtime isolation or
correct behavior of a particular CNI/admission installation.

## What candidates get

`kubernetes-troubleshooting-v1` is a real two-replica checkout deployment with a
broken readiness probe and service selector. Candidates inspect cluster objects,
events and logs, edit/apply manifests, patch resources, and verify HTTP recovery.
The workspace contains `kubectl`, `curl`, Python, a POSIX shell and ordinary Linux
utilities. Files persist in `/workspace` for the life of the console pod; this is
ephemeral storage, not a backed-up development environment. Each batch starts a
new shell in `/workspace`. No interactive TTY, cloud console, package downloads or
SSH access is provided. Read [the candidate brief](exercises/kubernetes-troubleshooting-v1/README.md)
and [the separate assessor notes](exercises/kubernetes-troubleshooting-v1/assessor.md).

One command runs per lab, with at most 100 commands and 8,000 characters per
command. Output is drained while retaining up to 32,768 bytes per stream (therefore
no more than 32,768 characters). A remote timeout fires after 19 seconds and the
broker deadline is 20 seconds; a timed-out lab is retired and its namespace
deleted. This avoids treating a disconnected `kubectl exec` stream as proof that
remote code stopped. Candidates should use short `curl`/`rollout` timeouts.
Background processes and candidate-created workloads can run until the lab ends;
the command count/time limit is not a security boundary for those processes.

## Required deployment boundary

Use a **dedicated, disposable assessment cluster and cloud account/project**, with
no production workloads, production credentials, organizational data, peering to
production networks, or workload identity roles. A Kubernetes namespace alone is
not a boundary for hostile code. The broker is a trusted privileged service and
must run outside candidate worker nodes. Treat its kubeconfig as an administrative
secret, even with the restricted operator role supplied here.

Before setting the three verification flags to `true`, the operator must establish:

1. A currently supported Kubernetes release with `ValidatingAdmissionPolicy`
   (GA since 1.30), Pod Security Admission, and an enforcing NetworkPolicy CNI.
   Pin a tested kubectl patch within the supported skew of the cluster. Disable
   anonymous API access and all unneeded aggregated APIs/admission integrations.
2. Installed and tested gVisor (`runsc`) or Kata (`kata...`) worker runtime. Create
   the RuntimeClass named by `LAB_RUNTIME_CLASS` with the exact configured handler
   and `scheduling.nodeSelector` shown below. Do not merely create a RuntimeClass
   object pointing to a normal shared-kernel container runtime.
3. Dedicated sandbox workers carrying the protected label below. Enable the
   NodeRestriction admission plugin and Node authorizer so kubelets cannot set
   this isolation label themselves. Keep broker/control workloads off these
   workers; enforce management-node placement independently. Nodes require
   `podPidsLimit`, CPU/memory/storage limits, node reservations and alerts so a fork
   bomb cannot exhaust the host. NetworkPolicy does not by itself cover every
   host/node path: use CNI host policies/firewalls to block node services, kubelet,
   instance metadata, private networks and internet access except approved API/DNS.
4. No node/workload cloud permissions available to candidates. Block cloud
   metadata (including provider-specific IPv4/IPv6 endpoints). Harden core DNS;
   DNS queries are permitted and could carry data, so there must be no sensitive
   data inside a lab. This v1 deliberately has no AWS credentials.
5. Verified networking for the actual CNI: only same-namespace traffic, kube-dns
   TCP/UDP 53 and the configured API endpoint `/32` or `/128` addresses/ports.
   API service NAT behavior differs by CNI: include the service VIP and actual
   post-NAT control-plane destinations as appropriate. Broad subnet allowances,
   link-local addresses, wildcard ports and internet defaults are rejected.
   NodeLocal DNS needs a reviewed policy adaptation; the included policy assumes
   kube-dns/CoreDNS pods labeled `k8s-app: kube-dns` in `kube-system`.

Example RuntimeClass, **only after installing its runtime on the selected nodes**:

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: assessment-sandbox
handler: runsc
scheduling:
  nodeSelector:
    uniqassess.com.node-restriction.kubernetes.io/sandbox: "true"
```

The generated admission policies require this runtime for every candidate pod,
approved digest-pinned images, read-only root filesystems, bounded pod termination,
and allowed ephemeral volume types. They deny external services, arbitrary node
placement, ephemeral containers and custom finalizers. The console pod is
protected from candidate API mutations. Restricted Pod Security is enforced on
each namespace. RBAC gives only namespace workload operations: no namespaces,
nodes, secrets, RBAC, service accounts, network policies, quota changes, storage,
custom resources, Jobs or cloud access. Quotas cap pods/objects and CPU, memory and
ephemeral storage. The runner checks the cluster fingerprint, runtime and exact
policy definitions/type-check results before every new lab; drift fails closed.

## Build and install

Run the following on an authorized operator machine for the assessment cluster.
These instructions create real infrastructure resources when executed; nothing in
the app automatically creates a cluster or purchases cloud capacity.

1. Fill a deployment environment file from `.env.example`. Generate a random
   32-byte-or-longer API key; store it in a secret manager, not in source control.
   Obtain the cluster fingerprint with
   `kubectl get namespace kube-system -o jsonpath='{.metadata.uid}'`.
2. Build both images with a tested **explicit** kubectl patch version:

   ```sh
   docker build -f lab-runner/workspace/Dockerfile --build-arg KUBECTL_VERSION="$KUBECTL_VERSION" -t "$WORKSPACE_TAG" lab-runner
   docker build -f lab-runner/Dockerfile --build-arg KUBECTL_VERSION="$KUBECTL_VERSION" -t "$BROKER_TAG" lab-runner
   ```

   Push to your approved registry, scan both images, record their immutable
   digests, and configure `LAB_WORKSPACE_IMAGE` using `repository@sha256:...`.
   Mirror/cache that image on worker nodes. Bake any required pull access into
   node configuration; do not put registry/cloud credentials in lab namespaces.
   Pin and regularly rebuild base images through your normal image maintenance.
3. Install `operator-rbac.yaml` using the operator identity. It provides distinct
   broker and janitor identities. The broker role is privileged across the
   dedicated cluster's namespaces; it is intentionally not a role for a shared
   production cluster. Use short-lived, rotating projected service-account
   credentials (or your existing identity broker) in the broker kubeconfig.
   Never mount the broker kubeconfig or API key into the workspace image/pod.
4. Export the reviewed deployment settings on the operator machine and render the
   versioned admission resources. `manifests.py` requires the same validated
   configuration as the broker. Install and inspect them:

   ```sh
   python lab-runner/manifests.py admission > admission.json
   kubectl apply -f admission.json
   kubectl get validatingadmissionpolicy uniqassess-lab-pods-v1 -o yaml
   ```

   Wait for `status.typeChecking` with no `expressionWarnings`; repeat for the
   `services`, `cleanup` and `workspace` policies. The broker rejects any added
   exclusion/match condition or changed validation/binding. Updating versions
   requires coordinated policy/image/broker rollout. Never weaken a policy just
   to make a smoke test pass.
5. Run **one** broker process with `/data` on durable local storage owned by UID
   10001, a read-only kubeconfig mount, and a private TLS reverse proxy. Set
   `LAB_LISTEN=0.0.0.0` only when container/private networking requires it. Apply
   connection/request rate limits at that proxy. There are no public endpoints or
   CORS allowances. Python's standard HTTP server is not intended as a public
   ingress. SQLite and a host file lock support one broker instance, not horizontal
   replicas or SQLite on an unreliable shared filesystem.
6. Install the independent `janitor-cronjob.yaml` after replacing its three
   `REPLACE_*` values. Its separate identity only lists/reads/deletes namespaces.
   Keep it off candidate workers. It checks the cluster UID, owner labels, lab ID,
   expiry and namespace UID before deleting. It runs every minute so expired labs
   are removed even when the broker is down. A control-plane outage still prevents
   cleanup: alert on missed janitor runs and long-running namespace termination.
7. Complete all checks below, then configure the UNIQassess server with the private
   runner URL/key and enable its lab feature flag. Provisioning a cluster, publishing
   containers and enabling the feature are separate operator deployment steps.

## API contract

All requests require `Authorization: Bearer <LAB_RUNNER_API_KEY>`. JSON responses
use `Cache-Control: no-store`. The broker does not accept user-supplied namespaces,
images, templates, kubectl arguments or kubeconfigs. Lab IDs match
`^[a-z][a-z0-9]{19,39}$`; the app generates them. Commands use canonical UUIDs.

| Request | Behavior |
| --- | --- |
| `PUT /v1/labs/{id}` with `{templateId, expiresAt}` | Idempotent asynchronous provision. Only `kubernetes-troubleshooting-v1`; fixed expiry must be in the future and within 120 minutes. Retry the same ID and exact configuration. |
| `GET /v1/labs/{id}` | `{id, status, expiresAt, cleanupComplete, error?, snapshot?}`; status is `starting`, `ready`, `failed`, `stopped` or `expired`. |
| `POST /v1/labs/{id}/commands` with `{id, command}` | Idempotent asynchronous command, HTTP 202. A different command with a used UUID conflicts. No transparent replay. |
| `GET /v1/labs/{id}/commands/{commandId}` | `{id, status, stdout, stderr, exitCode, truncated, startedAt?, finishedAt?}`; status `queued`, `running`, `completed` or `failed`. A completed shell may have nonzero exitCode. |
| `DELETE /v1/labs/{id}` | Immediately stops accepting commands and schedules cleanup. Unknown IDs create persistent stopped tombstones, preventing late PUT/POST requests from resurrecting a submitted assessment. |

Errors use `{error: string}`: 400 validation, 401 missing/incorrect key, 404 unknown
resource, 405 method, 409 state/idempotency/active command, 429 active-lab capacity or
100-command cap, and sanitized 500 operational failure. Timestamps are UTC ISO-8601
with `Z`. `PUT` never resets a terminal lab. An expired or stopped lab still permits
reading prior command evidence. A new assessment attempt requires a new lab ID.

Stopping is asynchronous. Poll final GET until `cleanupComplete` is true; that flag
means Kubernetes confirmed the namespace is gone. Pending cleanup consumes
capacity. Cleanup retries indefinitely and only deletes a matching owner/lab
namespace with a UID precondition. Before deletion, the broker captures up to
32,768 characters of deployments/services/pods/events as
`snapshot: {capturedAt, content, truncated, error?}`. It may appear after DELETE
returns. Snapshot failure does **not** prevent cleanup. A janitor deletion or lost
namespace can leave the snapshot unavailable; commands remain in SQLite.

The app must copy/poll final evidence after submission (including while cleanup is
pending); reading a single DELETE response is insufficient. Shell output and object
snapshots are candidate-influenced evidence, not independently verified grades.

## Lifecycle and operational limits

The broker reconciles expiry every two seconds independently of app/browser
polling. Restart preserves idle ready labs and evidence. An interrupted provision
or command fails the lab and schedules cleanup; a command that may have already
executed is never replayed. A late completion cannot change a stopped lab back to
ready. Storage must survive restarts. Back up/retain the database under the same
assessment evidence policy as UNIQassess. Do not delete tombstones while delayed
application work could still arrive. Historical records consume disk: monitor free
space, define an approved evidence-retention/archive process, and test restore.

`LAB_MAX_CONCURRENT` defaults to 10 and includes namespaces awaiting deletion.
Each lab has at most eight pods and 4 CPU / 4 GiB aggregate limit quota. Set smaller
capacity limits for a pilot. This cap is not a cloud bill limit: establish a bounded
node pool, account budget alarms and an operator kill switch. Disable starts in
UNIQassess before routine broker/policy maintenance. Monitor failed provisioning,
command timeouts, expiry-to-deletion delay, stuck namespaces, janitor health,
worker saturation and policy drift. An incident response must include isolating or
recycling unhealthy worker nodes; deleting an API object alone cannot prove that
an unreachable node stopped executing its containers.

## Tests and required live acceptance checks

Local, dependency-free tests:

```sh
python -m unittest discover -s lab-runner/tests -v
```

They cover idempotency, immutable expiry, stop-before-create tombstones, capacity,
command validation/caps, stopped-state behavior, restart recovery, snapshot/cleanup
retention, namespace ownership/UID preconditions, remote-only command transport,
API authentication, fail-closed configuration, bounded output and process timeout.
Cluster calls are mocked; no Docker daemon or connected Kubernetes cluster is
required. The tests do not validate CEL against an API server.

For a staging cluster, use [smoke.py](smoke.py) with an already configured private
broker. It intentionally creates one short-lived lab, repairs the exercise,
verifies recorded output, and closes the namespace. It prints its ID for recovery
and performs DELETE in a `finally` block. Run:

```sh
export LAB_RUNNER_URL=https://your-private-runner.example
export LAB_RUNNER_API_KEY=your-secret-from-the-secret-manager
python lab-runner/smoke.py
```

Then perform these additional operator acceptance tests **before real candidates**:

- Repeat provision and command requests with their IDs: one namespace and one
  execution; conflicting text/expiry gives 409. Delete-before-PUT stays stopped.
- Inspect every candidate pod on the node: confirm the actual sandbox runtime,
  dedicated placement, non-root UID, no host mounts and limited cgroups/PIDs.
- From the candidate console, verify `kubectl get pods -n kube-system`, namespace
  creation, secret/RBAC reads and policy/quota mutation all receive Forbidden.
- Try creating a pod without RuntimeClass, a different image, privileged/host PID/
  host network/hostPath settings, writable root filesystem, arbitrary nodeName,
  long termination grace or custom finalizer: admission must reject it. Try
  `kubectl delete pod workspace`: admission must reject it.
- Try a NodePort/LoadBalancer/externalIPs service: admission must reject it. Verify
  same-namespace service and API access work; another lab's pod IP, public internet,
  metadata IPs and node/kubelet endpoints fail using 2–3-second network timeouts.
  Verify cross-namespace access with a second actual lab, not merely RBAC checks.
- Submit a command producing more than 32 KiB on both streams: complete without
  broker memory growth, each stream bounded and `truncated: true`. Run a command
  longer than 20 seconds: its lab becomes failed and its namespace is removed.
- Stop during provisioning and during a running command; poll cleanupComplete and
  verify both API objects and runtime processes are gone. Capture the snapshot and
  retained command evidence. Try immediately starting another lab at capacity.
- Kill/restart the broker with an idle ready lab, with an active command, and with
  a pending deletion. Verify recovery policy and retained evidence. Leave a lab to
  expire with the browser closed; then repeat while the broker is stopped and
  prove the independent janitor removes it.
- Remove/alter a policy or RuntimeClass in staging: new labs must fail closed while
  old labs still expire. Check snapshots contain only that lab's objects. Test
  kubeconfig cluster-UID mismatch and namespace owner mismatch without deleting any
  unrelated namespace. Monitor cleanup with unavailable workers/control plane.
- Pilot accessibility, command latency, fairness of the time allowance, and rubric
  agreement with practising engineers. Record defects and operational measurements
  to inform the later AWS lab design.

## References

The isolation design follows the upstream guidance on
[multi-tenancy and sandboxed containers](https://kubernetes.io/docs/concepts/security/multi-tenancy/),
[RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/),
[Restricted Pod Security](https://kubernetes.io/docs/concepts/security/pod-security-standards/),
[RBAC privilege boundaries](https://kubernetes.io/docs/concepts/security/rbac-good-practices/),
[NetworkPolicy behavior and limitations](https://kubernetes.io/docs/concepts/services-networking/network-policies/),
and [ValidatingAdmissionPolicy](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/).
Recheck these against the actual cluster version and CNI before deployment.
