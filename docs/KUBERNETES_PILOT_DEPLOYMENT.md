# Kubernetes lab pilot deployment

Status recorded on **23 September 2026**. **Deployment and technical acceptance are complete for the controlled two-lab pilot**: infrastructure, image review, application deployment, broker lifecycle/recovery, API access controls, candidate/assessor UI, closed-browser expiry, scheduled evidence collection, independent resource-removal checks and temporary bootstrap-access cleanup. The broader engineer assessment study described below is subsequent work, not part of these three synthetic tests.

This pilot provides a real Kubernetes command console attached to a written assessment. It is a batch console, not an interactive terminal: commands run in fresh shells, files persist in `/workspace`, and each command has a 20-second limit. A timeout closes the lab. The pilot is limited to **two concurrent labs**.

## Deployment record

| Component | Recorded state |
| --- | --- |
| Database | Migration `20260923120000_candidate_kubernetes_labs` applied; lab sessions and command-evidence tables added. |
| Infrastructure | CloudFormation stack `uniqassess-kubernetes-pilot` reached `UPDATE_COMPLETE`, AWS `eu-west-1`, VPC `vpc-0257c85790760a908`. One `t3.medium` control host and one `t3.large` candidate worker. |
| Isolation boundary | Dedicated assessment VPC in the existing AWS account. This is **not a separate AWS account**. The design excludes production routes and production credentials from the lab hosts. |
| Kubernetes/runtime | K3s control and worker; gVisor `runsc` release `20260914.0`. Host evidence confirms actual sandbox and gofer processes using `systrap`, plus active host network guards. |
| Worker cloud identity | Fresh EC2 inspection confirms the running worker has **no IAM instance profile**, metadata endpoint **disabled**, IPv6 metadata disabled, metadata options applied, IMDSv2 required and hop limit 1. |
| Workspace image | Final Debian Trixie/curl 8.22.0 digest: `sha256:93f17bab6f19e9c600de0202e3e58e25fa8d5441198cff7e36ee1612d96290d4`. |
| Broker image | Final digest: `sha256:8c1ec29cf62b0615c978e57f8f40195f4657c77afd7172064d681f1443b00663`. |
| Image scans | Both ECR scans complete: 0 critical, 2 high, 2 medium and 1 low findings per image. Remaining findings and component-specific observations are retained in the [infrastructure verification record](../infra/kubernetes-labs/PILOT_VERIFICATION.md#final-image-validation). |
| Runner HTTPS | Operator confirmed HTTPS at `lab-runner.uniqassess.org`. Current certificate expires **22 December 2026**; retain and verify its renewal mechanism. The runner requires server authentication. |
| Reconciliation | Stack `uniqassess-lab-reconciliation`; Lambda `uniqassess-lab-reconcile-pilot`, outside the candidate VPC. Dedicated database role `uniqassess_lab_reconciler` verified. |
| Reconciliation schedule | One-minute schedule **enabled**, stack `UPDATE_COMPLETE`, verified at 10:58:45 UTC. Enabled-worker invocation returned `examined: 1`, `failed: 0`, `deferred: 0`; Bravo's closed-session evidence and cleanup receipt reached the database. |
| Synthetic assessment | Immutable one-task pilot version, two normal candidates and one five-minute expiry candidate. Records are fictional; setup preserves attempts and evidence on rerun and sends no invitations. |
| Application | Amplify job **72 succeeded**, deploying revision **`4431c87`** and correcting public-origin checks behind Amplify. A same-origin empty request now reaches validation (HTTP 400); a foreign origin is rejected (HTTP 403). The fix passed 49 application tests, type checks and lint. Job 70's misleading IAM error came from a stale GitHub repository connection; IAM was unchanged. |
| Bootstrap access | Exact temporary worker SSH key revoked and a new connection rejected; private copy removed; temporary bootstrap IAM policy removed; bootstrap secret scheduled for deletion with a seven-day recovery window. Runner secret and management permissions retained. |

No session cookies, runner keys, database credentials or secret values belong in this report. Local `.deployment` evidence is ignored by Git; retain reviewed, sanitized results with the eventual release record.

## Checks completed

The final real-cluster isolation run **`2d748ff0be3d`** completed **43 checks, all passing**, using two disposable workspaces and the final image. It checked:

- Real exercise repair and service HTTP recovery in both namespaces.
- Candidate access to their own namespace and denial of other namespaces, system resources, nodes and secrets.
- Denial of changes to identities, roles, quotas, network controls and the candidate console pod.
- Admission rejection for privileged containers, host access, runtime/placement bypasses, unapproved images, writable roots, finalizers and external services.
- Internal DNS operation and disabled external DNS forwarding.
- Denied access to the other candidate's pod, tested node services, metadata addresses and public HTTPS; selected denied targets were separately proved reachable from the operator context.
- Removal of both test namespaces.

Host inspection separately found real `runsc`/`systrap` processes, active worker and guard services, and the intended host guard chains. These are specific observed results for this deployment, not a certification or a prediction about every failure or attack.

Control and worker service restarts preserved the cluster fingerprint, protected placement labels, runtime configuration, CoreDNS placement, external-DNS restriction and host guards. Final VPC route inspection found only the VPC-local and internet-gateway routes; temporary Docker registry login credentials were removed. See [full infrastructure observations and remaining image findings](../infra/kubernetes-labs/PILOT_VERIFICATION.md).

At 10:49:52 UTC, a live database audit using the restricted reconciliation role and an explicitly read-only transaction found **11 of 11 session columns and 12 of 12 command columns** aligned with the generated Prisma models, including names, types and nullability. Actual Prisma session/nested-command and independent command selects passed with no lab rows present yet. Bravo and the expiry candidate remained invited. This confirms persistence schema compatibility, not completed command or cleanup evidence.

Synthetic **Bravo passed the live application API suite in 22.77 seconds**. Lab readiness took 6.48 seconds in this run. The suite verified missing/mismatched-cookie denial, another candidate's token with Bravo's cookie, invalid tasks, foreign origins, persistent workspace files, stdout/stderr, nonzero exit status, exactly-once request-ID retries, conflicting command rejection, concurrent-command rejection, submission lockout and authenticated access to retained evidence. Bravo was submitted and its lab stopped; no other attempt was started or reset by the API suite.

The read-only database observations found Bravo's four commands completed, one with the deliberately nonzero exit, and no pending commands. Its final snapshot was captured at 10:57:43.817 UTC and retained at the 32,768-character limit with truncation explicitly recorded. The observation at **10:59:17 UTC** confirmed cleanup recorded at **10:58:44.180 UTC**, **62.756 seconds after submission/work lock**, with no recorded error and all four command records retained. The inspector did not invoke candidate or reconciliation APIs. Independent cluster inspection at **11:02:21.881 UTC** confirmed both Alpha and Bravo namespaces absent and both broker records stopped with no cleanup pending. Snapshot truncation is an evidence limitation to consider when reviewing final resource state. Sanitized local results: `.deployment/bravo-api-result.json`, `.deployment/pilot-database-after-bravo.json` and `.deployment/pilot-database-bravo-reconciled.json`.

**Alpha passed the live candidate-browser exercise.** The UI showed the initial zero of two Ready replicas, incorrect readiness port 8081 and service selector `checkout-previous`. After candidate-console repairs to port 8080 and selector `checkout`, it showed two of two Ready replicas and an HTTP 200 response with the expected JSON. Reload retained three command records; a fourth command verified workspace-file persistence. A 162-word incident note was sent and the assessment submitted. The observed ready interval was no more than 23 seconds, conservatively including operator interaction; it is not a provisioning benchmark.

**Alpha's assessor view passed.** It displayed the 162-word response, four completed commands with exit code zero and their outputs, the independently captured final snapshot with its truncation flag visible, and environment-removal confirmation at **11:00:09 UTC**. The snapshot was captured at approximately 10:59:25 UTC. A truncated snapshot is visible supporting evidence rather than a complete resource inventory.

The five-minute expiry candidate reached Ready and completed one command recording a synthetic marker and the initial zero-of-two Ready checkout state. Its browser tab was closed at **11:01:45.343 UTC**, ahead of the **11:05:17.453 UTC** assessment/lab deadline. No candidate API or assessor access triggered cleanup during the observation. The read-only database check at **11:06:44.052 UTC** found the lab **expired**, its command completed with exit code zero, a final snapshot captured at **11:05:19.787 UTC**, and cleanup confirmed at **11:05:44.038 UTC**: **26.585 seconds after expiry**. No pending command or error remained. Reopening the candidate page at **11:07:08 UTC**, after that proof, showed Assessment complete/Thank you and no command workspace. Evidence: `.deployment/pilot-database-expiry-reconciled.json`.

All three synthetic lab records now retain their final snapshots, cleanup receipts and **nine terminal command records**. Each final snapshot reached the 32,768-character cap and has a truncation flag. The expiry candidate's assessment row still read `started` with a past deadline at the read-only checkpoint because ordinary candidate access performs the separate lazy assessment-status transition. Its later completed page does not imply the assessment row changed exactly at the deadline; the lab deadline and cleanup had already been independently enforced.

At **11:06:54.597 UTC**, independent cluster/runner inspection confirmed the exact Alpha, Bravo and expiry namespaces absent, no active lab namespaces, the broker Ready, and expiry recorded as expired with no cleanup pending. Scheduled Lambda summaries at **11:05:44.074 UTC** and **11:06:44.124 UTC** reported respectively one and zero examined sessions, both with zero failures. These observations establish cleanup and evidence collection while the expiry browser was closed. Sanitized local evidence: `.deployment/browser-cluster-after-expiry.json` and `.deployment/browser-closed-reconciliation-summaries.json`.

| Synthetic observation | Result |
| --- | ---: |
| Bravo application lab readiness, running cluster with preloaded images | 6.48 seconds |
| Alpha browser readiness, including operator interaction | No more than 23 seconds |
| Alpha recorded command duration, four commands | Mean 1.076 seconds; maximum 1.878 seconds |
| Expiry recorded command duration, one command | 0.656 seconds |
| Alpha cleanup receipt after submission/work lock | 44.543 seconds |
| Bravo cleanup receipt after submission/work lock | 62.756 seconds |
| Closed-browser expiry cleanup receipt after deadline | 26.585 seconds |

These are individual observations, not percentiles, capacity claims or a promised service level. Command duration uses recorded execution timestamps, excluding browser interaction. Bravo's mean includes a deliberate eight-second concurrency-test sleep and is not used as an ordinary-command benchmark. Cleanup-receipt timing includes evidence propagation to the application; actual namespace absence is checked separately.

The **broker lifecycle suite passed in 109.89 seconds**: delete-before-create tombstones, idempotent starts, conflicting expiry rejection, exactly-once command retry, conflicting text and concurrent-command denial, independent 32,768-character caps on stdout/stderr, explicit stop, timeout retirement and stop during execution. All four tracked labs received cleanup confirmation. Evidence: `.deployment/live-lifecycle-evidence.json`.

The **broker recovery suite passed all three failure scenarios**: an idle lab survived restart with workspace/SQLite evidence intact; an interrupted command failed without replay and its namespace was removed; the independent janitor removed an expired lab while the broker was offline. When deletion prevented a final snapshot, unavailability was explicitly recorded. The broker was restored and all recovery-test namespaces were removed. Evidence: `.deployment/live-recovery-evidence.json`. These scenarios demonstrate the tested paths, not fault-free availability.

Evidence reviewed: sanitized isolation result, host result, infrastructure inventory, reconciliation deployment state, restricted-role invocation and the operator's fresh EC2 inspection of worker `i-0771b03a4cdc72d2c`. The fresh AWS inspection confirms metadata is disabled and the worker has no instance profile. Local deployment inventories can contain stale bootstrap values and are not authoritative for current cloud settings.

After acceptance, the operator revoked the exact bootstrap SSH key and verified rejection of a new connection before deleting its private copy. Only the temporary `LabBootstrapOnly` policy was removed and only the bootstrap secret was scheduled for deletion with a seven-day recovery window. The runner secret version and `PilotManagementOnly` policy were unchanged. The broker Secret's redundant last-applied annotation was removed without changing its data. The optional local Bravo API cookie file was removed after testing. See the [bootstrap cleanup completion record and maintenance runbook](../infra/kubernetes-labs/BOOTSTRAP_CLEANUP.md).

The durable, sanitized [acceptance evidence](../infra/kubernetes-labs/acceptance-evidence.json) combines the deployment, schema, lifecycle, recovery, candidate API/browser, database, scheduled reconciliation and exact namespace-absence observations. It contains no cookies, credentials or candidate response content.

## Technical acceptance record

- [x] Repair Amplify deployment access and deploy the intended application build.
- [x] Confirm the deployed application resolves runner configuration and reaches the authenticated live broker through its server role.
- [x] Record final workspace and broker image digests; complete and review scans after package remediation, keeping remaining findings visible.
- [x] Verify live worker metadata and instance-profile settings through EC2.
- [x] Complete final VPC route checks and remove temporary Docker registry login credentials.
- [x] Revoke the exact temporary bootstrap SSH key, remove its private copy and temporary policy, and schedule bootstrap-secret deletion while retaining runtime credentials and management access.
- [x] Exercise real repair through the application/broker; verify retained final state and namespace removal in broker acceptance tests.
- [x] Run broker lifecycle acceptance: duplicate start, changed expiry, delete-before-create, exactly-once command retry, conflicting command IDs, output truncation, command timeout and stop during execution.
- [x] Complete runner restart, independent expiry/janitor and failure-recovery checks, including persistence of evidence across interruption.
- [x] Complete live application API checks with synthetic Bravo: cookie boundaries, task/origin boundaries, command recording, retry/concurrency handling, submission lockout and authenticated access to retained evidence.
- [x] Confirm Bravo's retained command evidence, final snapshot and cleanup receipt in the application database through read-only inspection.
- [x] Complete Alpha's candidate browser exercise: start, diagnose, repair, verify HTTP recovery, refresh, written note and assessment submission.
- [x] Complete five-minute expiry with the browser closed; confirm independent lab expiry, retained evidence and cleanup receipt without candidate/assessor requests.
- [x] Run reconciliation against a real closed session and enable the one-minute schedule with a successful worker invocation.
- [x] Confirm Alpha's assessor UI displays its written response, commands, results, final snapshot, truncation flag and cleanup confirmation.
- [x] Confirm continued scheduled invocation and independent absence of all three candidate namespaces, including the browser-closed expiry test.

Prepared acceptance tools: [broker smoke test](../lab-runner/smoke.py), [broker lifecycle checks](../lab-runner/live_lifecycle.py), [Bravo application checks](../scripts/verify-kubernetes-pilot.mjs), [read-only pilot database inspection](../scripts/inspect-kubernetes-pilot.mjs), and [additive synthetic pilot setup](../scripts/seed-kubernetes-pilot.ts). A script's existence or passing syntax check does not mean its live checks have passed.

The database inspector selects only the three synthetic pilots' statuses, command counts, output lengths, snapshot presence and lifecycle timings. It uses the restricted reconciliation role in an explicitly read-only transaction; it neither expires attempts nor triggers reconciliation. Database cleanup timestamps are recorded runner receipts and must be paired with an independent check that the namespace is absent.

## Subsequent engineer assessment study

The requested technical deployment and three synthetic acceptance tests do not establish cold-start timing, p50/p95 latency, an availability SLO, peak cohort capacity, total billed cost per completed assessment, accessibility/usability with representative candidates, assessor agreement or valid hiring thresholds. Those measures require a separately planned supervised engineer pilot and longer operating/billing observations. The warm observations above are retained as the starting evidence; no unmeasured percentile or human assessment validity is claimed.

Before broader applicant use, review the task instructions, timing, interruption policy and rubric with practising engineers, and review the remaining image findings. The operational constraints remain **two concurrent labs, a single control node without high availability, truncated final snapshots, and two retained high-severity scan findings per image**.

## Operating limits and costs

This is a **single-control-node pilot with no high availability**. A control-host outage can interrupt assessments. Do not promise production availability, durable recovery, autoscaling or more than two concurrent candidates without separate evidence and an operating plan. Use a recorded interruption/rebooking policy; platform failures are not candidate competency failures.

The supplied pilot estimate is:

| Item | Estimate |
| --- | ---: |
| Control EC2 | US$0.0456/hour |
| Worker EC2 | US$0.0912/hour |
| Combined compute | **US$0.1368/hour** |
| Compute at 730 hours | **US$99.864**, approximately **US$99.86/month** |

This is a compute-only planning estimate, not a per-assessment price or total bill. EBS, public IPv4 addresses, storage, transfer, logging, secrets, reconciliation and applicable taxes are additional. Idle infrastructure continues to incur charges. Measure total attributable spend and completed/failed sessions before setting a per-candidate budget.

Keep the trusted reconciliation worker running while draining labs, even when new candidate starts are disabled. Preserve its runner URL/key access and database role until cleanup and evidence collection are confirmed. Review HTTPS renewal before 22 December, host/runtime updates, image changes, failed cleanups and scheduled-worker errors. Repeat affected live checks after relevant configuration or image changes.

## What this changes for the AWS lab

**No candidate-operated AWS cloud lab has been created.** Kubernetes is running on AWS infrastructure, but candidates do not receive an AWS account or cloud administration credentials.

The AWS design should use the measured Kubernetes preparation time, retry behaviour, cleanup delay, evidence quality, candidate experience and cost. In particular, normal Terraform and release jobs can exceed the current 20-second batch-command limit: AWS needs durable asynchronous jobs with progress, cancellation and independent cleanup.

There is no existing AWS Organizations sandbox-account pool established by this pilot. Decide how to provide dedicated candidate accounts, organizational controls, temporary permissions and account reset before building the AWS exercise. Reuse the frozen task configuration, session ownership and evidence model; test the actual AWS permission and revocation boundaries independently.

See the [AWS follow-on plan](AWS_CLOUD_LAB_PLAN.md), [candidate lab guide](KUBERNETES_LABS.md), [cluster operations](../infra/kubernetes-labs/README.md) and [reconciliation runbook](../infra/kubernetes-labs/reconciliation/README.md).
