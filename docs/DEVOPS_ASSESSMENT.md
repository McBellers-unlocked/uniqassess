# DevOps Engineer: two practical tasks

Status: assessment content, database migration and both platform lab integrations are installed. Application deployment **Amplify build 77**, revision `782f825`, succeeded. The dedicated AWS runtime passed **24 live synthetic operator checks**, including release, rollback, monitoring and independent cleanup/expiry. Both combined browser paths passed within the lifecycle limits below: Alpha submission/assessor evidence and Beta closed-browser lab expiry, reopening and assessor evidence, with independent resource absence. Candidate administrative finalization occurs on the next candidate-page request, separately from scheduled lab expiry. The assessment is activated only for its guarded fictional pilot identities. Human assessment review and engineer calibration remain pending. See the [browser pilot evidence](DEVOPS_BROWSER_PILOT.md), [operator evidence](AWS_LAB_OPERATOR_ACCEPTANCE.md) and [AWS deployment record](AWS_LAB_DEPLOYMENT.md). No broad technical certification is claimed.

Scenario slug: `devops-kubernetes-aws-practical-v1`. Title: **DevOps Engineer — Kubernetes recovery and AWS release**. Evidence Mode; one shared **100-minute** timer, with suggested **40 minutes / 60 minutes** per task. These times require engineer calibration. No additional defence time is configured.

| Criterion | Task 1: Kubernetes recovery | Task 2: AWS release | Total |
| --- | ---: | ---: | ---: |
| Kubernetes | 30 | 0 | 30 |
| AWS | 0 | 20 | 20 |
| CI/CD | 0 | 15 | 15 |
| Infrastructure as code | 0 | 15 | 15 |
| Distributed architecture | 5 | 5 | 10 |
| Application performance monitoring | 5 | 5 | 10 |
| **Total** | **40** | **60** | **100** |

Task 1 uses `kubernetes-troubleshooting-v1`. Candidates restore checkout, retain replicas and health checks, verify service behaviour and write an incident note. A labelled synthetic outage extract adds an alert-design question, and an inventory dependency adds a small design decision about timeouts, retries and duplicate effects. Task 1 assesses proposed monitoring/design choices; it does not claim live APM installation.

Task 2 specifies `aws-service-release-v1`: a bounded Lambda/S3/CloudWatch service, prepared Terraform and a release pipeline. Candidates must produce real plan/apply, release/rollback and permission-test evidence, investigate performance with request-level evidence, configure/test an alert and design a small partner-update extension. The exhibits explicitly distinguish supplied synthetic telemetry from a candidate's live results. The `awsLab` task configuration identifies the required template; actual readiness is checked against the separate deployed runtime.

The two tasks sample all six priorities. AWS is the assessed cloud provider; Azure is excluded. Cluster administration, multi-region architecture, comprehensive distributed-systems design and full APM platform implementation require other evidence. The user-supplied six priorities inform this assessment; no additional requirement or human approval is inferred from the terms-of-reference attachment.

## Content and marking

- [Candidate briefs and exhibits](../scripts/devops-assessment/scenario.ts) contain service contracts, purposeful labelled synthetic metrics/logs/request spans, design prompts and evidence requirements. They contain no assessor answer key or production identifiers.
- [Assessor rubrics](../scripts/devops-assessment/rubric.ts) contain component maxima, score-band anchors, alternative-solution guidance, hidden fixture defects and six explicit criterion mappings. Mark actual evidence; a completion flag or candidate assertion is not a score.
- [Scenario definition](../scripts/devops-assessment/definition.ts) records launch blockers, exclusions and provisional role evidence. No review is marked confirmed and no human reviewer is fabricated.

The operator run verified a working reference repair against the actual AWS fixture, including saved Terraform plans, a failed test stopping deployment, immutable release, alarm transitions and known-good rollback. This supports the technical answer key; it does not establish scoring agreement, alternative-solution coverage or a pass standard. Guarded synthetic activation removes obsolete draft-only wording and freezes a new version while retaining the original seeded draft version. Never rewrite existing candidate attempts or cohorts. Human review and engineer trials must establish timing, marking agreement and how to handle platform failures before hiring use.

## Current verification status

