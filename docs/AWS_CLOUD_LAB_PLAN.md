# AWS practical lab: follow-on plan

Status: proposed; no AWS lab has been deployed. Prepared 23 September 2026.

Build and pilot the Kubernetes lab first, then use its operational and assessment evidence to choose how to deliver the AWS lab. The first AWS exercise should assess a small service deployment with Terraform, release checks and monitoring in an account reserved for that candidate. EKS, unrestricted cloud administration and production integrations are outside the first release.

## What the Kubernetes implementation has taught us

These are findings from reviewing the implementation, not results from a live candidate pilot. Successful cluster provisioning, tenant isolation, reliability, candidate usability and operating costs still need to be measured in the target environment.

| Implementation finding | Consequence for the AWS design | Evidence still needed |
| --- | --- | --- |
| A lab can be attached to an existing written task using a versioned preset. The candidate can switch between the console and their deliverable. | Reuse that task model and keep the written explanation alongside practical evidence. Freeze the AWS template version for each assessment. | Whether candidates can find the lab, understand instructions and move between evidence and writing without losing time. |
| The app sends authenticated requests to a separately configured runner. The app itself does not execute candidate shell commands. | Keep orchestration credentials outside the candidate environment and expose only a session-owned lab/job API. | Cross-session access tests, runner compromise tests and tests against the actual network configuration. |
| Requests and command results have durable IDs; retries reconcile against recorded state. | Reuse idempotent session/job creation and reconciliation. A disconnected browser must not duplicate a Terraform apply or deployment. | Lost-response, runner-restart and duplicate-request tests during real mutations. |
| Commands currently use fresh shells, persistent workspace files, a 20-second limit and bounded output. The runner closes the lab after a command times out. | Terraform and release pipelines need a separate durable asynchronous job model with progress, bounded duration, cancellation and recovery. Reusing the existing timeout unchanged would make normal cloud provisioning fail the exercise. | Actual plan/apply/build durations; whether a batch console is usable or an editor and job view are required. |
| Commands, results and final state can support human marking. Candidate-controlled output is not a trusted score. | Capture independent cloud state and release checks as well as command transcripts. Score diagnosis, decisions and verification; do not equate a green check with a complete answer. | Blind marking agreement, alternatives that deserve credit, and ways candidates can satisfy superficial checks without fixing the problem. |
| Assessment locks, runner leases and cleanup are separate responsibilities. | Submission must stop new work, revoke cloud access, preserve evidence and schedule independently retried cleanup. Browser activity cannot be the cleanup clock. | Submission/expiry races, unreachable services, partially created resources, revocation delay and complete account reset. |

Implementation references: [lab configuration](../src/lib/recruit/kubernetes-lab-config.ts), [application lifecycle](../src/lib/recruit/kubernetes-lab-service.ts), [runner](../lab-runner/runner.py), and [Kubernetes exercise](../lab-runner/exercises/kubernetes-troubleshooting-v1/README.md). These identify the implementation being evaluated; they are not a claim that its live acceptance gates have passed.

## First AWS exercise

Proposed template: `aws-service-release-v1`, initially piloted as a 45–60 minute task. Duration and pass marks must be calibrated with practising engineers.

The candidate inherits a small order-status service. A recent release fails its acceptance checks. They receive a working directory containing pinned Terraform, application code, tests, a pipeline definition, an architecture diagram and a short incident brief. The sandbox is already provisioned with account guardrails, a deployment role, an application role, a private S3 bucket and a baseline Lambda service. It contains fictional data only.

The candidate must:

1. Inspect the existing service, logs, configuration and proposed Terraform changes; identify the likely cause with evidence.
2. Repair the bounded infrastructure/application configuration and supply a safe Terraform plan. The exercise should include an incorrect S3 object prefix or IAM resource scope and a release configuration fault; publish exact seeded defects only in assessor material.
3. Run a pipeline that tests, plans, deploys a version, performs a service-level smoke test and preserves a usable rollback. Its execution must be real and recorded. A YAML review alone is recorded as a review, not proof of successful pipeline operation.
4. Demonstrate the repaired service, an appropriate failure signal in CloudWatch and a verified rollback to the supplied known-good version.
5. Explain the changes, least-privilege decision, deployment order, remaining risk and how the architecture would change under higher load or a second dependent service.

