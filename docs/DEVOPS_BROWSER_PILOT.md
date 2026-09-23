# Two-lab DevOps browser pilot

23 September 2026. **Both synthetic browser paths passed within the documented lifecycle limits below.** These are fictional platform checks, not scored candidates or human calibration. No candidate invitations were sent.

## Deployed assessment

- Scenario `cmue2g57x0000jqawq22g7zpt`, slug `devops-kubernetes-aws-practical-v1`.
- Frozen synthetic pilot version `cmue4q9wf0005jq54usvbas2a`.
- Task 1: Kubernetes recovery, 40 marks; Task 2: AWS release/recovery, 60 marks; one shared 100-minute timer.
- Criteria: Kubernetes 30, AWS 20, CI/CD 15, infrastructure as code 15, architecture 10, monitoring 10. Azure is not assessed.
- Application deployment: Amplify job 77 succeeded, main commit `782f825ff4dd925dff51d1a626a13df780a84d1c`.
- Ordinary cohort/programme creation and candidate import remain blocked for this synthetic version. Publication records an explicit technical-pilot override, not invented human approval.

## Alpha: candidate workflow and submission

Cohort `devops-two-lab-live-pilot-v1`; fictional candidate `cmue4qad10007jq545m9ymfm8`. Began at `2026-09-23T13:20:06.622Z`, with deadline `2026-09-23T15:00:06.622Z`.

Both labs were started using the live candidate interface. AWS preparation continued while the candidate switched to Kubernetes. Three Kubernetes commands completed with exit 0: diagnosis identified readiness port 8081 and a stale service selector; focused patches restored port 8080 and selector `app=checkout`; verification showed two Ready replicas, two service endpoints, and actual HTTP 200 with the expected checkout JSON. A workspace file persisted into the next command.

The first AWS browser job completed with exit 0, verified the dedicated child-account identity, ran all seven supplied tests successfully, and captured the seeded service's application-level 503 response. This is deliberately a smoke check of the broken starting fixture, not a claim that this browser attempt completed the AWS repair. The full repair/release/rollback and alarm checks are recorded separately in [AWS operator acceptance](AWS_LAB_OPERATOR_ACCEPTANCE.md).

The Kubernetes written note survived a page reload; the shared timer continued rather than resetting. Reload also confirmed the corrected Knowledge System branding. A second AWS job completed with exit 0, read the persisted marker, initialized Terraform and reported valid configuration. The page was reloaded while this job was running; recorded history and terminal output remained available.

Submission at `2026-09-23T13:31:47.900Z` replaced the workspace with the completion screen and locked both labs. The assessor displayed both written responses (96 and 123 words), the three Kubernetes and two AWS commands with output/exit status, final provider-labelled snapshots, and cleanup receipts. No scores, criterion values or review ticks were entered. The Kubernetes snapshot reached its 32,768-character retention limit and was explicitly labelled truncated; the captured deployment showed two Ready replicas. The AWS snapshot was 667 characters and untruncated.

The restricted database inspection at `2026-09-23T13:33:37.772Z` confirmed both sessions stopped, all five commands completed with exit 0, no queued/running jobs, and application cleanup receipts at `13:32:28.815Z` (Kubernetes) and `13:32:28.842Z` (AWS): 40.915 and 40.942 seconds after work lock. The AWS controller's earlier `cleanedAt` was `13:31:53.401Z`; application synchronization timestamps do not measure actual deletion duration. Independent inspection confirmed all eight exact AWS resources absent at `13:37:32.650Z` and the exact Kubernetes namespace absent at `13:37:38.831Z`; the cluster fingerprint, broker readiness and both nodes were verified. These were read-only cloud/cluster checks without controller calls or manual cleanup. These single observations are not cleanup-time guarantees.

## Beta: closed-browser expiry

Cohort `devops-two-lab-expiry-pilot-v1`; fictional candidate `cmue57uso0003jq8k6mm62pz6`; AWS session `cmue59x3g000pif1elug51yn8`. The attempt began at `2026-09-23T13:33:47.540Z`, with a six-minute deadline of `2026-09-23T13:39:47.540Z`. This shortened attempt checks expiry only; the actual assessment remains 100 minutes. The new landing page correctly described practical tasks, written deliverables and optional Knowledge System support.

A 44-word synthetic note was entered. A marker/account-identity job was queued at `13:36:16.858Z`, and the tab closed at `13:36:30.837Z` while the job was running. No Beta assessor page was open. No candidate/assessor/controller read was made between closure and the scheduled-cleanup observation.

At `13:40:53.733Z`, the restricted read-only database inspection found the AWS lab expired, its one job completed with exit 0 at `13:37:44.740Z`, no queued/running jobs, an untruncated 667-character snapshot captured at `13:39:51.415Z`, and an application cleanup receipt saved at `13:40:44.106Z` (56.566 seconds after the deadline). The controller's `cleanedAt` was `13:39:53.550Z`; the later SQL timestamp is synchronization, not actual deletion duration. Independent AWS inspection confirmed all eight exact resources absent at `13:41:24.109Z`. Neither inspection called the controller or invoked cleanup. Both proofs preceded the first page reopening.

The candidate page was reopened at `13:42:03Z` and showed assessment complete with no workspace or lab controls. The assessor subsequently displayed the autosaved 44-word note, expired AWS session, completed command with marker/account output, final snapshot and original cleanup receipt. No scores were entered.

**Administrative finalization is request-triggered.** The candidate row still said `started` with no submitted/work-locked timestamp at the pre-reopen observation. On return, `loadCandidate` recorded `submittedAt` and `workLockedAt` as `13:42:03.546Z`; the existing deadline guards already prevented new work. Therefore the assessor displayed eight minutes for a six-minute expiry test. Scheduled lab cleanup is proven independently; scheduled candidate-row submission is not claimed. Correct the stale dashboard status and deadline-based duration/submission reporting before broader hiring use. This is an existing assessment lifecycle distinction, not an extension of permitted lab time.

## Scope and remaining gates

This report distinguishes browser integration from operator-level AWS checks. It does not establish human completion time, pass criteria, predictive validity, concurrency beyond the configured capacity, a per-assessment cost, or exported-credential replay behaviour. One AWS lab may run at a time; Kubernetes has a separate capacity of two. Operator and browser evidence are complementary; the browser AWS tasks did not repeat the full release/rollback matrix.

The browser fixture source is SHA-256 `56300d49cf8a21e9f692f7f261c24e3c925ea4b5f035a9f2e506b3a753134be5`, S3 version `duITNnOVg2LmJ.l_q8DIoe_14EQzE9jx`. It differs from the operator-tested artifact only in `candidate/README.lab.md`; executable sources/tests are byte-identical. [Source comparison](../infra/aws-labs/source-artifact-evidence.json). The installed runtime ZIP remains SHA-256 `3a39ca3a4bb8fc33ebb670d68de1f731fec88b34f493f114c6e154fd2c8ebd5d`. Pin the mutable candidate source key to an immutable fixture version before hiring cohorts.

The temporary bootstrap Lambda and its exact IAM role/policy were removed at `2026-09-23T13:44:21.187Z`. Direct absence checks passed; the permanent runtime remained healthy, enabled and unchanged, reconciliation remained enabled, and the exclusive lease pool was empty. The [sanitized cleanup receipt](../infra/aws-labs/bootstrap-cleanup-evidence.json) includes both independent browser absence proofs and before/after runtime checks. The organization, dedicated account and permanent lab infrastructure remain installed. [Deployment details and operating limits](AWS_LAB_DEPLOYMENT.md).