The full AWS operator run retained 15 successful jobs, two independently empty lease inventories and zero cleanup failures. Ready took 88.158 and 88.785 seconds; command jobs took 37.653–122.195 seconds including startup and polling. These observations inform the pilot but do not validate the proposed 60-minute AWS allocation. Actual performance samples, including the slower first repaired request, are retained in the [operator evidence](AWS_LAB_OPERATOR_ACCEPTANCE.md).

The combined synthetic Alpha browser check completed both task flows and submitted at **13:31:47.900 UTC** on 23 September 2026. Three Kubernetes commands succeeded, recovering 2/2 Ready replicas and verifying HTTP 200. Two AWS jobs succeeded: the first ran seven unit tests and observed the expected seeded 503; the second confirmed a persisted marker and successful Terraform initialization/validation. Reload retained the written Kubernetes response and AWS job history. This AWS browser check verifies integration and persistence; the full repair/release/rollback matrix is the separate operator run above.

The assessor view displayed both submitted notes, all five successful command/job records and the retained snapshots without changing scores. The Kubernetes snapshot reached the 32,768-character limit with truncation explicitly displayed; the AWS snapshot was 667 characters and untruncated. The AWS controller recorded `cleanedAt` **13:31:53.401 UTC**; the application subsequently saved both cleanup receipts about **40.9 seconds after submission locked the work**. That later application synchronization interval is not a measured resource-deletion duration. Independent inspection subsequently found all eight exact AWS resources absent at **13:37:32.650 UTC** and the exact Kubernetes namespace absent at **13:37:38.831 UTC**, with the target cluster and broker verified. These are observation times, not measured resource-deletion instants.

The separate six-minute Beta AWS browser was closed at **13:36:30.837 UTC** while a job was running, before its **13:39:47.540 UTC** deadline. The job completed successfully at **13:37:44.740 UTC**. Scheduled lab expiry retained a snapshot at **13:39:51.415 UTC**, and the controller recorded `cleanedAt` **13:39:53.550 UTC**. The application cleanup receipt was subsequently saved at **13:40:44.106 UTC**, **56.566 seconds after the deadline**; this is application synchronization timing, not measured deletion duration. Read-only database inspection observed the expired lab and retained evidence at **13:40:53.733 UTC**, before any candidate-page or controller read. The independent helper found all eight exact AWS resources absent at **13:41:24.109 UTC** without invoking cleanup. The candidate page was reopened only after that proof, at **13:42:03 UTC**, and showed completion. The assessor then verified the autosaved 44-word note, expired AWS lab, one successful job with its marker/account output, final snapshot and original cleanup receipt. [Detailed browser evidence](DEVOPS_BROWSER_PILOT.md)

This verifies browser-independent **lab expiry**, not scheduled candidate submission. While the browser remained closed, the candidate row still had status `started`: the existing `loadCandidate` path finalized administrative `submittedAt` and `workLockedAt` at **13:42:03.546 UTC**, on the return request. Deadline gates prevented further candidate mutations and the scheduler closed the lab independently; the original cleanup receipt did not change on return. The assessor consequently displayed **8 minutes for the 6-minute attempt**, because its elapsed-time display uses the later administrative submission time. That is a reporting limitation, not an extension of the work deadline. Resolve or explicitly accommodate stale dashboard state and these administrative timestamps before broader hiring use; do not describe lab cleanup as scheduled candidate submission.

Before a human engineer pilot, bind the executable AWS fixture to an immutable key or explicit S3 version. The current source object is versioned but the runtime fetches the latest value of a mutable key. Preserve the artifact checksum and object version used for these technical checks, and include an immutable fixture reference in the separately reviewed assessment version.

## Additive setup

Run the DB-free content check:

```powershell
node --import tsx scripts/seed-devops-assessment.ts --check
```

An authorised operator may then supply `DATABASE_URL` only in the child process environment and execute the same script without `--check`. The script creates one draft with two exhibits, two tasks, six criteria, eight task mappings and a content-addressed assessment version. It sends no invitations, creates no cohort/candidate, publishes nothing and provisions no cloud resources. It prints only non-secret IDs, content hash and status.