Use Lambda, S3 and CloudWatch for the initial bounded environment. Allow edits to a specific application role policy within an immutable permissions boundary; do not allow candidates to change their own deployment identity or trust relationships. Keep the public interface optional: direct authenticated invocation is sufficient initially. If an HTTP endpoint is part of the task, require `AWS_IAM` authentication and signed test requests; AWS documents the corresponding invocation permissions. [Lambda function URL access control](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)

The pipeline engine remains a phase-two decision. Evaluate a fixed sandbox pipeline project or the selected lab provider's isolated job runner. Candidates may edit the assessed pipeline files, but the engine, deployment identity and account target remain operator controlled. The engine must run with the same bounded permissions as the exercise. External GitHub connections, personal repositories and production deployment identities are not part of this first exercise.

This exercise adds practical AWS, IaC, release and monitoring evidence. It does not on its own establish expertise in multi-region architecture, network design, EKS, distributed transactions or full application performance monitoring. Assess those with complementary evidence and subsequent exercise versions.

## Account, access and cost controls

Use a pool of dedicated non-production AWS accounts in a sandbox organizational unit. Allocate one account exclusively to one active candidate lease. Keep assessment hosting, candidate records, the orchestration service and its audit storage in separate accounts with no trust path available to the candidate role. Do not load production credentials, assessment-service credentials or customer data into the lab. AWS's sandbox guidance separates sandbox accounts from a sensitive orchestration account. [Sandbox deployment accounts](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/choosing-the-deployment-account.html)

| Boundary | Initial requirement |
| --- | --- |
| Identity | Issue short-lived STS credentials only for the allocated sandbox and exercise role. Bind issuance to the active lease; stop renewal on submission/expiry. Candidate commands can inspect credentials available to their process, so assume those temporary credentials can be copied and constrain their permissions accordingly. Never expose the broker or cleanup role. |
| Services | Default-deny through the effective IAM/SCP policy set. Allow only required Lambda, S3 and CloudWatch actions, selected reads and tightly scoped application-role changes. A pipeline service is added only if selected and reviewed. Deny IAM users/access keys, Organizations administration, cross-account trust, marketplace purchases and unrelated compute/services. |
| Region | Permit one selected region after checking service availability, operating requirements and actual account quotas. Test global-service exceptions explicitly. A region condition is one part of the policy, not a complete data-location guarantee. |
| Resource scope | Restrict actions to the exercise resources, fixed names/ARNs and immutable lease ownership. Keep S3 public access blocked. Deny modification of protected logging, state, cleanup identities, boundaries and lifecycle controls. Do not rely on mutable candidate tags as the only boundary. |
| Privilege escalation | Restrict `iam:PassRole` to the application role and the intended service. Candidate-managed policies cannot exceed its protected boundary. Test resource-based policies and direct grants to role sessions as well as identity policies; boundaries alone are not a universal cap on all resource-policy grants. |
| Resource and request volume | Enforce small function concurrency, memory/runtime limits where supported, bounded artifacts/logs, pipeline job concurrency, API/job rate limits and a global cap on active leases. Protect the controls from candidate edits. IAM cannot express every desired count or size limit: inventory enforcement gaps and exclude a capability when it cannot be bounded acceptably. |
| Runtime and network | Isolate candidate execution from the app, broker, metadata credentials and internal networks. Allow only the AWS endpoints and pinned artifact sources needed for the task. Apply the same boundary to code deployed into Lambda; it must not acquire a wider execution identity. |
| Time and spending | Enforce the lease server-side and independently in the orchestrator; stop jobs and revoke access when it ends. Use budgets/alerts as a backstop alongside service restrictions, rate limits and measured usage. They are not a precise real-time spending cap. |

