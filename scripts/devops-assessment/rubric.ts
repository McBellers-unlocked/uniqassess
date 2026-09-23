/** Assessor-only answers, score anchors and blueprint. Never include in exhibits or AI context. */
import { AWS_SOURCE_ID, KUBERNETES_SOURCE_ID } from "./scenario";

export const TASK_RUBRICS = {
  1: {
    kubernetes: {
      max: 30,
      description: "Evidence-led Kubernetes diagnosis (10), proportionate repair preserving the service contract (10), and observed recovery (10). Award each component separately; reaching a final state alone does not prove diagnosis.",
      embedded_issues: [
        { id: "k8s_diagnosis", title: "Diagnoses workload readiness and service routing", max_marks: 10, sourceId: KUBERNETES_SOURCE_ID, expected: "Live kubernetes-troubleshooting-v1 seeds readiness on 8081 while the application listens on 8080, and service selector app=checkout-previous while pods use app=checkout. Connect actual readiness/port and selector/label/EndpointSlice evidence to both failures. Full credit does not require a prescribed command sequence." },
        { id: "k8s_repair", title: "Repairs both defects and preserves the workload contract", max_marks: 10, sourceId: KUBERNETES_SOURCE_ID, expected: "Correct the readiness target and service selector, retain two replicas and valid readiness/liveness checks, and avoid bypassing checks or unrelated destructive changes. Accept equivalent declarative or imperative repairs with a defensible rationale." },
        { id: "k8s_verify", title: "Proves service recovery with attributable live results", max_marks: 10, sourceId: KUBERNETES_SOURCE_ID, expected: "Demonstrate 2/2 Ready, service endpoint routing and HTTP 200 with checkout JSON through the service. A direct pod request alone does not prove service routing. Include before/after evidence and distinguish incomplete checks." },
      ],
      rubric: {
        "0–2 per 10-point component": "No relevant evidence, unsupported assertion, or action that defeats the component's purpose (for example deleting probes as the repair).",
        "3–5 per component": "Partial diagnosis/repair/verification: one failure understood or one relevant check, with material gaps.",
        "6–8 per component": "Both problems addressed with mostly sound evidence and a safe result; some explanation or verification is incomplete.",
        "9–10 per component": "Complete, specific, attributable evidence and justified choices; acknowledges limits and preserves the service contract.",
      },
    },
    k8s_architecture: {
      max: 5,
      description: "Designs a bounded interaction with a slow/failing inventory dependency. Score the design, not deployment of an absent service.",
      indicators: ["Fits an explicit dependency timeout within the 800 ms total budget", "Assigns retry ownership and bounds attempts/backoff; avoids retry amplification", "Explains an idempotency key and durable duplicate protection for stock/charge effects", "Defines a customer-visible failure/compensation outcome and a meaningful failure test"],
      rubric: { "0": "No design or an unsupported assertion that replicas solve the dependency failure.", "1–2": "Mentions timeouts/retries but leaves duplicate effects or the response budget unresolved.", "3–4": "Coherent timeout, bounded retry and duplicate-protection design with clear failure behaviour; one limitation or test missing.", "5": "Complete bounded flow, idempotency state/ownership, trade-off and failure test; does not claim exactly-once delivery merely from a queue or retry setting." },
    },
    k8s_monitoring: {
      max: 5,
      description: "Interprets supplied synthetic telemetry and specifies an actionable alert; live instrumentation is not part of Task 1.",
      indicators: ["Identifies complete request failure with low CPU; no-success p95 is undefined, not zero", "Uses a service failure-rate/availability signal with a request-volume guard and a readiness/no-data companion signal where justified", "Defines threshold, evaluation period, routing/action, recovery and low/no-traffic handling", "Separates the synthetic monitoring extract from the actual repaired lab"],
      rubric: { "0": "Misreads the outage as healthy because CPU is low or latency is absent; no useful alert.", "1–2": "Recognises the CPU alert gap but proposes only a vague signal or ignores missing/low-volume data.", "3–4": "Correct interpretation with a specific alert and recovery condition; a volume/no-data or operational detail is incomplete.", "5": "Accurate interpretation and a fully actionable, proportionate signal including traffic/no-data treatment, evaluation, response and recovery; labels the rule as a proposal." },
    },
  },
  2: {
    aws: {
      max: 20,
      description: "Diagnoses and safely operates the bounded AWS service: evidence-led diagnosis (8), least-privilege correction (6), functional and denied-access checks (6). Requires an actual accepted AWS lab; synthetic exhibit analysis alone earns no execution credit.",
      embedded_issues: [
        { id: "aws_diagnosis", title: "Connects AWS error evidence to the effective configuration", max_marks: 8, sourceId: AWS_SOURCE_ID, expected: "Planned fixture: the application role's GetObject resource scope does not cover the required orders/ prefix. Verify the actual provisioned defect before release. Candidate correlates identity, requested object/ARN, logs, application configuration and effective policy; distinguishes an access failure from missing data or a region/account mistake." },
        { id: "aws_permissions", title: "Applies a least-privilege application change", max_marks: 6, sourceId: AWS_SOURCE_ID, expected: "Permit only the required application GetObject prefix within the protected boundary, retaining private S3 access. Do not reward wildcard-admin, public-bucket, changed trust or deployment-identity expansion as valid repairs. Accept an equivalent bounded implementation if independently verified." },
        { id: "aws_verification", title: "Demonstrates intended behaviour and a denied boundary", max_marks: 6, sourceId: AWS_SOURCE_ID, expected: "Identify the actual sandbox account/region, invoke the service using the authorised path, validate order/status and not-found semantics, and show a meaningful out-of-scope access denial. Do not assume tests ran from prose or synthetic examples." },
      ],
      rubric: { "0–4": "No attributable AWS work, unsupported conclusions, or bypasses the required isolation/private-access contract.", "5–9": "Some useful diagnosis or operation but incomplete repair/evidence; no verified privilege boundary.", "10–15": "Mostly correct diagnosis and bounded repair, with real functional checks; one material evidence or negative-test gap.", "16–20": "Complete evidence-linked diagnosis, focused least privilege, actual intended and denied behaviour; accounts for alternate explanations and limitations. Apply the 8/6/6 component caps." },
    },
    cicd: {
      max: 15,
      description: "Creates a real, recorded release path: failed-test/plan gates (5), same-artifact deployment and smoke checks (5), verified rollback (5). Configuration review alone is not execution evidence.",
      embedded_issues: [
        { id: "pipeline_gates", title: "Demonstrates test and plan gates", max_marks: 5, sourceId: AWS_SOURCE_ID, expected: "Use the fixed engine and bounded role; prove a failing gate prevents release, and review the saved plan for unexpected/destructive changes. Preserve attributable run IDs/results." },
        { id: "pipeline_release", title: "Deploys and tests an identifiable immutable release", max_marks: 5, sourceId: AWS_SOURCE_ID, expected: "Planned incomplete pipeline needs a published immutable Lambda version, stable-alias update and smoke checks against the same deployed artifact. Verify actual fixture implementation before using this key. Preserve artifact digest/version and prevent accidental stale/$LATEST-only success." },
        { id: "pipeline_rollback", title: "Executes and verifies rollback", max_marks: 5, sourceId: AWS_SOURCE_ID, expected: "Record prior known-good immutable version, move the stable alias back and verify actual service behaviour. A written rollback plan alone is partial design credit, not a completed rollback." },
      ],
      rubric: { "0–1 per 5-point component": "Absent, hypothetical or misleading execution claims; only names a tool/stage.", "2–3 per component": "Useful configuration and some actual evidence but an important gate, artifact link or post-rollback check is missing.", "4 per component": "The component runs and its intended outcome is observed; a minor provenance/edge detail is missing.", "5 per component": "Attributable, reproducible evidence of the full component, including its failure/success boundary; no reliance on a claimed YAML stage alone." },
    },
    iac: {
      max: 15,
      description: "Produces a focused, repeatable Terraform change: appropriate code/state handling (5), reviewed saved plan (5), applied and reconciled outcome (5). Do not award these marks twice for pipeline orchestration.",
      indicators: ["Uses supplied pinned provider/state and fixed account/region; no embedded credentials or copied secrets", "Diff makes the bounded infrastructure change without gratuitous replacement, public access or protected-resource mutation", "Inspects the saved plan before applying it and explains material actions", "Relates apply evidence and a subsequent plan/state check to observed resources; explains residual drift or failure honestly"],
      rubric: { "0–3": "Only prose or unmanaged manual changes; no assessable Terraform evidence.", "4–7": "Plausible configuration/plan but weak state/target handling, no actual apply, or material unexplained changes.", "8–11": "Focused configuration and actual reviewed apply; verification or repeatability evidence is incomplete.", "12–15": "Focused diff, safe state/target handling, reviewed saved plan and attributable apply/reconciliation. Award each of code/state, plan and applied-outcome components at most 5." },
    },
    aws_architecture: {
      max: 5,
      description: "Designs a small extension for duplicate/out-of-order partner updates without blocking reads; this is a proposal, not another deployment.",
      indicators: ["Separates read availability from partner ingestion through a bounded buffer/worker flow", "Names durable event/idempotency keys and version/order conflict handling", "Explains retries, dead-letter/replay ownership and stuck-update visibility", "Identifies eventual-consistency impact and one failure test or trade-off"],
      rubric: { "0": "No coherent design or promises a queue automatically prevents all duplicate effects.", "1–2": "Adds a queue/worker but leaves duplicate, stale-update or recovery behaviour unresolved.", "3–4": "Coherent buffer, durable idempotency/version handling and recovery; a visibility/trade-off detail is incomplete.", "5": "Complete small design including consistency consequences, duplicate/out-of-order handling, stuck-work visibility and a meaningful failure test; avoids unjustified complexity." },
    },
    aws_monitoring: {
      max: 5,
      description: "Investigates latency with metrics/logs/traces and verifies a measured change plus a live alert. Two marks for interpretation/change evidence, two for a configured/tested alert, one for measurement limits.",
      embedded_issues: [
        { id: "aws_performance", title: "Uses trace evidence to test a performance hypothesis", max_marks: 2, sourceId: AWS_SOURCE_ID, expected: "Synthetic warm trace spends 748/780 ms in three serial reads of the same key; cold start adds 150 ms but does not explain warm latency. Planned handler repeats the same object read; confirm in actual code. Deduplicate per-request reads or justify an equivalent semantic-preserving change. Compare like-for-like live results and avoid treating 11/20 concurrency or 62/256 MB alone as proof of saturation." },
        { id: "aws_alert", title: "Configures and tests an operational signal", max_marks: 2, sourceId: AWS_SOURCE_ID, expected: "Show actual bounded CloudWatch/approved alarm configuration with threshold, period, missing-data handling and useful action, then a captured bounded breach and recovery. Synthetic exhibit values or a configuration proposal alone do not demonstrate a live alert." },
        { id: "aws_measurement_limits", title: "States the limits of performance evidence", max_marks: 1, sourceId: AWS_SOURCE_ID, expected: "Separate supplied synthetic samples and own runs; compare workload/version/sample size/cold-versus-warm conditions. Avoid deriving p95 from one trace or claiming a production SLO from a small smoke test." },
      ],
      rubric: { "0": "No useful interpretation or invented measurements.", "1–2": "Plausible interpretation/change proposal with limited actual proof, or a proposed alert only; apply component caps.", "3–4": "Real evidence of improvement and an actual configured/tested alert, but comparison/recovery or limits are incomplete.", "5": "Evidence-linked hypothesis, proportionate change with comparable live results, observed alarm breach/recovery and clear limitations; all three component caps met." },
    },
  },
} as const;