For live setup, use the existing authorised secret-retrieval path in memory: read the database secret/config through its SDK, construct the environment object in memory, spawn `node --import tsx scripts/seed-devops-assessment.ts`, and discard the credential. Do not put a connection string in a command argument, print it, save it in an artifact or inherit it into a browser. This script does not locate or read credential files itself.

Re-running identical setup verifies the actual persisted content and reuses the same scenario/version. Any content change, review marker, publication or attached cohort causes refusal rather than overwrite. A transaction prevents half-created authoring records. A competing identical run may win the unique slug; the loser verifies and reuses it.

The initial live draft has already been seeded and then activated through the guarded synthetic path below. Do not rerun the seed to update that scenario: its refusal after activation protects existing versions and evidence. Any later reviewed assessment change requires a deliberate new version/cohort workflow.

## Publication prerequisites

1. Verified AWS account isolation, bounded deployment identity and resources, asynchronous jobs, durable evidence, expiry/revocation and account cleanup.
2. Actual prepared Terraform/state/project files and known-good rollback version matched to the rubric; no synthetic execution substitutes.
3. Live candidate and assessor checks across both tasks, including failed gates, denied access, rollback, metrics/alert evidence and cleanup.
4. Accountable review and engineer calibration of time, wording, difficulty and marks. Any initial cohort must be explicitly scoped as an operational/engineer pilot until this is complete.

The source seed preserves these blockers. The separate synthetic activation records an explicit, tightly scoped publication override for operational checks while human review/calibration remain false; it does not satisfy the hiring-use prerequisites. See [AWS lab plan](AWS_CLOUD_LAB_PLAN.md) and [Kubernetes deployment evidence](KUBERNETES_PILOT_DEPLOYMENT.md) for the underlying operational context.

## Controlled synthetic activation

After successful live AWS operator acceptance, the exact seeded draft was activated for the named fictional technical checks below. This uses an explicitly recorded publication override; it does not record human approval. The `controlledPilot.syntheticOnly` marker blocks ordinary cohort creation, psychometric programmes and candidate imports into either frozen pilot cohort. A later editable content change cannot remove the frozen cohort's restriction. Hiring use requires a separately reviewed and calibrated version. Alpha has submitted and its assessor evidence is visible; Beta's independent lab expiry has passed, with administrative finalization distinguished above.

- `devops-two-lab-live-pilot-v1`: Synthetic DevOps Pilot Alpha, `alpha@devops-pilot.example`, 100 minutes, for both candidate tasks and assessor evidence.
- `devops-two-lab-expiry-pilot-v1`: Synthetic DevOps Pilot Beta, `beta@devops-pilot.example`, 6 minutes, for closed-browser deadline verification only. Its short duration is not a proposed assessment time.

The expiry operation requires Alpha to exist and reuses exactly the same frozen assessment version. Reruns verify exact identities, one candidate per cohort, timers, mode and content hash; they do not reset status, deadlines, answers, evidence or tokens. Unexpected cohorts or candidates cause refusal. Neither operation sends invitations.

For a human engineer pilot, review a new content version with a pinned, immutable exercise artifact and record genuine subject-matter and assessment review. Remove the synthetic-only marker only from that newly reviewed version, create a new cohort and calibrate timing and marking with practising engineers before hiring use. Preserve the original frozen synthetic versions and attempts.

```powershell
node --import tsx scripts/activate-devops-pilot.ts --check
# Set DEVOPS_PILOT_ACCEPTANCE_PATH to the successful report inside .deployment.
node scripts/setup-devops-assessment.mjs pilot
node scripts/setup-devops-assessment.mjs expiry-pilot
node scripts/inspect-devops-pilot.mjs
```

The wrapper retrieves existing hosting/database configuration in memory, verifies the management account, deployment database, recovery availability and migration state, and passes the verified report path to activation. Activation requires all named live checks, both cleanup receipts and independently observed resource absence, the expected account/template and a report less than 24 hours old. It verifies actual AWS and Kubernetes readiness before any write. The inspection helper uses the restricted reconciliation database role and an explicit read-only transaction; it selects only the two fixed fictional identities and evidence status/count/timing metadata, with no command text, output text, answer content, snapshot content, token or cookie. Reading it cannot trigger cleanup, which allows closed-browser scheduled reconciliation to be observed independently.
