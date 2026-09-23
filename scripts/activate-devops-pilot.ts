/**
 * Guarded activation of the already-seeded exact DevOps draft for named synthetic
 * browser pilot. Never invites a human or claims human review/calibration.
 * Prepare: --check. Execute only after root has confirmed live AWS acceptance.
 * DATABASE_URL and DEVOPS_PILOT_ACCEPTANCE_PATH are supplied by the operator.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { hashScenarioSnapshot, loadScenarioContentSnapshot } from "../src/lib/recruit/scenario-content-hash";
import { runDeterministicChecks } from "../src/lib/recruit/validation/deterministic";
import { createAwsRunnerTransport } from "../src/lib/recruit/aws-lab-runner";
import { awsLabPublicationIssues } from "../src/lib/recruit/aws-lab-config";
import { createRunnerSettingsResolver } from "../src/lib/recruit/kubernetes-lab-runner";
import { generateToken, indexToAnonymousId } from "../src/lib/recruit/tokens";
import { DEFINITION_HASH } from "./devops-assessment/definition";
import { assertPilotCohortScope, PILOTS, PILOT_SCENARIO, PILOT_SLUG } from "./devops-assessment/pilot-scope";

const SCENARIO = PILOT_SCENARIO;
const DRAFT_VERSION = "cmue2g7eh0010jqawkvww3ijp";
const DRAFT_DEFINITION_HASH = "23e11a744d2512fc513a38c5c57e6211e5d43fd65e3a2b97fc2b7b90b6282ec0";
const SLUG = PILOT_SLUG;
const COHORT = PILOTS.alpha.id;
const RUNNER_ARN = "arn:aws:lambda:eu-west-1:891612540396:function:uniqassess-aws-lab-runner";
const K8_SECRET = "arn:aws:secretsmanager:eu-west-1:891612540396:secret:uniqassess/labs/pilot/runner-E7D6ZY";
const OVERRIDE = "[SYNTHETIC OPERATOR PILOT ONLY; AUTOMATED SETUP AT THE USER'S REQUEST] The two-task content is published solely for the named synthetic Alpha browser/assessor pilot and separate six-minute Beta closed-browser expiry verification. Live AWS operator acceptance and the existing Kubernetes technical pilot are verified, and deterministic content checks pass. This is an explicit controlled-pilot publication override, not subject-matter, assessment-design, accessibility, hiring-manager or psychometric approval. Human reviews, engineer timing/marking calibration and hiring-use readiness remain incomplete. No human invitations are sent by this operation.";
class PilotError extends Error {}
let prisma: PrismaClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

type Acceptance = { runId: string; finishedAt: string; checks: Array<{ name: string; passed: boolean }> };
async function acceptance() {
  const supplied = process.env.DEVOPS_PILOT_ACCEPTANCE_PATH;
  if (!supplied) throw new PilotError("DEVOPS_PILOT_ACCEPTANCE_PATH must identify the successful live operator acceptance report.");
  const path = await realpath(resolve(supplied));
  const inside = relative(await realpath(resolve(process.cwd(), ".deployment")), path);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new PilotError("The acceptance report must be an operator artifact inside this workspace's .deployment directory.");
  const text = await readFile(path, "utf8");
  const value = JSON.parse(text);
  const required = ["controller and independent helper ready", "second simultaneous account lease denied", "initial", "duplicate request reused; changed payload denied", "boundary", "performanceBaseline", "failedGate", "release", "functional", "alarmPrimed", "alarmBreach", "alarmRecovery", "rollback", "final", "closed lease denies new work", "automatic expiry independent of browser/controller reads"];
  if (value.passed !== true || value.managementAccount !== "891612540396" || value.sandboxAccount !== "689324611808"
    || value.templateId !== "aws-service-release-v1" || !/^[a-f0-9]{16}$/.test(value.runId)
    || !Array.isArray(value.checks) || required.some((name) => !value.checks.some((check: { name?: string; passed?: boolean }) => check.name === name && check.passed === true))
    || !Array.isArray(value.leases) || value.leases.length !== 2 || value.leases.some((lease: { cleanup?: { observed?: { allAbsent?: boolean }; receipt?: { cleanupComplete?: boolean } } }) => lease.cleanup?.observed?.allAbsent !== true || lease.cleanup?.receipt?.cleanupComplete !== true)
    || !Number.isFinite(Date.parse(value.finishedAt)) || Date.now() - Date.parse(value.finishedAt) > 24 * 60 * 60_000
    || Date.parse(value.finishedAt) > Date.now() + 60_000) throw new PilotError("The acceptance report is incomplete, unsuccessful, outside the expected accounts/template, or older than 24 hours.");
  return { report: value as Acceptance, sha256: createHash("sha256").update(text).digest("hex") };
}

async function runtimeChecks() {
  const aws = createAwsRunnerTransport({ environment: () => ({ AWS_LABS_ENABLED: "true", AWS_LAB_RUNNER_FUNCTION_ARN: RUNNER_ARN, APP_REGION: "eu-west-1" }) });
  if (!await aws.resolveRunnerSettings()) throw new PilotError("The actual AWS controller did not report the required enabled, ready template.");
  const kubernetes = await createRunnerSettingsResolver({ environment: () => ({
    NODE_ENV: "production", APP_REGION: "eu-west-1", KUBERNETES_LABS_ENABLED: "true", KUBERNETES_LAB_CONFIG_SECRET_ARN: K8_SECRET,
  }) })();
  if (!kubernetes || kubernetes.url !== "https://lab-runner.uniqassess.org") throw new PilotError("The existing Kubernetes runner configuration is not enabled and valid.");
  const response = await fetch(`${kubernetes.url}/v1/labs/cdevopspilotreadiness0000000`, {
    headers: { Authorization: `Bearer ${kubernetes.key}` }, signal: AbortSignal.timeout(8_000), redirect: "error",
  });
  if (response.status !== 404) throw new PilotError("The Kubernetes authenticated read-only readiness probe did not return the expected missing synthetic session.");
}

async function candidateToken() {
  for (let i = 0; i < 25; i++) {
    const token = generateToken("DVP");
    if (!await prisma.recruitmentCandidate.findUnique({ where: { token }, select: { id: true } })) return token;
  }
  throw new PilotError("Could not allocate a unique synthetic token.");
}

async function activate() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--check", "--execute", "--execute-expiry"].includes(args[0])) throw new PilotError("Use --check, --execute or --execute-expiry; no reset or human invitation operation is supported.");
  const expiry = args[0] === "--execute-expiry";
  const target = expiry ? PILOTS.expiry : PILOTS.alpha;
  if (DEFINITION_HASH !== DRAFT_DEFINITION_HASH) throw new PilotError("Source draft content changed since live seeding. Review the explicit activation patch before proceeding.");
  if (args[0] === "--check") {
    console.log(JSON.stringify({ preparedOnly: true, cloudCallsMade: false, databaseWrites: false, scenarioId: SCENARIO, draftVersionId: DRAFT_VERSION, pilots: Object.values(PILOTS).map(({ id, minutes }) => ({ cohortId: id, minutes, candidates: 1 })), taskMarks: [40, 60], expiryRequiresAlpha: true, resetsExistingAttempts: false, humanInvitations: 0, formallyApproved: false }, null, 2));
    return;
  }
  const accepted = await acceptance();
  await runtimeChecks();
  if (!process.env.DATABASE_URL) throw new PilotError("An operator-supplied DATABASE_URL is required.");
  ({ prisma } = await import("../src/lib/prisma"));
  const [row, snapshot, draft] = await Promise.all([
    prisma.recruitmentScenario.findUnique({ where: { id: SCENARIO }, include: { _count: { select: { assessments: true } } } }),
    loadScenarioContentSnapshot(SCENARIO),
    prisma.recruitmentAssessmentVersion.findUnique({ where: { id: DRAFT_VERSION } }),
  ]);
  if (!row || !snapshot || !draft || row.slug !== SLUG || draft.scenarioId !== SCENARIO || !row.createdById) throw new PilotError("The exact seeded DevOps draft and owner were not found.");
  const owner = await prisma.user.findUnique({ where: { id: row.createdById }, select: { role: true } });
  if (owner?.role !== "ADMIN") throw new PilotError("The draft owner is not an existing administrator.");
  const currentRole = snapshot.roleEvidenceRecord as Record<string, unknown> | null;
  const existingPilot = currentRole?.controlledPilot as { cohortId?: string; syntheticOnly?: boolean; formallyApproved?: boolean; acceptanceRunId?: string; acceptanceSha256?: string } | undefined;
  const repeat = row.status === "published" && !!row.publishedAt && existingPilot?.cohortId === COHORT
    && existingPilot.syntheticOnly === true && existingPilot.formallyApproved === false && existingPilot.acceptanceRunId === accepted.report.runId
    && existingPilot.acceptanceSha256 === accepted.sha256;
  if (expiry && !repeat) throw new PilotError("The exact accepted Alpha pilot must already be activated before creating the expiry pilot.");
  if (!repeat && (row.status !== "draft" || row.publishedAt || row._count.assessments || row.roleEvidenceReviewedAt || row.roleEvidenceReviewedById || hashScenarioSnapshot(snapshot) !== draft.scenarioHash)) throw new PilotError("The original draft changed, was reviewed, published or assigned. No existing work was modified.");
  const finalSnapshot = structuredClone(snapshot);
  if (!repeat) {
    const task = finalSnapshot.tasks.find((value) => value.number === 2);
    const firstTask = finalSnapshot.tasks.find((value) => value.number === 1);
    const exhibit = finalSnapshot.exhibits.find((value) => value.sourceId === "DEVOPS-AWS-RELEASE-V1");
    if (!task || !firstTask || !exhibit || !task.briefMarkdown.includes("**Draft: the required AWS practical environment is not yet connected.")) throw new PilotError("The expected draft-only wording was not found; review the patch.");
    task.briefMarkdown = task.briefMarkdown.replace(/\*\*Draft: the required AWS practical environment is not yet connected\.[\s\S]*?\*\*/, "**Controlled technical pilot using fictional data. Operate only your assigned AWS sandbox. This synthetic attempt checks the platform and is not used for a hiring decision.**");
    firstTask.briefMarkdown = "**Controlled technical pilot using fictional data. This synthetic attempt is not used for a hiring decision.**\n\n" + firstTask.briefMarkdown;
    exhibit.html = exhibit.html.replace(/<section class="note"><h2>Draft lab specification<\/h2>[\s\S]*?<\/section>/, '<section class="note"><h2>Controlled technical pilot</h2><p>Use the connected dedicated AWS lab. This is fictional assessment work for an operational browser pilot. The supplied telemetry remains synthetic; retain and label your own actual deployment, pipeline, permission and monitoring evidence separately.</p></section>')
      .replace("Before this task can launch, its lab must provide these real files and resources:", "Your assigned lab provides these files and resources:");
    const previousRole = finalSnapshot.roleEvidenceRecord as Record<string, unknown>;
    finalSnapshot.roleEvidenceRecord = json({ ...previousRole, reviewed: false,
      launchReadiness: { status: "controlled_pilot_only", blockers: [{ code: "ASSESSMENT_ENGINEER_CALIBRATION_PENDING", message: "Human review, engineer timing/marking calibration and hiring-use readiness remain incomplete." }] },
      controlledPilot: { cohortId: COHORT, allowedCohortIds: [COHORT, PILOTS.expiry.id], syntheticOnly: true, formallyApproved: false, acceptanceRunId: accepted.report.runId, acceptanceSha256: accepted.sha256, acceptanceCompletedAt: accepted.report.finishedAt, reason: OVERRIDE },
    }) as Prisma.JsonValue;
  }
  const checks = runDeterministicChecks(finalSnapshot);
  if (checks.checks.some((check) => !check.passed) || awsLabPublicationIssues(finalSnapshot.tasks, true).length) throw new PilotError("Content structure or the AWS template configuration fails the hard publication checks.");
  if (finalSnapshot.tasks.map((task) => task.totalMarks).join(",") !== "40,60" || finalSnapshot.criteria.length !== 6) throw new PilotError("Unexpected assessment scoring structure.");
  const finalHash = hashScenarioSnapshot(finalSnapshot);
  const minted = await candidateToken();
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM recruitment_scenarios WHERE id = ${SCENARIO} FOR UPDATE`;
    const locked = await tx.recruitmentScenario.findUnique({ where: { id: SCENARIO }, select: { status: true, updatedAt: true } });
    if (!locked || locked.updatedAt.getTime() !== row.updatedAt.getTime() || locked.status !== row.status) throw new PilotError("The scenario changed during activation; retry only after review.");
    const existingCohorts = await tx.recruitmentAssessment.findMany({ where: { OR: [
      { customScenarioId: SCENARIO }, { scenarioSlug: SLUG }, { id: { in: [COHORT, PILOTS.expiry.id] } },
    ] }, include: { candidates: { select: { name: true, email: true, anonymousId: true } }, assessmentVersion: true } });
    if (!repeat && existingCohorts.length) throw new PilotError("A cohort was attached before first activation; no changes are permitted.");
    const originalAlpha = existingCohorts.find((cohort) => cohort.id === COHORT);
    if (repeat) {
      const version = originalAlpha?.assessmentVersion;
      if (!version || version.scenarioId !== SCENARIO || version.scenarioHash !== finalHash
        || hashScenarioSnapshot(version.scenarioSnapshot) !== finalHash) throw new PilotError("The current content differs from Alpha's frozen pilot version; no new version or attempt is created.");
      try { assertPilotCohortScope(existingCohorts, version.id, true); }
      catch (error) { throw new PilotError((error as Error).message); }
    }
    if (!repeat) {
      for (const task of finalSnapshot.tasks) await tx.recruitmentScenarioTask.update({ where: { id: task.id }, data: { briefMarkdown: task.briefMarkdown } });
      for (const exhibit of finalSnapshot.exhibits) await tx.recruitmentScenarioExhibit.update({ where: { id: exhibit.id }, data: { html: exhibit.html } });
      await tx.recruitmentScenario.update({ where: { id: SCENARIO }, data: { roleEvidenceRecord: json(finalSnapshot.roleEvidenceRecord), status: "published", publishedAt: now } });
      await tx.recruitmentScenarioPublicationOverride.create({ data: { scenarioId: SCENARIO, scenarioHash: finalHash, reason: OVERRIDE, userId: row.createdById! } });
      await tx.recruitmentScenarioValidationRun.create({ data: {
        scenarioId: SCENARIO, scenarioHash: finalHash, assessmentMode: "EVIDENCE", status: "COMPLETED",
        progressStage: "Deterministic content checks and live runtime acceptance verified for synthetic pilot",
        overallReadiness: "CONTROLLED_PILOT_ONLY", promptVersion: "operator-deterministic-v1", model: "none — deterministic operator checks",
        scenarioSnapshot: json(finalSnapshot), deterministicChecks: json(checks.checks), findings: [], criterionCoverage: json(checks.blueprint),
        syntheticProfiles: [], policyTests: json({ liveAcceptanceRunId: accepted.report.runId, acceptanceSha256: accepted.sha256, formallyApproved: false }),
        summary: "Deterministic checks only plus referenced live operator acceptance. No model validation or human review was performed by this script.",
        createdById: row.createdById!, startedAt: now, completedAt: now,
      } });
    }
    const version = await tx.recruitmentAssessmentVersion.upsert({
      where: { scenarioId_scenarioHash: { scenarioId: SCENARIO, scenarioHash: finalHash } }, update: {},
      create: { scenarioId: SCENARIO, scenarioHash: finalHash, label: `${finalSnapshot.title} · synthetic pilot · ${finalHash.slice(0, 8)}`, scenarioSnapshot: json(finalSnapshot), assessmentMode: "EVIDENCE", modePolicyVersion: finalSnapshot.modePolicyVersion, createdById: row.createdById! },
    });
    const cohort = await tx.recruitmentAssessment.upsert({ where: { id: target.id }, update: {}, create: {
      id: target.id, title: target.title, scenarioSlug: SLUG, scenarioId: SLUG, customScenarioId: SCENARIO,
      totalMinutes: target.minutes, openDate: new Date(now.getTime() - 60_000), closeDate: new Date(now.getTime() + 24 * 60 * 60_000),
      createdById: row.createdById!, assessmentMode: "EVIDENCE", modePolicyVersion: finalSnapshot.modePolicyVersion,
      defenceEnabled: false, assessmentVersionId: version.id,
    } });
    const candidate = await tx.recruitmentCandidate.upsert({
      where: { assessmentId_email: { assessmentId: target.id, email: target.email } }, update: {},
      create: { assessmentId: target.id, name: target.name, email: target.email, token: minted, anonymousId: indexToAnonymousId(0), status: "invited" },
    });
    const candidates = await tx.recruitmentCandidate.findMany({ where: { assessmentId: target.id }, select: { name: true, email: true, anonymousId: true } });
    try { assertPilotCohortScope([{ ...cohort, candidates }], version.id, !expiry); }
    catch (error) { throw new PilotError((error as Error).message); }
    return { versionId: version.id, candidateId: candidate.id, token: candidate.token };
  }, { timeout: 30_000 });
  console.log(JSON.stringify({ scenarioId: SCENARIO, cohortId: target.id, ...result,
    candidateUrl: `https://www.uniqassess.org/assess/${SLUG}?token=${result.token}`,
    assessorUrl: `https://www.uniqassess.org/admin/recruitment/${target.id}/mark/${result.candidateId}`,
    totalMinutes: target.minutes, expiryVerificationOnly: expiry, taskMarks: [40, 60], syntheticOnly: true, formallyApproved: false, invitationsSent: 0,
  }, null, 2));
}

activate().catch((error: unknown) => {
  console.error(error instanceof PilotError ? error.message : error instanceof Prisma.PrismaClientKnownRequestError
    ? `Synthetic pilot activation failed with database code ${error.code}; existing attempts were not reset.`
    : "Synthetic pilot activation failed; no credentials or raw service errors were logged.");
  process.exitCode = 1;
}).finally(async () => prisma?.$disconnect());
