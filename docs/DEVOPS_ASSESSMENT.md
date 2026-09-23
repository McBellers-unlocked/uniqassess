# DevOps Engineer: two practical tasks

Status: assessment content, database migration and both platform lab integrations are installed. Kubernetes is an existing operational pilot; the dedicated AWS account and private runtime are connected, with live technical acceptance in progress. The scenario remains a draft until the guarded synthetic activation checks pass. See the [AWS deployment record](AWS_LAB_DEPLOYMENT.md). No human calibration or broad technical certification is claimed.

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

Task 2 specifies `aws-service-release-v1`: a bounded Lambda/S3/CloudWatch service, prepared Terraform and a release pipeline. Candidates must produce real plan/apply, release/rollback and permission-test evidence, investigate performance with request-level evidence, configure/test an alert and design a small partner-update extension. Draft exhibits explicitly state that synthetic telemetry is not a live result. The `awsLab` task configuration declares a required template, not cloud credentials, an endpoint or proof the runtime exists.

The two tasks sample all six priorities. AWS is the assessed cloud provider; Azure is excluded. Cluster administration, multi-region architecture, comprehensive distributed-systems design and full APM platform implementation require other evidence. The user-supplied six priorities inform this draft; no additional requirement or human approval is inferred from the terms-of-reference attachment.

## Content and marking

- [Candidate briefs and exhibits](../scripts/devops-assessment/scenario.ts) contain service contracts, purposeful labelled synthetic metrics/logs/request spans, design prompts and evidence requirements. They contain no assessor answer key or production identifiers.
- [Assessor rubrics](../scripts/devops-assessment/rubric.ts) contain component maxima, score-band anchors, alternative-solution guidance, hidden fixture defects and six explicit criterion mappings. Mark actual evidence; a completion flag or candidate assertion is not a score.
- [Scenario definition](../scripts/devops-assessment/definition.ts) records launch blockers, exclusions and provisional role evidence. No review is marked confirmed and no human reviewer is fabricated.

Task 2's answer key is provisional until checked against the actual AWS fixture. Before publication, reconcile the key and artifact names with the verified runtime, remove obsolete draft-only candidate wording, and create a new frozen version for a new cohort. Never rewrite existing candidate attempts or cohorts. Engineer trials must establish timing, marking agreement and how to handle platform failures before hiring use.

## Additive setup

Run the DB-free content check:

```powershell
node --import tsx scripts/seed-devops-assessment.ts --check
```

An authorised operator may then supply `DATABASE_URL` only in the child process environment and execute the same script without `--check`. The script creates one draft with two exhibits, two tasks, six criteria, eight task mappings and a content-addressed assessment version. It sends no invitations, creates no cohort/candidate, publishes nothing and provisions no cloud resources. It prints only non-secret IDs, content hash and status.

For live setup, use the existing authorised secret-retrieval path in memory: read the database secret/config through its SDK, construct the environment object in memory, spawn `node --import tsx scripts/seed-devops-assessment.ts`, and discard the credential. Do not put a connection string in a command argument, print it, save it in an artifact or inherit it into a browser. This script does not locate or read credential files itself.

Re-running identical setup verifies the actual persisted content and reuses the same scenario/version. Any content change, review marker, publication or attached cohort causes refusal rather than overwrite. A transaction prevents half-created authoring records. A competing identical run may win the unique slug; the loser verifies and reuses it.

## Publication prerequisites

1. Verified AWS account isolation, bounded deployment identity and resources, asynchronous jobs, durable evidence, expiry/revocation and account cleanup.
2. Actual prepared Terraform/state/project files and known-good rollback version matched to the rubric; no synthetic execution substitutes.
3. Live candidate and assessor checks across both tasks, including failed gates, denied access, rollback, metrics/alert evidence and cleanup.
4. Accountable review and engineer calibration of time, wording, difficulty and marks. Any initial cohort must be explicitly scoped as an operational/engineer pilot until this is complete.

The setup preserves these blockers. It is not a publication bypass. See [AWS lab plan](AWS_CLOUD_LAB_PLAN.md) and [Kubernetes deployment evidence](KUBERNETES_PILOT_DEPLOYMENT.md) for the underlying operational context.

## Controlled synthetic activation

After successful live AWS operator acceptance, an authorised operator may activate the exact seeded draft for two named fictional technical checks. This uses an explicitly recorded publication override; it does not record human approval. The `controlledPilot.syntheticOnly` marker blocks ordinary cohort creation, psychometric programmes and candidate imports into either frozen pilot cohort. A later editable content change cannot remove the frozen cohort's restriction. Hiring use requires a separately reviewed and calibrated version.

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
