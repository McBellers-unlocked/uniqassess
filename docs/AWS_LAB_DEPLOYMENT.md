# AWS practical lab deployment

Updated 23 September 2026. **Dedicated AWS infrastructure and runtime are installed; all 24 live operator checks and both synthetic browser paths passed.** This is a controlled synthetic pilot with one exclusive AWS account lease. Human calibration, broader scale/cost validation, immutable fixture binding and the administrative expiry-reporting follow-up below remain separate work before hiring use.

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

**Live operator acceptance passed.** Run `20260923c1d2e3f4` completed 24 checks and 15 successful jobs, with zero cleanup failures: seeded denial, Terraform repair, persisted workspace and duplicate-request handling, forbidden AWS calls, a failed-test release gate, successful immutable release, valid/missing order responses, denied unrelated data, actual alarm transitions from OK to ALARM to OK, rollback to the known-good version, normal teardown, and a six-minute automatic-expiry check. Both teardown paths received independent resource-absence checks; expiry absence was observed before any controller read. [Full operator acceptance](AWS_LAB_OPERATOR_ACCEPTANCE.md).

Application deployment 77 succeeded at main revision `782f825ff4dd925dff51d1a626a13df780a84d1c`. The fictional Alpha browser attempt started both labs, recovered Kubernetes, ran two AWS smoke/persistence jobs, retained work after reload and submitted. The assessor displayed both responses, all five completed commands, final snapshots and cleanup receipts; independent checks confirmed resource absence. Beta closed its browser while an AWS job ran. Before reopening, read-only database inspection confirmed the completed job, retained snapshot and an application cleanup receipt saved 56.566 seconds after its deadline; an independent AWS inspection confirmed all eight resources absent. Returning showed a completed assessment and retained assessor evidence. [Browser verification](DEVOPS_BROWSER_PILOT.md).

The reference release job took 111.486 seconds and rollback took 75.803 seconds from dispatch to observed terminal result, including CodeBuild/tool startup and polling. The performance check retained five actual handler durations before repair (61.240, 74.260, 72.402, 73.672, 68.030 ms) and after repair (143.734, 21.291, 23.231, 34.517, 32.043 ms). S3 dependency reads changed from three to one for every sampled request. The first repaired sample was slower; this small sample does not establish p95, cold-start attribution or a guaranteed latency improvement.

Two earlier runs stopped while testing a permission-only repair against an already-running Lambda environment. The final harness refreshes the **same seeded application source** once after changing IAM permissions before measuring the baseline, then uses bounded read checks. The unchanged source digest and actual results are retained. This follows [AWS execution-role update guidance](https://docs.aws.amazon.com/lambda/latest/dg/permissions-executionrole-update.html); the ordinary release pipeline already applies permissions before updating application code. Both failed runs were independently confirmed clean.

The current acceptance scope does **not** export and replay copied AWS credentials after expiry, and it does not establish an exhaustive AWS privilege-escalation audit. The expiry/old-token IAM simulations above must remain labelled simulations even after the browser and cleanup checks pass.

## Operating limits and follow-on work

- **One simultaneous AWS lab.** The two-lab Kubernetes capacity does not increase AWS capacity. A second active AWS lease must wait or be rejected; scaling needs more dedicated accounts and tested reset capacity.
- **Internet-connected jobs.** The CodeBuild project has no VPC or outbound endpoint allowlist. Candidate code can contact public services. Management/database credentials are excluded from the child account, but this is not a network-isolated or AWS-endpoints-only lab.
- **No exact spending cap.** Fixed concurrency, runtime settings, job limits and credential deadlines reduce exposure. Logs, API volume, artifacts and custom metric cardinality still incur costs. Embedded metrics can be emitted through log writes without `PutMetricData`; budgets use delayed billing information. No per-assessment price or worst-case cost has been measured.
- **Pilot reliability.** Cold/warm latency distributions, sustained cohort load, failure-injection coverage, observed copied-credential revocation delay and total billed cost remain unestablished. Cleanup failures hold the account for operator action.
- **Fixture versioning.** The runtime ZIP is content-addressed, but the candidate source currently uses mutable key `aws-service-release-v1/source.zip`. S3 retains versions; the runtime reads the latest object rather than a pinned version. Record each tested source checksum and S3 version ID, including any help-only update for browser testing. Pin an immutable fixture key/version to each published template before hiring cohorts so later starts cannot silently receive different content. [Observed source versions](../infra/aws-labs/source-artifact-evidence.json)
- **Hiring validity.** Practising engineers must calibrate timing, wording, marks and pass criteria. Architecture is sampled through a bounded design extension; Azure, EKS, multi-region operations and full APM implementation are outside this exercise.
- **Administrative expiry reporting.** Lab expiry and cleanup run without a browser. The existing candidate record finalizes on its next authenticated request, so the dashboard can remain `started` and show return-time rather than deadline-based duration. Beta demonstrated this explicitly: six minutes of permitted time displayed as eight minutes on return. Correct this reporting before broader hiring use; deadline checks already reject further work.
- **Temporary bootstrap access removed.** The dedicated bootstrap Lambda and exact role/policy were removed at `2026-09-23T13:44:21.187Z`, after both independent browser checks. Direct absence checks passed, the permanent runtime remained healthy with unchanged code, reconciliation stayed enabled and the lease pool was empty. [Removal receipt](../infra/aws-labs/bootstrap-cleanup-evidence.json), [bounded cleanup procedure](../infra/aws-labs/BOOTSTRAP_CLEANUP.md). Normal runtime access uses its scoped child role.

The [AWS follow-on plan](AWS_CLOUD_LAB_PLAN.md) retains engineer-study, account-pool, managed-provider, load and cost gates before wider rollout.
