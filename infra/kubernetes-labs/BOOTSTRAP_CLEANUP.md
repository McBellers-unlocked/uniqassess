# Pilot bootstrap access cleanup

**Completed on 23 September 2026 at 11:09:07 UTC**, after the root operator
confirmed all browser, lifecycle and recovery checks had finished and every test
lab namespace had been removed. The earlier inspection was read-only; the
reviewed cleanup was subsequently executed on explicit instruction.

## Completion evidence

- SSM cleanup command `ee1805ec-8d2f-4f2c-a83c-4b26e8a53f7b` succeeded. Exactly
  one matching worker authorized-key line was removed and every other line was
  preserved. A fresh SSH connection explicitly failed public-key authentication
  before the control private-key file was removed.
- Only `LabBootstrapOnly` was deleted. The `PilotManagementOnly` policy hash
  remained unchanged. The runner secret remained active with unchanged version
  stages; its Kubernetes Secret retained the same UID and data.
- Only the Kubernetes Secret's last-applied annotation was removed. The
  installer-compatible server-side dry run passed first, without changing the
  live Secret's resource version or exposing credential values.
- Only the bootstrap secret was scheduled for deletion with
  `RecoveryWindowInDays: 7`; no force-deletion option was used. AWS
  `DescribeSecret.DeletedDate` metadata was observed as
  `2026-09-23T12:09:04.835000+01:00`. This observed metadata field is recorded as
  returned; it is not presented as the recovery-window deadline.
- SSM post-cleanup health command `a2a66bee-155e-4d7b-ac95-3c5a300b2397` succeeded:
  app homepage HTTP 200, unauthenticated broker request HTTP 401, authenticated
  read of a nonexistent lab HTTP 404, one Ready broker replica, both nodes Ready,
  zero managed lab namespaces, no private-key file and no last-applied annotation.

Sanitized results are in [bootstrap-cleanup-evidence.json](bootstrap-cleanup-evidence.json).
The operational procedure below is retained for review and future maintenance;
it does not require another cleanup run.

## Inspected access

The control role `uniqassess-kubernetes-pilot-ControlRole-3tiQo5GwADk9` has two
inline policies and no attached managed policies:

- `LabBootstrapOnly`: reads the pilot bootstrap and runner secrets; obtains ECR
  authorization; uploads and pulls images in only the two pilot repositories.
- `PilotManagementOnly`: SSM host-management channels and read access to the
  bootstrap bucket's `bootstrap/*` prefix. This is the template-managed policy.

The worker has no IAM instance profile and its metadata endpoint is disabled.
Its Ubuntu account has one inspected bootstrap SSH key, fingerprint
`SHA256:Ps56DR68SrVYycI2q0L/uWLU/CJe2QiTHWRL04loQn0`, with comment
`uniqassess-kubernetes-pilot-bootstrap`.

The control's `/opt/uniqassess-bootstrap/worker-key` is root-owned mode 0600.
Docker registry login credentials are already absent. The worker's
`/etc/rancher/k3s/join-token` is root-owned mode 0600 and remains a required K3s
credential, not a disposable bootstrap artifact.

The read-only host inspection was SSM command
`93fe5bab-89a5-4f8d-8475-1031d9adeaf5`. No private key, token or secret value is
included here.

## Ordered, narrowly scoped removal

1. Confirm the broker is running with its Kubernetes service account and secret,
   both final images are preloaded, and no image build or secret import remains.
   Finish and clean up all test labs. The scripted execution refuses to proceed
   while a managed lab namespace remains or either node/broker is not Ready.
2. Remove only the broker Secret's
   `kubectl.kubernetes.io/last-applied-configuration` annotation, if present.
   Client-side apply previously copied the key into that annotation on the same
   protected Secret. Check the Secret UID and data are unchanged, without
   printing either credential representation. Future installation uses
   server-side apply to avoid recreating the duplicate.
3. While the existing SSH session is usable, remove only the matching bootstrap
   key line from `/home/ubuntu/.ssh/authorized_keys` on the worker. Match the
   cryptographic fingerprint above; preserve any other keys discovered at the
   time of removal. Check permissions and confirm the revoked key cannot start
   a new session before removing its private copy.
