/** Candidate-facing assessment content. Assessor answers belong in rubric.ts only. */
import { KUBERNETES_LAB_TEMPLATE } from "../../src/lib/recruit/kubernetes-lab-config";

export const SLUG = "devops-kubernetes-aws-practical-v1";
export const TITLE = "DevOps Engineer — Kubernetes recovery and AWS release";
export const ORGANISATION = "UNIQassess";
export const POSITION_TITLE = "DevOps Engineer";
export const CONTENT_ID = "uniqassess-devops-two-labs-v1";
export const TOTAL_MINUTES = 100;

const style = `body{margin:0;color:#172033;background:#f6f8fb;font:15px/1.6 system-ui,sans-serif}main{max-width:960px;margin:auto;padding:28px}header,section{background:white;border:1px solid #dbe3ee;border-radius:12px;padding:22px;margin-bottom:18px}header{background:#132e45;color:white}h1{font-size:26px;margin:0 0 8px}h2{font-size:19px;margin:0 0 12px}h3{font-size:16px}p{margin:10px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px;border:1px solid #dbe3ee;text-align:left}th{background:#edf3f8}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef3f8;padding:14px;border-radius:8px;font:13px/1.6 ui-monospace,monospace}.note{border-left:4px solid #c9851e;padding:10px 14px;background:#fff8e8}.muted{color:#596779}header .muted{color:#cfdeeb}@media(max-width:650px){main{padding:12px}header,section{padding:16px}table{display:block;overflow:auto}}`;
function document(title: string, sourceId: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${style}</style></head><body><main><header><h1>${title}</h1><p class="muted">Source ${sourceId} · fictional service and synthetic evidence</p></header>${body}<p class="muted">All incidents, traffic, identifiers and measurements in this pack are synthetic assessment material. They are not observations from your live lab. Label supplied evidence and your own live observations separately.</p></main></body></html>`;
}

export const KUBERNETES_SOURCE_ID = "DEVOPS-K8S-INCIDENT-V1";
export const AWS_SOURCE_ID = "DEVOPS-AWS-RELEASE-V1";

export const KUBERNETES_EXHIBIT = {
  sourceId: KUBERNETES_SOURCE_ID,
  title: "Checkout incident: service contract, telemetry and dependency change",
  html: document("Checkout service incident", KUBERNETES_SOURCE_ID, `
<section><h2>1. Operations handover</h2><p>A configuration release has made checkout unavailable. Restore the existing service within your assigned namespace. The service contract requires two Ready replicas, functioning readiness and liveness checks, and HTTP 200 with the expected checkout JSON from <code>http://checkout/checkout</code>.</p><p>The approved application image and tools are already present. No external downloads are necessary. Read the actual workload configuration, events, logs and routing evidence before changing it. The live lab is the source for the repair; this pack provides background and a separate monitoring/design exercise.</p></section>
<section><h2>2. Synthetic monitoring extract</h2><p>One-minute windows for the fictional checkout service. Successful-request p95 excludes failures. A dash means no successful requests, so that latency statistic is undefined.</p><table><thead><tr><th>Window</th><th>Requests</th><th>Failures</th><th>Successful-request p95</th><th>Ready replicas</th><th>Mean pod CPU</th></tr></thead><tbody><tr><td>09:58</td><td>600</td><td>3</td><td>180 ms</td><td>2 / 2</td><td>22%</td></tr><tr><td>09:59</td><td>620</td><td>4</td><td>190 ms</td><td>2 / 2</td><td>24%</td></tr><tr><td>10:00 (release)</td><td>610</td><td>610</td><td>—</td><td>0 / 2</td><td>4%</td></tr><tr><td>10:01</td><td>600</td><td>600</td><td>—</td><td>0 / 2</td><td>3%</td></tr><tr><td>10:02</td><td>605</td><td>605</td><td>—</td><td>0 / 2</td><td>3%</td></tr></tbody></table><p>The existing alert pages only when mean CPU exceeds 80% for five minutes. Decide what this misses. Specify an actionable replacement or additional alert with metric, threshold, evaluation period, low/no-traffic handling and recovery condition. You do not have a live metrics server in this task: assess this supplied extract and provide the proposed alert rule, rather than claiming you installed it.</p></section>
<section><h2>3. Small architecture change</h2><pre>Today: caller → checkout Service → checkout pods (2 replicas)
Proposed: checkout pods → inventory reservation API</pre><p>The new inventory dependency sometimes takes 2.5 seconds or fails. The checkout response budget is 800 ms. Retried checkout requests must not reserve stock or charge twice. Provide a small annotated diagram or a clear written flow showing timeouts, retry ownership, duplicate protection and the customer-visible failure outcome. Name one trade-off and one failure test. This is a design task; the inventory API is not installed in your lab.</p></section>
<section><h2>4. Evidence to retain</h2><ul><li>Before/after observations and the reason for each repair.</li><li>Both replicas Ready, service endpoints and an actual HTTP response through the service.</li><li>Your dependency design and the proposed monitoring rule, labelled as proposals.</li></ul><p>Commands and output are retained automatically. Include concise results in your incident note so an assessor can follow your argument even when a resource snapshot is truncated.</p></section>`),
};

export const AWS_EXHIBIT = {
  sourceId: AWS_SOURCE_ID,
  title: "Order-status release: architecture, acceptance contract and performance evidence",
  html: document("Order-status service release", AWS_SOURCE_ID, `
<section class="note"><h2>Draft lab specification</h2><p>This task requires a dedicated AWS candidate lab that is not yet connected. The supplied telemetry is synthetic. Reviewing these pages does not demonstrate deployment, pipeline execution or AWS administration. The complete assessment stays in draft until the actual environment and evidence capture are verified.</p></section>
<section><h2>1. Release brief</h2><p>A release of the order-status service fails its acceptance checks. Start from a partially prepared application and deployment project. Correct the bounded configuration, run a release pipeline, prove service recovery, investigate latency and demonstrate rollback to a supplied known-good immutable version.</p><pre>Authenticated test client → stable Lambda alias → order-status Lambda version
                                              ↓ application execution role
                                       private S3 order objects
Lambda logs + metrics + request traces → CloudWatch / supplied trace view
Protected deployment runner → test → Terraform plan → apply → smoke → rollback check</pre><p>Only fictional order objects are present. The operator fixes your account, region, protected baseline and deployment identity. Your work is confined to the provided application resources. No production connection, public bucket, personal credentials or external repository is needed.</p></section>
<section><h2>2. Prepared workspace contract</h2><p>Before this task can launch, its lab must provide these real files and resources:</p><table><thead><tr><th>Artifact</th><th>Purpose</th></tr></thead><tbody><tr><td><code>app.py</code>, <code>tests/</code>, synthetic S3 order objects</td><td>Small order-status handler, unit/contract tests and fictional orders.</td></tr><tr><td><code>main.tf</code>, <code>variables.tf</code>, provider lock file and supplied state</td><td>Pinned Terraform configuration and a fixed account/region target. Review the plan before applying it.</td></tr><tr><td><code>pipeline.sh</code></td><td>Editable assessed stages run by an operator-controlled pipeline engine.</td></tr><tr><td><code>README.lab.md</code></td><td>Actual account/region, permitted resource names, job controls, test events, known-good version and support instructions. No fabricated identifiers are supplied in this pack.</td></tr><tr><td>Job log, artifact and telemetry views</td><td>Recorded tests, saved plan, application version/alias, smoke results, traces, alert evidence and rollback outcome.</td></tr></tbody></table><p>Use the lab's asynchronous job controls for Terraform and pipeline work. The Kubernetes command console is not an AWS runner and must not be used for this task.</p></section>
<section><h2>3. Acceptance contract</h2><ul><li>An authorised request for the supplied order returns the correct order ID and status. A missing order returns the documented not-found result; access errors must not be disguised as success.</li><li>The application can read only its permitted order-object prefix. An out-of-scope object read remains denied. The bucket remains private.</li><li>The pipeline stops on failed tests or an unexpected/destructive plan. Deployment and smoke checks identify the same immutable artifact and version.</li><li>The stable alias can be restored to the recorded known-good version and the same functional checks pass afterward.</li><li>The proposed service objectives are failure rate below 1% and successful-request p95 below 400 ms in the supplied steady workload. These are exercise targets, not a production SLA. Distinguish a small smoke test from evidence of sustained performance.</li></ul></section>
<section><h2>4. Synthetic five-minute telemetry</h2><p>These two extracts use the same fictional 10 requests/second workload (3,000 requests per window). The second is from a diagnostic replay after functional errors were separately cleared; it is not proof that your lab has been repaired. Successful-request latency excludes failures. Independent trace spans below are illustrative samples, not a percentile calculation.</p><table><thead><tr><th>Window</th><th>Failures</th><th>Successful p50 / p95</th><th>Throttles</th><th>Peak concurrency</th></tr></thead><tbody><tr><td>Release checks</td><td>900 / 3,000</td><td>760 / 910 ms</td><td>0</td><td>11 of limit 20</td></tr><tr><td>Diagnostic replay</td><td>0 / 3,000</td><td>755 / 905 ms</td><td>0</td><td>11 of limit 20</td></tr></tbody></table><pre>Synthetic log sample from the release checks:
request=example-041 operation=GetObject result=AccessDenied duration_ms=24
request=example-042 operation=GetObject result=OK duration_ms=247

Synthetic warm successful trace (example-042, total 780 ms):
handler/setup                  0–15 ms
S3 GetObject orders/1042.json  15–262 ms
S3 GetObject orders/1042.json  262–514 ms
S3 GetObject orders/1042.json  514–763 ms
serialize/return              763–780 ms
init_duration_ms=0; max_memory_used_mb=62; configured_memory_mb=256

Synthetic cold successful trace (example-057, total 930 ms):
init                         0–150 ms
handler + three sequential object spans 150–930 ms</pre><p>Use the live code, logs and request traces to test the leading explanations. Make one proportionate performance change, compare like-for-like before/after evidence, and state sample and cold-start limitations. Configure one useful failure or latency alert in the lab and demonstrate its signal and recovery using a bounded test. Avoid unbounded load tests.</p></section>
<section><h2>5. Small architecture change</h2><p>The service will receive duplicate and out-of-order order-status updates from a partner during bursts. Reads must continue to work when the partner is temporarily unavailable. Sketch one bounded extension with buffering, idempotency, ordering/version handling and failure recovery. Identify what remains eventually consistent, and how you would detect a stuck update. This extension is a design response, not another deployment.</p></section>
<section><h2>6. Evidence checklist</h2><p>Retain actual account/region identity checks; permission-denial and functional tests; Terraform diff, saved plan and apply result; pipeline run and immutable artifact/version; before/after telemetry; alert state changes; and known-good rollback plus post-rollback verification. Record failed experiments and unresolved risks. Label proposals and supplied synthetic data explicitly.</p></section>`),
};

const knowledgePrompt = `You are the assessment Knowledge System in Evidence Mode. Help the candidate understand supplied material and test their own reasoning. Do not draft the final deliverable or disclose assessor rubrics, planned defects or expected answers. You cannot operate the practical lab or observe its current state. Never claim a command, pipeline, deployment or test ran unless the candidate supplies its result; attribute that evidence to the candidate. Distinguish synthetic exhibit data, live observations, hypotheses and design proposals. If an environment is unavailable, say so; do not simulate successful practical evidence. Do not request credentials or suggest using a personal or production cloud account.`;

export const TASKS = [
  {
    number: 1, kind: "memo_ai", title: "Restore the Kubernetes checkout service", totalMarks: 40,
    briefMarkdown: `**Suggested time: 40 minutes. Task value: 40 marks.** The assessment has one shared 100-minute timer; this is guidance, not a separate deadline.

A configuration release has made checkout unavailable. Use the Kubernetes practical lab to diagnose and restore the existing service. Preserve two replicas and functioning health checks. Success includes two Ready replicas and an actual HTTP 200 with the expected checkout JSON from \`curl --max-time 3 -i http://checkout/checkout\`.

1. Inspect workloads, events, logs, configuration and service routing. Record the observations supporting your diagnosis.
2. Apply precise repairs and verify readiness, service endpoints and service-level behaviour. Explain any unsuccessful attempt.
3. Use the incident pack's synthetic monitoring extract to propose one actionable alert. Label this as a proposal; no live monitoring installation is required in Task 1.
4. Answer the inventory-dependency architecture change in the pack. A short annotated flow or concise written design is sufficient.

Submit an incident note covering diagnosis, changes, recovery evidence, the proposed alert, the dependency design and remaining uncertainty. Suggested length: 450–700 words; clarity and evidence matter, not writing style. Marks: Kubernetes 30, architecture 5, monitoring 5.

Start with \`kubectl get pods,deployments,services\`. Commands run in a fresh shell in /workspace; files persist, shell variables and working-directory changes do not. Use non-interactive bounded checks such as \`kubectl rollout status deployment/checkout --timeout=10s\`. A command reaching 20 seconds closes the lab. Submission or the assessment deadline also closes it. Switching task tabs does not submit the assessment. Do not enter credentials or personal data. If the platform fails, record what happened and use the assessment support route; do not claim an unobserved result.`,
    systemPrompt: knowledgePrompt,
    exhibitSourceId: KUBERNETES_SOURCE_ID,
    deliverableLabel: "Kubernetes incident note, recovery evidence and design decisions",
    deliverablePlaceholder: "Diagnosis and evidence → changes → actual recovery checks → proposed alert → inventory-dependency design → remaining uncertainty. Separate live observations from supplied synthetic evidence.",
    config: { kubernetesLab: { enabled: true, templateId: KUBERNETES_LAB_TEMPLATE.id } },
  },
  {
    number: 2, kind: "memo_ai", title: "Deploy and recover the AWS order-status service", totalMarks: 60,
    briefMarkdown: `**Suggested time: 60 minutes. Task value: 60 marks.** The assessment has one shared 100-minute timer.

**Draft: the required AWS practical environment is not yet connected. This task must not be used with candidates until the lab and its evidence capture have passed live acceptance. The exhibit is a specification and synthetic evidence pack, not a running cloud environment.**

In the prepared AWS lab, inherit a small order-status service with Terraform, tests and an incomplete release pipeline. Use the release pack and actual environment to:

1. Diagnose and correct bounded AWS configuration while retaining least privilege and private data access. Prove both intended access and a relevant denial.
2. Review and apply a focused Terraform change using the supplied state and fixed account/region. Retain the plan and apply evidence.
3. Complete and run the pipeline: tests, plan, deployment, service smoke checks and a demonstrable rollback to the known-good immutable version. Failed gates must stop a release.
4. Investigate the performance evidence, make one proportionate improvement, compare before/after results, and configure and test one useful alert.
5. Answer the partner-update architecture change in the pack as a small design extension; do not deploy that extension.

Submit a release note with evidence references, choices, unsuccessful attempts, performance findings and limitations, rollback result, design extension and remaining risk. Suggested length: 500–800 words plus concise evidence/artifact references. Marks: AWS 20, pipeline 15, infrastructure as code 15, architecture 5, monitoring 5.

Use only the supplied account and lab job controls. Do not use a personal or production AWS account, paste credentials into your note, or substitute hypothetical outputs for executed work. The Knowledge System cannot operate AWS for you.`,
    systemPrompt: knowledgePrompt,
    exhibitSourceId: AWS_SOURCE_ID,
    deliverableLabel: "AWS release note, pipeline and infrastructure evidence",
    deliverablePlaceholder: "AWS diagnosis and permission tests → Terraform plan/apply → pipeline/artifact/version evidence → performance and alert checks → rollback evidence → partner-update design → remaining risk. Distinguish executed work from proposals.",
    // Desired prerequisite, not an implementation or a runnable cloud connection.
    config: { awsLab: { enabled: true, templateId: "aws-service-release-v1" } },
  },
] as const;

export const EXHIBITS = [KUBERNETES_EXHIBIT, AWS_EXHIBIT] as const;