export const CRITERIA = [
  { code: "KUBERNETES", name: "Kubernetes diagnosis and recovery", sourceRequirement: "Kubernetes, K8s", description: "Diagnoses and repairs an existing Kubernetes workload and verifies recovery.", behaviours: ["Connects workload and routing observations to faults", "Makes safe bounded changes", "Verifies readiness and service behaviour"], mappings: [{ taskNumber: 1, marks: 30, rubricElementIds: ["kubernetes", "k8s_diagnosis", "k8s_repair", "k8s_verify"], evidence: "Attributed before/after workload, endpoint and HTTP evidence, with a justified repair retaining replicas and health checks." }] },
  { code: "AWS", name: "Bounded AWS service operation", sourceRequirement: "Public cloud providers (AWS, Azure)", description: "Operates a small AWS service with least privilege. Azure is outside this assessment's direct coverage.", behaviours: ["Checks cloud identity and target", "Diagnoses service/configuration failures", "Verifies authorised and denied access"], mappings: [{ taskNumber: 2, marks: 20, rubricElementIds: ["aws", "aws_diagnosis", "aws_permissions", "aws_verification"], evidence: "Actual sandbox identity, policy/configuration reasoning, private-access functional results and a meaningful denied permission test." }] },
  { code: "CICD", name: "Release pipeline and rollback", sourceRequirement: "CI/CD pipeline setup", description: "Completes and executes a gated release with immutable artifact identity and verified rollback.", behaviours: ["Proves gates stop unsafe releases", "Links deployed artifact to smoke checks", "Executes and verifies rollback"], mappings: [{ taskNumber: 2, marks: 15, rubricElementIds: ["cicd", "pipeline_gates", "pipeline_release", "pipeline_rollback"], evidence: "Recorded pipeline run, failure-gate demonstration, immutable artifact/version, service checks and post-rollback behaviour." }] },
  { code: "IAC", name: "Infrastructure as code", sourceRequirement: "Infrastructure as code", description: "Reviews and applies a focused Terraform change using controlled state and targets.", behaviours: ["Preserves state and target boundaries", "Explains a reviewed plan", "Verifies applied state and repeatability"], mappings: [{ taskNumber: 2, marks: 15, rubricElementIds: ["iac"], evidence: "Focused Terraform diff, provider/state handling, saved plan, apply result and subsequent reconciliation or explained drift." }] },
  { code: "ARCHITECTURE", name: "Distributed application architecture", sourceRequirement: "Infrastructure architecture of microservices and distributed applications", description: "Explains bounded dependency and asynchronous-update designs, including failure and consistency trade-offs.", behaviours: ["Budgets synchronous dependency time and retries", "Defines durable duplicate/version handling", "Explains recovery and consistency"], mappings: [{ taskNumber: 1, marks: 5, rubricElementIds: ["k8s_architecture"], evidence: "Inventory-dependency flow with timeout/retry ownership, idempotency, customer-visible failure, trade-off and test." }, { taskNumber: 2, marks: 5, rubricElementIds: ["aws_architecture"], evidence: "Partner-update flow handling duplicates/out-of-order events, read availability, recovery, visibility and consistency." }] },
  { code: "APM", name: "Application performance monitoring", sourceRequirement: "Application performance monitoring", description: "Interprets service telemetry, proposes an actionable Kubernetes alert and verifies an AWS performance change and alert.", behaviours: ["Distinguishes failure, latency, capacity and missing data", "Tests a trace-grounded performance hypothesis", "Defines and verifies useful alert behaviour"], mappings: [{ taskNumber: 1, marks: 5, rubricElementIds: ["k8s_monitoring"], evidence: "Correct interpretation of the labelled synthetic outage plus a specific proposed rule with volume/no-data treatment and recovery." }, { taskNumber: 2, marks: 5, rubricElementIds: ["aws_monitoring", "aws_performance", "aws_alert", "aws_measurement_limits"], evidence: "Trace-linked hypothesis, comparable live before/after results, configured alarm breach/recovery and explicit measurement limitations." }] },
] as const;

export const ASSESSOR_POLICY = {
  status: "draft_requires_lab_acceptance_and_engineer_calibration",
  guidance: [
    "Use retained practical evidence and the written explanation together; neither candidate-controlled output nor an automated completion flag is a score.",
    "Award partial credit against each component cap. Do not double-count Terraform engineering under pipeline orchestration, or architecture proposals as live implementations.",
    "Accept technically sound alternative commands/solutions. Score observations and reasoning, not spelling, verbosity or matching the reference syntax.",
    "Platform outages, missing artifacts and recorder failures need operational review; do not infer lack of competence from unavailable infrastructure evidence.",
    "Timing and thresholds are provisional. Have practising engineers attempt both tasks and independently mark the evidence before using results for hiring decisions.",
    "The 40/60 weighting samples six priorities within a narrow service scenario; it is not Kubernetes/AWS certification, comprehensive architecture/APM coverage or any direct Azure assessment.",
    "Task 2 hidden defects above are a proposed authoring key until the real AWS template reproduces them. Reconcile the rubric with live fixtures before publication, remove draft-only wording, then freeze a new version for a new cohort.",
  ],
};
