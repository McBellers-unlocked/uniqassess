# AWS practical lab deployment

Updated 23 September 2026. **Dedicated AWS infrastructure and runtime are installed; technical acceptance is in progress.** This is a controlled pilot with one exclusive AWS account lease. Final acceptance results and browser evidence must be added below by the operator before this document is treated as a launch record. Human calibration and broader scale/cost validation remain separate work.

Task 2, `aws-service-release-v1`, covers a Lambda/S3 service, prepared Terraform, an executable release/rollback pipeline, request-level performance evidence and CloudWatch alarms. It forms 60 marks alongside the existing 40-mark Kubernetes task. The assessment uses one 100-minute timer, with a suggested 40/60-minute allocation. AWS is assessed; Azure is not. [Assessment and marking details](DEVOPS_ASSESSMENT.md)

## Installed configuration

| Component | Actual configuration |
| --- | --- |
| Organization / lab OU | `o-6ugwwht3qj` / `ou-xc9q-of0al9sb` |
| Management and existing hosting account | `891612540396`; existing billing retained as authorized |
| Dedicated candidate account | `689324611808`, **UNIQassess Assessment Sandbox**; one active lease |
| Region | `eu-west-1` |
| Management stack | `uniqassess-aws-lab-management` |
| Child stack | `uniqassess-aws-lab-sandbox` |
| Private control Lambda | `uniqassess-aws-lab-runner`, Python 3.12, 512 MB, 120-second invocation limit, reserved concurrency 10 |
| Durable control state | DynamoDB `uniqassess-aws-lab-sessions`, on-demand billing, encryption and point-in-time recovery |
| Source/runtime artifacts | Private, encrypted, versioned bucket `uniqassess-aws-lab-artifacts-891612540396`; runtime ZIP key contains its content hash |
| Scheduled cleanup | EventBridge `uniqassess-aws-lab-reconcile`, once per minute, invokes the same private control Lambda |
| Child operator access | `uniqassess-aws-lab-orchestrator`; trust restricted to the management runtime role; resource creation limited to exercise prefixes |
| Candidate access boundary | Protected `uniqassess-lab-candidate-boundary`; lease-specific resources/principals and time conditions; candidate cannot modify it |
| Candidate execution | AWS CodeBuild `aws/codebuild/standard:7.0`, Linux small, privileged mode disabled; one project/job at a time, five-minute build and queue limits |
| Application runtime | Lambda Python 3.12, 256 MB, 10-second timeout, reserved concurrency one; candidates cannot change these controls |
| Storage | Per-lease private S3 bucket and persisted workspace; all four public-access-block settings verified at child-account level |

A read-only deployment status check observed the management stack `UPDATE_COMPLETE`, runtime `Active`, update `Successful`, handler `handler.handler`, runtime admission `true` and reconciliation `ENABLED`. This is control-runtime readiness, not confirmation that application publication, browser flows or the complete acceptance suite passed. The earlier [control scaffold receipt](../infra/aws-labs/control-deployment-evidence.json) intentionally records admission and scheduling disabled before runtime installation; it is not the latest runtime flag snapshot.

## Lifecycle and evidence

The private application-to-runner transport uses IAM invocation. DynamoDB owns the exclusive account lease, command identity and lifecycle; repeated command IDs reuse the same record. Commands are asynchronous because a Terraform or release operation can exceed the Kubernetes console's short command window. Each shell command has a maximum of four minutes inside the five-minute CodeBuild job, shortened further by the assessment deadline. The runner caps a session at 100 commands and truncates retained output; these are operational limits rather than performance guarantees.

On submission or expiry, new work is fenced, the protected boundary is frozen, active builds are stopped, a concise AWS state snapshot is retained, and exercise resources are removed. The pool remains occupied if cleanup cannot be verified. EventBridge reconciliation runs without an open browser, but it uses the same control implementation: it is not a second independent cleanup engine. Independent operator inspection uses the temporary bootstrap helper during acceptance.

Candidate-controlled command output, application logs and result artifacts require human interpretation. Independent AWS state and deployment history supplement that evidence; a script completion flag is not a hiring score. The fixture's request spans and structured metrics demonstrate a small instrumented service, not a comprehensive APM platform or a full distributed tracing installation.

## Verification record

Completed setup checks: account identity and role access; actual Lambda and CodeBuild quotas; stack creation; S3 public-access blocking; IAM syntax/action validation; and generated boundary size/evaluation. The maximum supported 35-character lab ID generates a 5,967-byte boundary. Read-only IAM simulations allowed a correctly timed alarm without actions and denied alarm actions, an expired deadline and a previous lease's token. [Preflight report](AWS_LAB_PREFLIGHT.md), [boundary evidence](../infra/aws-labs/boundary-validation-evidence.json)

**Live acceptance: pending final operator update.** The final record must identify the deployed artifacts and test run, candidate repair/release/rollback and monitoring results, application/browser access checks, submission cleanup, browser-independent expiry and independent resource-absence receipts. Do not convert in-progress observations into a completed pass here.

The current acceptance scope does **not** export and replay copied AWS credentials after expiry, and it does not establish an exhaustive AWS privilege-escalation audit. The expiry/old-token IAM simulations above must remain labelled simulations even after the browser and cleanup checks pass.

## Operating limits and follow-on work

- **One simultaneous AWS lab.** The two-lab Kubernetes capacity does not increase AWS capacity. A second active AWS lease must wait or be rejected; scaling needs more dedicated accounts and tested reset capacity.
- **Internet-connected jobs.** The CodeBuild project has no VPC or outbound endpoint allowlist. Candidate code can contact public services. Management/database credentials are excluded from the child account, but this is not a network-isolated or AWS-endpoints-only lab.
- **No exact spending cap.** Fixed concurrency, runtime settings, job limits and credential deadlines reduce exposure. Logs, API volume, artifacts and custom metric cardinality still incur costs. Embedded metrics can be emitted through log writes without `PutMetricData`; budgets use delayed billing information. No per-assessment price or worst-case cost has been measured.
- **Pilot reliability.** Cold/warm latency distributions, sustained cohort load, failure-injection coverage, observed copied-credential revocation delay and total billed cost remain unestablished. Cleanup failures hold the account for operator action.
- **Fixture versioning.** The runtime ZIP is content-addressed, but the candidate source currently uses mutable key `aws-service-release-v1/source.zip`. S3 retains versions; the runtime reads the latest object rather than a pinned version. Record each tested source checksum and S3 version ID, including any help-only update for browser testing. Pin an immutable fixture key/version to each published template before hiring cohorts so later starts cannot silently receive different content. [Observed source versions](../infra/aws-labs/source-artifact-evidence.json)
- **Hiring validity.** Practising engineers must calibrate timing, wording, marks and pass criteria. Architecture is sampled through a bounded design extension; Azure, EKS, multi-region operations and full APM implementation are outside this exercise.
- **Temporary bootstrap access.** The dedicated bootstrap Lambda and its role are retained only through acceptance and must be removed afterwards using the [bounded cleanup plan](../infra/aws-labs/BOOTSTRAP_CLEANUP.md). Normal runtime access uses its scoped child role.

The [AWS follow-on plan](AWS_CLOUD_LAB_PLAN.md) retains engineer-study, account-pool, managed-provider, load and cost gates before wider rollout.
