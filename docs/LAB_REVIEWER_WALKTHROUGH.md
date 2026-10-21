# AWS and Kubernetes lab reviewer walkthrough

Assessor-only answers for the hiring manager and exercise reviewers. Use a fresh
reviewer attempt; running a solution changes the lab and its recorded evidence.
Keep these notes out of candidate briefs, workspaces and AI context.

## Working in the lab

The newest output appears first, with history scrolling separately from the
command box. The assessment keeps the AI message box inside the window.
The **Files** tab lists, opens, creates and saves UTF-8 project files. Wait for a
successful save before running commands that use the file. File operations use
the same recorded, serial queue and count towards the 100-run limit. AWS file
operations are asynchronous jobs, so startup can take time. Text files up to
16 KiB are supported, subject to the compressed 8,000-character command limit.
Use commands for larger files.

Unsaved editor text survives task switches and reloads in the same browser tab.
It remains a local draft until **Save file** succeeds. Saving checks the version
that was opened; if a command changed the file, copy any needed edits and reopen
it. New-file saves refuse to overwrite an existing path. Atomic saves preserve
existing permissions, including execute bits.

## Kubernetes: diagnosis, repair and verification

Run each block separately. Each command starts in `/workspace` and has a
20-second hard limit; reaching it retires the lab. The two deliberate defects
are a readiness probe aimed at 8081 instead of 8080, and a service selector using
`checkout-previous` instead of `checkout`. Preserve both replicas and health checks.

Inspect the starting state, readiness configuration, labels and routing:

```sh
kubectl get pods,deployments,services
```

```sh
kubectl get deployment checkout -o yaml
```

```sh
kubectl get service checkout -o yaml
kubectl get pods --show-labels
kubectl get endpointslices -l kubernetes.io/service-name=checkout
```

Repair the readiness port, then the service selector:

```sh
kubectl patch deployment checkout --type=json -p='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/port","value":8080}]'
```

```sh
kubectl patch service checkout --type=merge -p='{"spec":{"selector":{"app":"checkout"}}}'
```

Check rollout with a bounded wait. If pods are still starting when this returns
a timeout, inspect the result and repeat this block. Do not use an unbounded watch.

```sh
kubectl rollout status deployment/checkout --timeout=8s
```

Verify two Ready replicas, endpoints and a real service request:

```sh
kubectl get deployment checkout
kubectl get endpointslices -l kubernetes.io/service-name=checkout
curl --fail --silent --show-error --max-time 3 -i http://checkout/checkout
```

Expected: `2/2` Ready replicas, populated EndpointSlices and HTTP 200 with the
checkout response containing `"status":"ok"`.

To test the file editor instead of patching, export before making the repairs:

```sh
kubectl get deployment checkout -o yaml > checkout-deployment.yaml
kubectl get service checkout -o yaml > checkout-service.yaml
```

In **Files**, open `checkout-deployment.yaml`, change only the readiness probe
port to `8080`, and save. Open `checkout-service.yaml`, change `spec.selector.app`
to `checkout`, and save. Apply the manifests, then perform the rollout and service
checks above:

```sh
kubectl apply -f checkout-deployment.yaml
kubectl apply -f checkout-service.yaml
```

## AWS: full solution sequence

The [AWS command walkthrough](AWS_LAB_WALKTHROUGH.md) contains eleven ordered,
copyable jobs and expected results: initial failure, bounded IAM repair and
baseline measurement, reference file repair, failed-test gate, immutable release,
functional/performance checks, actual alarm breach/recovery and known-good rollback.
It is generated from the existing operator acceptance commands by
`node scripts/verify-aws-lab.mjs --walkthrough` (generation makes no cloud calls).

Readable reference sources:
[`build_solution.py`](../aws-lab/exercises/aws-service-release-v1/assessor/build_solution.py)
and [`pipeline.sh`](../aws-lab/exercises/aws-service-release-v1/assessor/pipeline.sh).
The repair changes `archive/*` to `orders/*` in `main.tf`, reduces three dependency
reads to one in `app.py`, adds a bounded alarm and completes the pipeline.
Equivalent justified solutions are valid.

## Permission troubleshooting

- **`./pipeline.sh: Permission denied`:** earlier AWS seeds packaged all files
  as `0644`. New seeds set the pipeline to `0755`. For an already-started lab,
  run `chmod u+x pipeline.sh` or use `bash pipeline.sh`. This fixes shell execution
  permission; the deliberate pipeline defects still need repair.
- **Project files:** use relative workspace paths. Kubernetes uses `/workspace`;
  AWS jobs start in `/tmp/workspace`. Check `pwd`, `id`, `ls -ld .` and (AWS)
  `ls -l main.tf pipeline.sh`. System/tool files are outside the editor. Kubernetes
  has a read-only root filesystem: export resources into workspace files first.
  Neither solution requires `sudo` or broad permission changes.
- **AWS application AccessDenied:** repair the wrong object prefix, then deploy
  code to refresh the execution environment before bounded service checks. Do not
  widen the role boundary or grant account-wide permissions.
- **Forbidden cluster/cloud operations:** cross-namespace access, role/boundary
  changes and unrelated resources are intentionally unavailable and unnecessary.
- **Other failures:** retain the exact command, path, output and job status for
  the organiser. A failed save keeps the editor draft. Stop if workspace
  persistence fails; editor text is not proof of a saved cloud file.

## Verification and release status

The repository records a successful AWS operator run on **23 September 2026**:
24 checks including release, rollback and real metric-driven alarm transitions.
See [operator evidence](AWS_LAB_OPERATOR_ACCEPTANCE.md) and the
[combined browser pilot](DEVOPS_BROWSER_PILOT.md) for scope. The operator repair
explicitly restored execute permission, which explains why it did not expose
the seeded `./pipeline.sh` usability problem.

Those historical results do not verify this revision live. Deploy the app and
AWS runtime update, then run these walkthroughs in new reviewer attempts. Check
save/reopen, retained execute permission, latest-first output, visible command/AI
inputs after many runs, and locked saves after submission/expiry. The editor uses
the existing runner command protocol; Kubernetes needs no new file-service endpoint.

Offline checks:

```text
npm test
npx tsc --noEmit
python -m unittest discover -s lab-runner/tests -v
python -m unittest discover -s infra/aws-labs/runtime -p test_runtime.py -v
python -m unittest discover -s aws-lab/exercises/aws-service-release-v1/candidate/tests -v
python -m unittest discover -s aws-lab/exercises/aws-service-release-v1/assessor -p test_fixture.py -v
node scripts/verify-aws-lab.mjs --check
```

Editor tests execute the actual generated Python operations. Set `LAB_TEST_PYTHON`
if Python is not on PATH. POSIX execute-bit and symlink tests run on Linux;
Windows cannot certify those semantics. Local tests do not replace live checks.
