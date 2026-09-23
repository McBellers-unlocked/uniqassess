# Candidate operated Kubernetes labs

The first release adds a real Kubernetes workload troubleshooting exercise to a written assessment task. Candidates operate a command console directly; the Knowledge System does not execute their commands. The application retains command text, observed output and exit status separately from AI dialogue for human marking. This is a namespace-scoped workload exercise, not a cluster administrator certification lab or an AWS account sandbox.

## Delivery status

The repository includes the candidate console, task configuration, authenticated application API, evidence storage, assessor view, migration, dedicated runner and versioned exercise. It is opt-in and disabled by default in a new installation. The September 2026 AWS pilot deployment and live verification are recorded in [KUBERNETES_PILOT_DEPLOYMENT.md](KUBERNETES_PILOT_DEPLOYMENT.md). The AWS follow-on plan is in [AWS_CLOUD_LAB_PLAN.md](AWS_CLOUD_LAB_PLAN.md).

## Architecture

```text
Candidate browser -> UNIQassess API -> dedicated lab runner -> assessment-only Kubernetes cluster
                         |
                         +-> PostgreSQL command records -> anonymous human marking
```

The application gives the browser no administrator credentials, runner key or configurable runtime URL. Inside the workspace, kubectl uses a rotating Kubernetes service-account token limited to that candidate's namespace. A candidate operating the shell can inspect that token; network isolation and namespace permissions remain necessary even if they copy it. Every application lab request requires the candidate's existing assessment token and session cookie, including reads after submission. Task enablement comes from the cohort's frozen assessment version. Each candidate/task gets one idempotently created environment; there is no reset button. Each command is persisted before dispatch with a unique ID reused on retries.

Main-work submission and the written defence lock further command submission. The runner independently enforces the earlier of the assessment deadline and a 120-minute maximum lease, including when the browser closes or the application cannot reach it. The runner must keep final command records and an observed resource snapshot available for reconciliation. Evidence is not an automatic score and terminal text is never interpreted as HTML.

## Deploy and enable