SCPs set available permission boundaries but do not grant permissions. AWS's SCP syntax includes region restrictions with exceptions for required global services. Evaluate the full effective policy set using real allowed and denied calls before opening the lab. [Organizations security guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/organizations-security.html), [SCP syntax and region example](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps_syntax.html)

AWS documents both permission-boundary evaluation exceptions and restricting role passing to an intended service. These are reasons to test privilege paths explicitly, rather than treating a single boundary policy as proof of isolation. [IAM permissions boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html), [IAM PassRole](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html)

AWS Budgets follows delayed billing-data updates. Measure cost exposure between detection and shutdown, including resources that continue running after access is revoked. Reserved Lambda concurrency can limit concurrent executions, but does not by itself cap total requests, storage, logs or account expenditure. [AWS Budgets update frequency](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html), [Lambda concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)

## Lease completion and account reuse

Use an explicit lifecycle: available → reserved → preparing → ready → frozen → cleaning → validating → available. Any ambiguous or failed cleanup moves the account to quarantine. A lease cannot be reset by the candidate to hide evidence; an authorised retake uses a new recorded lease.

On submission or expiry, stop admission of new work, disable credential renewal, cancel or fence running jobs, revoke existing role sessions, collect an independent final-state record and then clean the sandbox. Capture the last available evidence if a service is unreachable and mark missing evidence explicitly. Retain evidence under the assessment's existing access/retention rules, with secret redaction; do not retain reusable credentials.

Revoking a role's existing sessions does not prevent fresh sessions issued after the revocation cutoff. The orchestrator must also block renewal and reassignment until revocation and cleanup are verified. Use a lease-specific identity or an exclusive account role so revocation cannot interrupt another candidate. Measure permission propagation rather than promising instantaneous cutoff. [Revoking role sessions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html)

Do not treat `terraform destroy` as proof of a clean account. A candidate can create resources outside Terraform, change state or interrupt a job midway. Enumerate the allowed services through their own APIs, remove untracked objects and versions, inspect role policies/trust, remove application logs according to evidence retention, and compare with the protected baseline. Confirm no pending job can recreate resources. Retry a bounded number of times, then quarantine and alert the operator; never reassign an uncertain account.

AWS Innovation Sandbox offers account leasing and recycling worth evaluating as an orchestration option. Its documentation explicitly notes that Resource Explorer does not index every resource type. Select quarantine on unexpected leftovers and supplement any generic cleanup product with exercise-specific inventories. Measure cleanup coverage, cooldown, failure handling and operator effort. [Account Cleaner validation](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/account-cleaner-component.html)

Maintain a pre-provisioned account pool rather than assuming account creation/closure is instantaneous. Review the actual organization's account, creation, closure and API quotas before setting cohort capacity. Account closure is not the per-candidate reset mechanism. [AWS Organizations quotas](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_reference_limits.html)

## Phases and acceptance gates

The thresholds below are proposed acceptance targets, not observed performance or provider promises. The team should approve the pilot cohort size, peak concurrency and spending envelope before live provisioning.