4. Remove only `/opt/uniqassess-bootstrap/worker-key` on the control. Delete only
   the control role's inline `LabBootstrapOnly` policy. Keep
   `PilotManagementOnly` so SSM management and reviewed source retrieval continue.
   Schedule deletion of only Secrets Manager secret
   `uniqassess/labs/pilot/bootstrap` with a seven-day recovery window. Do not
   force-delete or remove the separate
   `uniqassess/labs/pilot/runner` secret used by the application and broker.
5. Retain the public EC2 key-pair registration until the CloudFormation
   `WorkerKeyName` reference is changed or the pilot is retired. The registration
   holds no private key; deleting it without updating that reference could break
   a later stack update or worker replacement.
6. Optionally remove the exact control files
   `/opt/uniqassess-bootstrap/workspace.tar`,
   `/opt/uniqassess-bootstrap/broker.tar`, and
   `/opt/uniqassess-bootstrap/source.tar.gz` after acceptance. They are disposable
   transfer archives. Keep the extracted deployment source, sanitized evidence,
   known-host fingerprints and current containerd images.

The worker has no SSM role. Revoking its SSH key deliberately ends this temporary
maintenance path; future worker maintenance needs a reviewed new access method or
worker replacement. Leave the private control-to-worker SSH security-group rule
in the template until that maintenance design is explicitly changed.

Do not remove control kubeconfig, K3s server/agent tokens, worker join-token,
node certificates, broker secret or persistent evidence storage. Do not run
blanket image pruning: obsolete images should be removed only after checking
that no live workload or rollback reference uses their exact digests. Future
image builds can temporarily regain the same reviewed repository-specific
permissions without restoring unrelated access.

## Prepared operator commands

Run from the repository with the operator's AWS CLI credentials. The script pins
the account, region, stack, role, instance IDs and both secret ARNs to the
reviewed pilot. It reads secret metadata only; it never calls `GetSecretValue`.
The current Kubernetes Secret is read in memory on the control for comparison,
and no credential value is written to output, arguments or files.

Read-only preflight, safe while tests run:

```sh
node infra/kubernetes-labs/cleanup-bootstrap.mjs --inspect
```

The preflight also uses the current Secret's canonical `data` in a server-side
dry run with field manager `uniqassess-bootstrap`, matching the updated installer.
It compares the returned data in memory and confirms that the live UID, data and
resource version remain unchanged. Only the success boolean is printed.

The following command was run once after the root operator's explicit
acceptance/recovery all-clear. Do not rerun it as a routine health check:

```sh
node infra/kubernetes-labs/cleanup-bootstrap.mjs --execute-after-acceptance
```

The script sends [cleanup-bootstrap-host.py](cleanup-bootstrap-host.py) directly
over SSM. It first derives the public fingerprint from the exact private key,
then matches exactly one worker authorized-key line. Other lines, ownership and
permissions are preserved atomically. A new SSH connection must explicitly fail
public-key authentication before the control private key is removed. Host-key
verification is strict and SSH agent/password authentication is disabled.

After host cleanup succeeds, the local operator deletes only `LabBootstrapOnly`
and schedules only the bootstrap secret. It verifies that `PilotManagementOnly`
is unchanged and the runner secret remains active with the same version stages.
The public EC2 key-pair registration, security groups, transfer archives,
Kubernetes node credentials and running workloads are left in place.

Sanitized phase results are saved in `.deployment/bootstrap-cleanup-state.json`;
the control saves a root-only, nonsecret marker at
`/opt/uniqassess-bootstrap/bootstrap-access-cleanup.json`. If interrupted, rerun
the same command to inspect the recorded SSM invocation and continue only
unfinished cloud steps. If that host invocation failed, inspect its sanitized
failure before retrying; the script will not silently dispatch another destructive
attempt. A source change also stops automatic reuse of the old invocation.

The earlier annotation-only inspection was SSM command
`e2d5f38e-dfe8-4cb6-809a-b419e96f8dbf`; its output contained only presence/match
booleans. Server-side dry-run preflight command
`9a2dd7c5-9505-4683-845d-b8ee067578aa` passed before execution.