1. Follow [the runner instructions](../lab-runner/README.md) to provision a dedicated assessment cluster and runner. Require the documented sandbox runtime, admission, network isolation, quotas and cleanup controls. Do not attach it to UNIQassess production workloads or production cloud credentials. Kubernetes namespaces alone are not a hard security boundary: see [Kubernetes multi-tenancy](https://kubernetes.io/docs/concepts/security/multi-tenancy/).
2. Apply `prisma/migrations/20260923120000_candidate_kubernetes_labs` using the normal migration workflow, before deploying the application. This adds lab sessions and command records without changing existing answers.
3. Configure the server using the Amplify Secrets Manager path below, or inject `KUBERNETES_LABS_ENABLED=true`, `KUBERNETES_LAB_RUNNER_URL` and `KUBERNETES_LAB_RUNNER_KEY` directly into a self-hosted server runtime. The URL must use HTTPS and the shared key must contain at least 32 characters. The runner uses `LAB_RUNNER_API_KEY` for the matching value. Do not put this key in `NEXT_PUBLIC_*`, `next.config.env`, task content or browser URLs. HTTP loopback is permitted only outside production for local tests.
4. In the task editor, enable **Kubernetes practical lab** on a written task. The initial preset is `kubernetes-troubleshooting-v1`. Supply a brief, exhibit, written deliverable and human-reviewed rubric matching that exercise. Normal Validation Lab and publication review still apply. Publication is blocked while the application has no configured runner.
5. Create a new cohort to capture the lab configuration in its immutable assessment version. Existing frozen cohorts do not acquire the new capability from later edits.
6. Complete the live pilot below before inviting applicants. Leaving the global flag off disables new runtime operations while retaining existing records.

Deploy the [trusted reconciliation Lambda](../infra/kubernetes-labs/reconciliation/README.md) with its one-minute EventBridge schedule outside the candidate lab VPC. It retrieves pending command results and final snapshots, retries cleanup, and never starts candidate commands. This is required so evidence reaches the application even when the candidate closes the browser and no assessor opens the submission. The runner's independent janitor still enforces expiry if this scheduler is unavailable. Keep the scheduler enabled while draining labs: its restricted GET/DELETE transport works even when candidate enablement is off. Marking additionally reconciles up to two sessions when an assessor opens the submission. `npm run labs:reconcile` remains available as an operator CLI against the same implementation. Never place production database credentials on the lab control or candidate nodes.

The batch console supports multiline commands and file editing through shell commands. Each run starts in `/workspace` in a fresh shell. Files and Kubernetes changes persist, but shell variables and working-directory changes do not. It is not an interactive TTY: use noninteractive commands instead of editors such as vim, long watches or port-forward sessions. Limits are 8,000 input characters, 20 seconds per command, 100 commands per lab, and 32,768 retained characters each for stdout/stderr. Candidates see truncation and deadline information. The runner's timeout policy may retire an environment when safe termination requires it; test and disclose this behavior in the task brief.

### Amplify server configuration

Amplify build variables are not automatically available to Next.js server requests. The application therefore embeds only the nonsecret `KUBERNETES_LABS_ENABLED` switch, `KUBERNETES_LAB_CONFIG_SECRET_ARN` locator and existing `APP_REGION` setting. The runner URL and key are fetched at request time from AWS Secrets Manager using the SSR compute role. See [AWS SSR environment guidance](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html) and [SSR compute roles](https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html).

Set the existing `NEXTAUTH_URL` to the exact public assessment origin. Lab writes compare the browser's Origin against that configured address, because Amplify's internal request hostname can differ from the public site. Caller-supplied forwarding headers do not expand the allowed origin.

For the deployed pilot, `node scripts/lab-pilot-toggle.mjs disable` stops new candidate starts and commands within the configuration cache's maximum 60 seconds. It preserves the runner URL/key so the trusted reconciler and independent janitor continue cleanup. `enable` is the corresponding operator action after verification. The helper checks the AWS account and fixed runner address and never prints secret values.

1. Store a dedicated Secrets Manager secret in `APP_REGION` with this JSON shape. Generate the real key securely and give the broker the same value; the following is a format example only:

   ```json
   { "enabled": true, "url": "https://runner.example", "key": "REPLACE_WITH_A_RANDOM_SHARED_SECRET" }
   ```

2. Attach an SSR compute role to the Amplify app/branch with `secretsmanager:GetSecretValue` permission limited to this secret's ARN. Grant `kms:Decrypt` on its specific KMS key if using a customer-managed key. Use the compute role rather than embedding AWS access keys or relying on the Amplify build role.
3. Set the Amplify app/branch variables `KUBERNETES_LAB_CONFIG_SECRET_ARN`, `APP_REGION`, and `KUBERNETES_LABS_ENABLED=true`, then rebuild. Do not add `KUBERNETES_LAB_RUNNER_KEY` to Amplify build variables or the build artifact. A configured secret takes precedence over direct URL/key environment values and never falls back to them when secret retrieval fails.
4. Give the separate reconciliation Lambda its own permission to read this secret and a dedicated database secret. Its database credential remains inside trusted application infrastructure. Ensure the configured HTTPS endpoint is reachable from both runtimes.
5. Verify a server request resolves the secret and a controlled candidate can start a lab. Missing IAM access, malformed configuration, non-HTTPS production URLs and insufficient key length fail closed with sanitized errors. The application does not include secret-store diagnostics in candidate responses.

Secret values, including `enabled: false`, are cached for at most 60 seconds per application server process; concurrent lookups share one request. Expired credentials are never reused after a failed refresh. Both the build switch and the secret switch must be enabled for candidate work. Disabling either leaves trusted evidence retrieval and cleanup active; retain the URL/key fields and worker IAM permissions while draining labs. The scheduled Lambda fetches fresh secret values on each invocation. Already-saved command evidence stays readable during a Secrets Manager outage. Coordinate key rotation with the broker and confirm its new key is active before resuming labs.

## Live pilot acceptance

- Two concurrent candidates receive separate environments; neither can read or modify the other's resources or evidence. Tokens without the correct session cookie fail, including after submission.
- Real `kubectl` reads, edits and recovery checks operate on the supplied defective workload. Refresh and task switching preserve files and recorded commands.
- Repeated command request IDs execute once, including simulated lost HTTP responses; a new request ID permits an intentional repeat. Only one command runs at a time.
- Candidate workloads cannot change quotas, network policies, admission, identities or sandbox runtime; cannot use host access, external services or production credentials. Verify enforcement with the actual CNI and runtime rather than assuming manifests provide it.
- Main-work submission, defence, exact deadline expiry, browser closure and runner restart all prevent further work and reclaim resources. Stop/provision and stop/command races cannot recreate a closed lab.
- Long-running/background processes, excessive output, unavailable images, cluster/API outages and a failed cleanup produce honest states and bounded resource use. Final output and the independent resource snapshot reach the assessor record even if the browser was closed.
- Compare candidate setup time and command latency, assessor usefulness, cleanup delay and infrastructure cost across realistic concurrent sessions. Provide a consistent interruption/rebooking policy; infrastructure failure must not be interpreted as candidate incompetence.

Do not set hiring pass thresholds or claim the lab is validated from synthetic tests. Pilot the exercise and its rubric with practising engineers and review whether the assigned time permits both practical work and written reasoning.
