/**
 * Create synthetic records for the Kubernetes deployment smoke test.
 * Run only with the operator-supplied DATABASE_URL after applying migrations:
 *   npx tsx scripts/seed-kubernetes-pilot.ts
 * Optional KUBERNETES_PILOT_BASE_URL selects the tested application origin.
 *
 * Re-running preserves all candidates, tokens, deadlines, work and lab evidence.
 * This script never sends invitations, deletes data or fabricates human reviews.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { ASSESSMENT_MODE_POLICY_VERSION } from "../src/lib/recruit/assessment-modes";
import { getOrCreateAssessmentVersion } from "../src/lib/recruit/assessment-versions";
import { KUBERNETES_LAB_TEMPLATE, taskKubernetesLab } from "../src/lib/recruit/kubernetes-lab-config";
import { generateToken, indexToAnonymousId } from "../src/lib/recruit/tokens";

const SLUG = "pilot-kubernetes-troubleshooting-v1";
const TITLE = "PILOT ONLY — Kubernetes checkout service recovery";
const ORGANISATION = "UNIQassess Synthetic Lab Pilot";
const TASK_TITLE = "Restore the checkout service";
const SOURCE_ID = "SYNTHETIC-KUBERNETES-PILOT-V1";
const FIXTURE_ID = "kubernetes-live-pilot-v1";
const NOW = new Date();
class PilotConfigurationError extends Error {}
const COHORTS = [
  {
    id: `${FIXTURE_ID}-normal`, title: "PILOT ONLY — Kubernetes browser and isolation checks", minutes: 60,
    candidates: [
      { name: "Synthetic Pilot Alpha", email: "alpha@kubernetes-pilot.example" },
      { name: "Synthetic Pilot Bravo", email: "bravo@kubernetes-pilot.example" },
    ],
  },
  {
    id: `${FIXTURE_ID}-expiry`, title: "PILOT ONLY — Kubernetes five-minute expiry check", minutes: 5,
    candidates: [{ name: "Synthetic Pilot Expiry", email: "expiry@kubernetes-pilot.example" }],
  },
] as const;

const BRIEF = `**Synthetic operational pilot — no hiring decision will use this work.**

The checkout service became unavailable after a configuration release. Use your Kubernetes practical lab to inspect the supplied resources and restore service.

Success means two checkout replicas are Ready and \`curl --max-time 3 -i http://checkout/checkout\` returns HTTP 200 with the expected checkout JSON. Preserve both replicas and the readiness/liveness checks.

Start with \`kubectl get pods,deployments,services\`. Inspect events, logs, configuration and service routing. Your assigned namespace is isolated from the other pilot candidates. The image is preinstalled; no package downloads or external services are needed.

Write a short incident note explaining your diagnosis, the commands and changes you made, evidence of recovery, and what you would monitor after release. Commands, output and the final observed resource state are supporting evidence for the assessor.

Each command runs in a fresh shell in /workspace. Files persist; variables and working-directory changes do not. Use non-interactive commands and bounded waits such as \`kubectl rollout status deployment/checkout --timeout=10s\`. A command reaching the 20-second limit closes the lab. Submission and the assessment deadline also close it. Do not enter credentials, personal data or unrelated work.`;

const RUBRIC = {
  diagnosis: {
    max: 40,
    description: "Finds both deliberate defects using observed Kubernetes evidence.",
    embedded_issues: [
      { id: "readiness", title: "Diagnoses the readiness port mismatch", max_marks: 20, expected: "Connects readiness failures to port 8081 while the application listens on 8080." },
      { id: "routing", title: "Diagnoses the service selector mismatch", max_marks: 20, expected: "Compares the service selector app=checkout-previous with the actual pod label app=checkout." },
    ],
  },
  repair: {
    max: 40,
    description: "Applies precise, proportionate repairs while preserving the workload contract.",
    indicators: ["Corrects the readiness port", "Corrects the service selector", "Preserves two replicas and health checks", "Explains the change order and avoids unnecessary changes"],
  },
  verification: {
    max: 20,
    description: "Verifies service recovery and distinguishes observations from assumptions.",
    indicators: ["Shows two Ready replicas", "Checks populated EndpointSlices", "Verifies HTTP 200 through the service", "Records limitations and useful monitoring"],
  },
} satisfies Prisma.InputJsonObject;

async function mintToken() {
  for (let attempt = 0; attempt < 25; attempt++) {
    const token = generateToken("K8P");
    if (!await prisma.recruitmentCandidate.findUnique({ where: { token }, select: { id: true } })) return token;
  }
  throw new PilotConfigurationError("Could not allocate a unique synthetic pilot candidate token.");
}

async function ensureScenario(adminId: string) {
  const existing = await prisma.recruitmentScenario.findUnique({ where: { slug: SLUG }, include: { tasks: true } });
  if (existing) {
    const marker = existing.roleEvidenceRecord as { fixtureId?: string } | null;
    if (existing.title !== TITLE || existing.organisation !== ORGANISATION || marker?.fixtureId !== FIXTURE_ID
      || existing.status !== "published" || existing.tasks.length !== 1
      || !taskKubernetesLab(existing.tasks[0].config)) {
      throw new PilotConfigurationError("Refusing to alter existing records that do not match the synthetic Kubernetes pilot fixture.");
    }
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const scenario = await tx.recruitmentScenario.create({
      data: {
        slug: SLUG, title: TITLE, organisation: ORGANISATION, positionTitle: "DevOps Engineer — synthetic pilot",
        defaultTotalMinutes: 60, status: "published", publishedAt: NOW, createdById: adminId,
        assessmentMode: "EVIDENCE", modePolicyVersion: ASSESSMENT_MODE_POLICY_VERSION,
        defenceEnabled: false,
        roleEvidenceRecord: {
          version: 1, fixtureId: FIXTURE_ID, sourceType: "synthetic_operational_pilot", reviewed: false,
          summary: "Synthetic browser/cluster test fixture only. Not human-reviewed assessment content, psychometric validation, or suitable for applicant use.",
        },
      },
    });
    const exhibit = await tx.recruitmentScenarioExhibit.create({
      data: {
        scenarioId: scenario.id, sourceId: SOURCE_ID, title: "Synthetic checkout service incident",
        html: `<article><h1>Checkout service incident</h1><p>Source: ${SOURCE_ID}. This is a fictional operational pilot.</p><p>A configuration release made checkout unavailable. The intended deployment has two replicas and HTTP health checks. Restore both replicas and verify HTTP 200 through <code>http://checkout/checkout</code>.</p><p>Use observed resources, events and logs to diagnose the incident. Preserve readiness/liveness checks. The environment includes its approved image and tools; external downloads are unnecessary.</p><p>The lab records commands and output. Work ends at submission or the displayed deadline. Each command has a 20-second limit; a timeout closes the lab. Use short, bounded checks.</p></article>`,
      },
    });
    const task = await tx.recruitmentScenarioTask.create({
      data: {
        scenarioId: scenario.id, number: 1, kind: "memo_ai", title: TASK_TITLE, briefMarkdown: BRIEF, totalMarks: 100,
        systemPrompt: "You are the Knowledge System for a synthetic Kubernetes operational pilot. Help the candidate inspect and reason about their supplied evidence. In Evidence Mode, do not draft the final incident note. You cannot execute commands or see the current cluster: the candidate operates the practical lab directly. Do not claim to have run a command or observed resources. Do not invent evidence. Explain uncertainty and encourage short, bounded verification checks.",
        exhibitId: exhibit.id, deliverableLabel: "Incident diagnosis, repair and verification",
        deliverablePlaceholder: "Record your observations, diagnosis, changes, recovery checks and remaining uncertainty. This synthetic work is used only to test the platform.",
        config: { kubernetesLab: { enabled: true, templateId: KUBERNETES_LAB_TEMPLATE.id } }, rubric: RUBRIC,
      },
    });
    const definitions = [
      { code: "K8S_DIAGNOSIS", name: "Evidence-led diagnosis", description: "Connects observed workload and routing evidence to the two defects.", marks: 40, rubricElementIds: ["readiness", "routing"], behaviours: ["Inspects readiness and port configuration", "Compares selectors, labels and endpoints"] },
      { code: "K8S_REPAIR", name: "Safe workload repair", description: "Restores service with precise changes that retain the workload contract.", marks: 40, rubricElementIds: ["repair"], behaviours: ["Preserves replicas and health checks", "Explains specific changes"] },
      { code: "K8S_VERIFICATION", name: "Recovery verification", description: "Demonstrates readiness and service-level HTTP recovery.", marks: 20, rubricElementIds: ["verification"], behaviours: ["Checks both replicas and service routing", "Reports actual HTTP results and limitations"] },
    ];
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index];
      await tx.recruitmentScenarioCriterion.create({
        data: {
          scenarioId: scenario.id, code: definition.code, name: definition.name, description: definition.description,
          sourceRequirement: "Synthetic Kubernetes operational pilot; not a validated hiring criterion",
          observableBehaviours: definition.behaviours, order: index + 1,
          taskMappings: { create: { taskId: task.id, expectedCandidateEvidence: definition.description, rubricElementIds: definition.rubricElementIds, marks: definition.marks } },
        },
      });
    }
    return scenario;
  });
}

async function seed() {
  if (process.argv.slice(2).length) throw new PilotConfigurationError("This additive pilot seed takes no arguments; teardown and reset are not supported.");
  if (!process.env.DATABASE_URL) throw new PilotConfigurationError("An operator-supplied DATABASE_URL is required.");
  const base = new URL(process.env.KUBERNETES_PILOT_BASE_URL ?? "https://www.uniqassess.org");
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
    || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new PilotConfigurationError("KUBERNETES_PILOT_BASE_URL must be a credential-free HTTPS origin (or local HTTP origin).");
  }
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!admin) throw new PilotConfigurationError("An existing ADMIN user is required to own the synthetic pilot.");
  const scenario = await ensureScenario(admin.id);
  const version = await getOrCreateAssessmentVersion(scenario.id, admin.id);
  const output = [];

  for (const definition of COHORTS) {
    const assessment = await prisma.recruitmentAssessment.upsert({
      where: { id: definition.id }, update: {},
      create: {
        id: definition.id, title: definition.title, scenarioSlug: SLUG, scenarioId: SLUG, customScenarioId: scenario.id,
        totalMinutes: definition.minutes, openDate: new Date(NOW.getTime() - 60_000),
        closeDate: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000), createdById: admin.id,
        assessmentMode: "EVIDENCE", modePolicyVersion: ASSESSMENT_MODE_POLICY_VERSION,
        defenceEnabled: false, assessmentVersionId: version.id,
      },
    });
    if (assessment.customScenarioId !== scenario.id || assessment.title !== definition.title
      || assessment.totalMinutes !== definition.minutes || assessment.assessmentVersionId !== version.id) {
      throw new PilotConfigurationError("Refusing to change a cohort that does not match the synthetic Kubernetes pilot fixture.");
    }
    for (let index = 0; index < definition.candidates.length; index++) {
      const candidateDefinition = definition.candidates[index];
      const candidate = await prisma.recruitmentCandidate.upsert({
        where: { assessmentId_email: { assessmentId: assessment.id, email: candidateDefinition.email } }, update: {},
        create: {
          assessmentId: assessment.id, name: candidateDefinition.name, email: candidateDefinition.email,
          token: await mintToken(), anonymousId: indexToAnonymousId(index), status: "invited",
        },
      });
      if (candidate.name !== candidateDefinition.name || candidate.anonymousId !== indexToAnonymousId(index)) {
        throw new PilotConfigurationError("Refusing to change a candidate that does not match the synthetic Kubernetes pilot fixture.");
      }
      const url = new URL(`/assess/${SLUG}`, base);
      url.searchParams.set("token", candidate.token);
      output.push({ scenarioId: scenario.id, assessmentVersionId: version.id, assessmentId: assessment.id, candidateId: candidate.id, url: url.href });
    }
  }
  console.log(JSON.stringify(output, null, 2));
}

seed().catch((error: unknown) => {
  // Avoid dumping Prisma connection strings, query data or environment values.
  console.error(error instanceof Prisma.PrismaClientKnownRequestError
    ? `Kubernetes pilot seed failed with database code ${error.code}.`
    : error instanceof Prisma.PrismaClientInitializationError
      ? "Kubernetes pilot seed could not connect to the supplied database."
      : error instanceof PilotConfigurationError
        ? error.message : "Kubernetes pilot seed failed; no existing data was reset.");
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
