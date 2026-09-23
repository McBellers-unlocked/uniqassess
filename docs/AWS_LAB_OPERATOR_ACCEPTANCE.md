# AWS lab operator acceptance — 23 September 2026

The live synthetic operator run passed all **24 checks**, including **15 successful command jobs**, with **zero cleanup failures**. This establishes technical operation of the bounded AWS exercise. Candidate and assessor browser acceptance is recorded separately; human engineer calibration and hiring approval are not established by this run.

## Evidence identity

- Run: `20260923c1d2e3f4`.
- Template: `aws-service-release-v1`.
- Window: **12:50:50.275–13:16:05.389 UTC**, 23 September 2026.
- Final report: `.deployment/aws-lab-acceptance-20260923c1d2e3f4/acceptance.json` in the operator workspace. It contains detailed synthetic command evidence and is intentionally excluded from source control.
- Final report SHA-256: `3ad9aac630cee7d5f2ddd057311ef53dad48fd49f98781fb3327ab8e05c9ad5f`.
- The report was finalized with its timing summary before synthetic pilot activation. It must remain unchanged because activation records and checks this hash.

This document contains a sanitized summary. It does not reproduce credentials, command payloads, complete answer artifacts or retained workspace snapshots.

## What passed

| Area | Live observation |
| --- | --- |
| Provisioning and capacity | Both fresh synthetic leases reached Ready. A second simultaneous lease was rejected with 429. |
| Initial diagnosis | The seeded service returned 503 with a real access-denied dependency observation; the supplied functional unit tests passed. |
| Persistent workspace and request reuse | A counter persisted between jobs. Reusing an identical command ID reused the original result and did not increment it again. Reusing the ID with different command text was rejected with 409. |
| Selected permission boundaries | IAM user listing, assuming a role in the management account, and changing Lambda configuration were denied. The identity remained in the sandbox. An unrelated S3 object was also denied. |
| Failed release gate | A deliberately failing unit test stopped the pipeline. The deployed function's code digest remained unchanged. |
| Release and infrastructure as code | The repaired pipeline passed tests, generated, retained and applied saved Terraform plans, published an immutable version, verified it, promoted the alias, verified the service and produced a follow-up plan with no changes. |
| Application contract | The released service returned 200 with the expected synthetic order; a missing order returned 404. |
| Performance evidence | Five baseline requests each recorded three dependency reads; five repaired requests each recorded one. Measured durations and their limitations are retained below. |
| Monitoring | The real CloudWatch alarm first reached OK. An explicitly synthetic dependency fault produced an error metric and ALARM; a subsequent healthy invocation was followed by OK. The check did not manually set alarm state. |
| Rollback | Terraform restored the provided known-good version. Both its live alias and successful service response were verified. |
| Explicit stop | The final snapshot and cleanup receipt were retained. An independent AWS inventory found all eight expected resource types absent. New commands against the closed lease were rejected with 409. |
| Deadline expiry | A separate six-minute lease and persistent marker job completed. Automatic cleanup was independently observed before any post-deadline controller read, followed by the retained cleanup receipt and snapshot. |

The eight independently checked resources were the function, data bucket, command project, application role, job role, alarm, application log group and job log group. The absence helper treats unexpected API errors or access denial as failures, not proof of absence.

## Observed timing

These are individual observations from one successful operator run. Ready includes provisioning, bootstrap and polling. Command wall time runs from controller dispatch to the observed terminal result and includes container/tool startup and polling; it is not shell-only execution time or an SLA.

| Observation | Seconds |
| --- | ---: |
| First lease to Ready | 88.158 |
| Expiry lease to Ready | 88.785 |
| Initial diagnosis and unit tests | 50.159 |
| Baseline permission repair and measurements | 80.510 |
| Idempotency job | 39.173 |
| Persistent counter check | 37.868 |
| Permission-denial checks | 38.150 |
| Reference workspace repair | 39.107 |
| Deliberately failed test gate | 61.904 |
| Full release pipeline | 111.486 |
| Functional and measured-performance checks | 50.738 |
| Alarm priming | 38.230 |
| Alarm breach observation | 87.086 |
| Alarm recovery observation | 122.195 |
| Rollback | 75.803 |
| Final alias and service check | 37.931 |
| Expiry marker job | 37.653 |

The complete run took **25 minutes 15 seconds**, including both provisioning sequences, the full check matrix, explicit teardown and the deliberate expiry waiting window. This is not a candidate completion-time measurement. The assessment's provisional 100-minute duration still requires practising-engineer trials, particularly because each separate command job incurs startup time.

The expiry lease deadline was **13:14:16.084 UTC**. The controller-free observation window began at **13:10:25.195 UTC**. Independent absence was observed at **13:15:55.562 UTC**, before the subsequent controller read. This demonstrates cleanup by that observation time, not its exact completion instant or a cleanup-latency percentile.

## Measured application samples

| Request in sample | Baseline duration, ms (three reads) | Repaired duration, ms (one read) |
| --- | ---: | ---: |
| 1 | 61.240 | 143.734 |
| 2 | 74.260 | 21.291 |
| 3 | 72.402 | 23.231 |
| 4 | 73.672 | 34.517 |
| 5 | 68.030 | 32.043 |

These were actual function request summaries and dependency spans. The first repaired request was slower than every baseline request. Five requests per version cannot establish a production speedup, a percentile, or a causal explanation for that first observation; environment, connection and warm-up effects were not controlled. The reliable structural observation is that redundant dependency reads fell from three to one while the response contract still passed.

## Learning applied during verification

Two earlier synthetic runs stopped at the baseline permission check and were cleaned up with independently verified absence. Applying the corrected role policy while retaining the existing function execution environment continued to return access denial. The successful run performed one explicit code deployment containing unchanged application source after the policy update, retained both archive digests and the unchanged source digest, waited for the deployment and used bounded read-only service checks. The first subsequent check returned 200.

This matches AWS's documented execution-role update guidance to refresh the function after adding role permissions. The supplied release sequence already applies the policy before deploying code; the candidate guidance now states this order. No runtime permissions were widened to resolve this behavior. See [AWS execution-role update guidance](https://docs.aws.amazon.com/lambda/latest/dg/permissions-executionrole-update.html).

## Limits and follow-up

This was a scripted synthetic operator run in one region with one account lease at a time. It did not establish concurrent-candidate capacity, exhaustive resistance to escalation, copied-credential expiry outside the workspace, a general distributed tracing platform, Azure competence, human usability, marking agreement or psychometric validity. The failed test gate proves that particular gate behavior; it is not an exhaustive pipeline-security audit.

The separately recorded [candidate and assessor browser checks](DEVOPS_BROWSER_PILOT.md) subsequently passed within their documented lifecycle limits. Before hiring use, bind the exercise to an immutable artifact, correct the administrative expiry reporting and run calibrated engineer pilots. Preserve the synthetic-only restriction until a separately reviewed assessment version is approved for that next stage.
