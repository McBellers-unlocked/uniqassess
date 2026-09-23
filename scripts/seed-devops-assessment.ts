/**
 * Additive, fail-closed authoring setup. Creates one DRAFT and its frozen version.
 * No cohort, candidate, invitation, publication, reset or cloud mutation occurs.
 * DATABASE_URL must be supplied by the operator in the process environment.
 * Check content without connecting: node --import tsx scripts/seed-devops-assessment.ts --check
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalJson, hashScenarioSnapshot } from "../src/lib/recruit/scenario-content-hash";
import { runDeterministicChecks } from "../src/lib/recruit/validation/deterministic";
import { DEFINITION, DEFINITION_HASH, validationSnapshot } from "./devops-assessment/definition";

class SetupError extends Error {}
// The DB-free --check path must not initialise a client or require credentials.
let prisma: PrismaClient;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function findExisting() {
  return prisma.recruitmentScenario.findUnique({
    where: { slug: DEFINITION.slug },
    include: {
      exhibits: true,
      tasks: { orderBy: { number: "asc" } },
      criteria: { orderBy: { order: "asc" }, include: { taskMappings: { include: { task: { select: { number: true } } } } } },
      _count: { select: { assessments: true } },
    },
  });
}

function assertUnchanged(existing: NonNullable<Awaited<ReturnType<typeof findExisting>>>) {
  const numberById = new Map(existing.tasks.map((task) => [task.id, task.number]));
  const sourceById = new Map(existing.exhibits.map((exhibit) => [exhibit.id, exhibit.sourceId]));
  const actual = {
    slug: existing.slug, title: existing.title, organisation: existing.organisation, positionTitle: existing.positionTitle,
    defaultTotalMinutes: existing.defaultTotalMinutes, status: existing.status, publishedAt: existing.publishedAt,
    assessmentMode: existing.assessmentMode, modePolicyVersion: existing.modePolicyVersion,
    defenceEnabled: existing.defenceEnabled, defenceQuestionCount: existing.defenceQuestionCount, defenceMinutes: existing.defenceMinutes,
    roleEvidenceRecord: existing.roleEvidenceRecord,
    exhibits: DEFINITION.exhibits.map((expected) => {
      const found = existing.exhibits.find((exhibit) => exhibit.sourceId === expected.sourceId);
      return found ? { sourceId: found.sourceId, title: found.title, html: found.html } : null;
    }),
    tasks: existing.tasks.map((task) => ({
      number: task.number, kind: task.kind, title: task.title, totalMarks: task.totalMarks,
      briefMarkdown: task.briefMarkdown, systemPrompt: task.systemPrompt,
      exhibitSourceId: task.exhibitId ? sourceById.get(task.exhibitId) : null,
      deliverableLabel: task.deliverableLabel, deliverablePlaceholder: task.deliverablePlaceholder,
      config: task.config, rubric: task.rubric,
    })),
    criteria: existing.criteria.map((criterion) => ({
      code: criterion.code, name: criterion.name, description: criterion.description,
      sourceRequirement: criterion.sourceRequirement, observableBehaviours: criterion.observableBehaviours,
      roleEvidence: criterion.roleEvidence, order: criterion.order,
      taskMappings: criterion.taskMappings.map((mapping) => ({
        taskNumber: numberById.get(mapping.taskId), expectedCandidateEvidence: mapping.expectedCandidateEvidence,
        rubricElementIds: mapping.rubricElementIds, marks: mapping.marks,
      })).sort((a, b) => (a.taskNumber ?? 0) - (b.taskNumber ?? 0)),
    })),
  };
  if (existing._count.assessments || existing.exhibits.length !== DEFINITION.exhibits.length
    || existing.roleEvidenceReviewedAt || existing.roleEvidenceReviewedById
    || hashScenarioSnapshot(actual) !== DEFINITION_HASH) {
    throw new SetupError("Existing DevOps content differs, has been reviewed, or is attached to a cohort. No records changed. Review it in the editor or author an explicit new version; this setup never overwrites work.");
  }
}

async function createDraft(adminId: string) {
  return prisma.$transaction(async (tx) => {
    const scenario = await tx.recruitmentScenario.create({ data: {
      slug: DEFINITION.slug, title: DEFINITION.title, organisation: DEFINITION.organisation,
      positionTitle: DEFINITION.positionTitle, defaultTotalMinutes: DEFINITION.defaultTotalMinutes,
      status: "draft", publishedAt: null, createdById: adminId,
      assessmentMode: "EVIDENCE", modePolicyVersion: DEFINITION.modePolicyVersion,
      defenceEnabled: false, defenceQuestionCount: 2, defenceMinutes: 5,
      roleEvidenceRecord: json(DEFINITION.roleEvidenceRecord),
    } });
    const exhibitBySource = new Map<string, string>();
    for (const definition of DEFINITION.exhibits) {
      const exhibit = await tx.recruitmentScenarioExhibit.create({ data: { scenarioId: scenario.id, ...definition } });
      exhibitBySource.set(definition.sourceId, exhibit.id);
    }
    const taskByNumber = new Map<number, string>();
    for (const definition of DEFINITION.tasks) {
      const { exhibitSourceId, config, rubric, ...fields } = definition;
      const exhibitId = exhibitBySource.get(exhibitSourceId);
      if (!exhibitId) throw new SetupError("A required DevOps exhibit is missing.");
      const task = await tx.recruitmentScenarioTask.create({ data: {
        scenarioId: scenario.id, ...fields, exhibitId, config: json(config), rubric: json(rubric),
      } });
      taskByNumber.set(definition.number, task.id);
    }
    for (const definition of DEFINITION.criteria) {
      const { taskMappings, observableBehaviours, roleEvidence, ...fields } = definition;
      await tx.recruitmentScenarioCriterion.create({ data: {
        scenarioId: scenario.id, ...fields, observableBehaviours: json(observableBehaviours), roleEvidence: json(roleEvidence),
        taskMappings: { create: taskMappings.map(({ taskNumber, rubricElementIds, ...mapping }) => {
          const taskId = taskByNumber.get(taskNumber);
          if (!taskId) throw new SetupError("A DevOps criterion references a missing task.");
          return { ...mapping, taskId, rubricElementIds: json(rubricElementIds) };
        }) },
      } });
    }
    return scenario;
  }, { timeout: 30_000 });
}

async function seed() {
  const args = process.argv.slice(2);
  if (args.length && canonicalJson(args) !== canonicalJson(["--check"])) throw new SetupError("Only --check is supported; reset, publication and cohort creation are not available.");
  const checks = runDeterministicChecks(validationSnapshot());
  // Runtime readiness is an intentional blocker. Structural/content failures are not.
  const failed = checks.checks.filter((check) => !check.passed && !["aws-lab-readiness"].includes(check.id));
  if (failed.length) throw new SetupError(`DevOps content checks failed: ${failed.map((check) => check.id).join(", ")}.`);
  if (args[0] === "--check") {
    console.log(JSON.stringify({ status: "draft", definitionHash: DEFINITION_HASH, minutes: 100, taskMarks: [40, 60], criteria: 6, checks: checks.checks, cloudProvisionedByThisScript: false, cohortCreated: false }, null, 2));
    return;
  }
  if (!process.env.DATABASE_URL) throw new SetupError("An operator-supplied DATABASE_URL is required. No connection string is printed or read from a file by this script.");
  ({ prisma } = await import("../src/lib/prisma"));
  const { getOrCreateAssessmentVersion } = await import("../src/lib/recruit/assessment-versions");
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!admin) throw new SetupError("An existing administrator is required to own the draft.");
  let existing = await findExisting();
  let created = false;
  if (!existing) {
    try { await createDraft(admin.id); created = true; }
    catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      // A concurrent identical setup may win the slug; verify it rather than overwriting it.
    }
    existing = await findExisting();
  }
  if (!existing) throw new SetupError("The DevOps draft was not found after setup.");
  assertUnchanged(existing);
  const version = await getOrCreateAssessmentVersion(existing.id, admin.id);
  console.log(JSON.stringify({
    created, status: "draft", scenarioId: existing.id, slug: existing.slug,
    assessmentVersionId: version.id, definitionHash: DEFINITION_HASH,
    minutes: 100, taskMarks: [40, 60], criteria: 6, cohortCreated: false,
    launchBlockers: DEFINITION.roleEvidenceRecord.launchReadiness.blockers.map((blocker) => blocker.code),
  }, null, 2));
}

seed().catch((error: unknown) => {
  console.error(error instanceof SetupError ? error.message
    : error instanceof Prisma.PrismaClientKnownRequestError ? `DevOps draft setup failed with database code ${error.code}; no existing content was overwritten.`
      : error instanceof Prisma.PrismaClientInitializationError ? "DevOps draft setup could not connect to the supplied database."
        : "DevOps draft setup failed; no existing content was reset.");
  process.exitCode = 1;
}).finally(async () => prisma?.$disconnect());