| Phase | Deliverable | Gate before proceeding |
| --- | --- | --- |
| 1. Kubernetes operator validation | Deploy the Kubernetes runner in a dedicated test environment; exercise bootstrap, repair, command recording, expiry and cleanup. | Every seeded defect is reproducible. Candidate separation, forbidden network/RBAC operations, duplicate commands, disconnections, timeout and expiry tests pass. Every accepted command has a terminal record or explicit reconciliation failure. No unverified namespace is considered clean. |
| 2. Kubernetes engineer pilot | A small supervised cohort, including experienced and less-experienced engineers; independent marking and a short usability interview. | Report bootstrap p50/p95, command latency/error rates, final-evidence completeness, cleanup time/failure rate, operator intervention and cost. Review where candidates were blocked by the console or misunderstood the problem. Resolve score disagreements and instruction ambiguity before selecting AWS tooling. |
| 3. AWS design and provider comparison | The bounded exercise, policy matrix, account/job lifecycle and comparison of a managed lab provider with AWS account-pool orchestration. | Both options demonstrate exclusive account allocation, temporary access, transcript/artifact export, forced expiry, denied escalation and verified cleanup. Compare actual quotes/usage and support effort. Any vendor proof uses the same exercise and abuse tests. Select an option only when its evidence supports the required controls. |
| 4. AWS internal prototype | Asynchronous jobs, exclusive account leasing, scoped credentials, pinned exercise artifacts, assessor snapshots and cleanup reconciliation. | Proposed prewarmed bootstrap p95 ≤120 seconds; report cold starts separately. Run at least 20 complete lifecycle trials, including injected failures. No accepted mutation lost or duplicated; no cross-candidate or assessment-service access. Failed cleanup always quarantines. Record time from lease end to effective access denial and to verified reset. |
| 5. AWS assessment pilot | Supervised candidate tasks, realistic peak-concurrency test and cost reconciliation after billing data settles. | Meet the agreed concurrency and cost envelope without borrowing production capacity. No unexplained scoring failures, evidence gaps or account reuse failures. Set final duration and pass criteria from engineer performance and blind marking. Define the operator response and candidate accommodation for infrastructure failures. |
| 6. Controlled release | Feature flag, bounded cohort size, capacity reservation, alerts, operator runbook and retake policy. | Named operational owner; tested stop switch and quarantine recovery; capacity available before candidate invitations; measured support/cost acceptable. Broaden services or add AWS Console access only through a new reviewed exercise version. |

Include these fault/abuse cases in the live validation matrix: replayed request IDs; simultaneous starts; another candidate's session/account identifiers; altered account/region targets; role chaining and PassRole escalation; attempts to remove a boundary or disable logging; public/cross-account resource grants; excessive invocation/logging/storage; background work after timeout; copied credentials after submission; edited Terraform state; deletion protection or versioned objects obstructing cleanup; orchestrator restart; partially failed apply; missing final snapshot; and resources reappearing after a nominal cleanup.

For candidate fairness, separate a platform outage from a candidate's technical mistake. Record lost lab time and the reason for an operator-authorised retake. Do not change a running assessment's timer or infer a failed competency silently. The current Kubernetes timeout policy is one specific item to evaluate before carrying it into AWS.

## Measurements that decide the provider and rollout

Keep a single pilot scorecard for both Kubernetes and AWS. Report sample size and failures alongside percentiles; a small cohort does not establish production reliability.

| Measurement | How to collect it | Decision it informs |
| --- | --- | --- |
| Bootstrap and responsiveness | Time from accepted start to a verified usable environment; cold/warm p50/p95; queued versus running job time. | Prewarming, reserved capacity and whether the assessment timer needs an explicit preparation stage. |
| Cleanup and reuse | Lease end, effective credential denial, last workload stopped, final evidence saved, inventory verification and account available timestamps; quarantine counts. | Pool size, reset policy and operational staffing. |
| Concurrency | Simulate the agreed cohort peak plus a documented burst; record AWS throttling, runner queues and rejected starts. | Safe invitation limits and admission controls. |
| Recording | Compare accepted request IDs, job logs, artifacts and independent cloud state across retries/restarts. Include truncation, redaction and missing-data counts. | Whether assessors have complete, attributable evidence. |
| Assessment quality | Completion time, infrastructure-caused lost time, ambiguous instructions, observed alternatives, blind marking agreement and candidate feedback. | Exercise scope, editor/console design, rubric, timing and pass standard. |
| Cost | Per-account/service usage, direct session cost, idle-pool allocation, orchestration/logging/storage, cleanup failures and operator time; reconcile after billing data settles. | Managed-provider versus owned-orchestration choice and permitted cohort size. |

Calculate cost per completed assessment using total attributable lab cost divided by completed sessions, and report failed/abandoned sessions separately so their cost is not hidden. Obtain current regional AWS prices or a dated provider quote when building the pilot budget. This plan assumes neither free-tier eligibility nor a fixed per-session price.

The next AWS implementation decision should therefore follow the Kubernetes pilot report: choose the runtime/job experience, publish the measured security and cleanup evidence, agree the cost/capacity envelope, and then implement the first AWS template. This document does not provision cloud resources or authorise an account cleanup operation.
