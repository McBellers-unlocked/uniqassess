/**
 * Central scenario loader — resolves a RecruitmentAssessment to a
 * RecruitScenarioConfig regardless of whether the scenario lives in code
 * (src/lib/recruit/fam-p4-2026.ts) or in the database (RecruitmentScenario +
 * children). The candidate UI and APIs call getScenarioForAssessment() and
 * don't need to care about the source.
 *
 * Resolution order:
 *   1. If assessment.assessmentVersionId is set, load its immutable snapshot.
 *   2. If assessment.customScenarioId is set, load the live DB scenario.
 *   3. Otherwise, fall back to the code-based registry (getRecruitScenarioById).
 *
 * This keeps the legacy FAM scenario working unchanged during the rollout.
 */

import { prisma } from "@/lib/prisma";
import { getRecruitScenarioById } from "./fam-p4-2026";
import type {
  RecruitScenarioConfig,
  RecruitTaskConfig,
  TaskKind,
} from "./types";
import type { RecruitmentAssessment } from "@prisma/client";
import { ASSESSMENT_MODE_POLICY_VERSION, resolveAssessmentMode } from "./assessment-modes";
import {
  loadAssessmentVersionSnapshot,
  type AssessmentVersionSnapshot,
} from "./assessment-versions";
import { taskHasManagedCodeExecution } from "./code-execution";
import { taskKubernetesLab } from "./kubernetes-lab-config";
import { taskAwsLab } from "./aws-lab-config";

export async function getScenarioForAssessment(
  assessment: Pick<RecruitmentAssessment, "scenarioId" | "customScenarioId"> &
    Partial<
      Pick<
        RecruitmentAssessment,
        "assessmentVersionId" | "assessmentMode" | "modePolicyVersion" | "defenceEnabled" | "defenceQuestionCount" | "defenceMinutes"
      >
    >
): Promise<RecruitScenarioConfig | null> {
  if (assessment.assessmentVersionId) {
    const snapshot = await loadAssessmentVersionSnapshot(assessment.assessmentVersionId);
    if (snapshot) return applyCohortPolicy(materialiseScenarioSnapshot(snapshot), assessment);
  }
  if (assessment.customScenarioId) {
    const scenario = await getDbScenarioById(assessment.customScenarioId);
    return scenario ? applyCohortPolicy(scenario, assessment) : null;
  }
  const legacy = getRecruitScenarioById(assessment.scenarioId);
  return legacy ? applyCohortPolicy(legacy, assessment) : null;
}

function applyCohortPolicy(
  scenario: RecruitScenarioConfig,
  assessment: Partial<
    Pick<
      RecruitmentAssessment,
      "assessmentMode" | "modePolicyVersion" | "defenceEnabled" | "defenceQuestionCount" | "defenceMinutes"
    >
  >,
): RecruitScenarioConfig {
  return {
    ...scenario,
    assessmentMode: resolveAssessmentMode(assessment.assessmentMode),
    modePolicyVersion: assessment.modePolicyVersion || ASSESSMENT_MODE_POLICY_VERSION,
    defenceEnabled: assessment.defenceEnabled ?? false,
    defenceQuestionCount: assessment.defenceQuestionCount ?? 2,
    defenceMinutes: assessment.defenceMinutes ?? 5,
  };
}

/**
 * Load a single DB-backed scenario by its id, materialising all task types
 * into the normalised RecruitScenarioConfig shape.
 */
export async function getDbScenarioById(
  id: string
): Promise<RecruitScenarioConfig | null> {
  const row = await prisma.recruitmentScenario.findUnique({
    where: { id },
    include: {
      tasks: {
        include: {
          exhibit: true,
          emails: { orderBy: { orderIndex: "asc" } },
          chatScripts: true,
        },
        orderBy: { number: "asc" },
      },
    },
  });
  if (!row) return null;
  return materialiseScenario(row);
}

/** Load by slug — used by the candidate-facing /assess/[slug] route. */
export async function getDbScenarioBySlug(
  slug: string
): Promise<RecruitScenarioConfig | null> {
  const row = await prisma.recruitmentScenario.findUnique({
    where: { slug },
    include: {
      tasks: {
        include: {
          exhibit: true,
          emails: { orderBy: { orderIndex: "asc" } },
          chatScripts: true,
        },
        orderBy: { number: "asc" },
      },
    },
  });
  if (!row) return null;
  return materialiseScenario(row);
}

// Shape of the scenario+tasks+nested children rows we load. Inlining the
// Prisma query return type gives materialiseScenario exact field knowledge
// without having to maintain a separate hand-rolled type.
type DbScenarioRow = NonNullable<
  Awaited<
    ReturnType<
      typeof prisma.recruitmentScenario.findUnique<{
        where: { id: string };
        include: {
          tasks: { include: { exhibit: true; emails: true; chatScripts: true } };
        };
      }>
    >
  >
>;

/**
 * Derive the in-assessment AI brand from the organisation's acronym, e.g.
 * "International Policy Analytics Centre (IPAC), Nairobi" → "IPAC Knowledge
 * System". DB scenarios have no brand column, so this keeps a ported scenario
 * (e.g. IPAC) on-brand. Returns nulls when there's no acronym; the candidate
 * UI then falls back to the IDSC default.
 */
function deriveAssistantBrand(org: string): { name: string | null; short: string | null } {
  const m = org.match(/\(([A-Za-z][A-Za-z0-9&-]{1,7})\)/);
  const short = m ? m[1] : null;
  return { name: short ? `${short} Knowledge System` : null, short };
}

function materialiseScenario(row: DbScenarioRow): RecruitScenarioConfig {
  const brand = deriveAssistantBrand(row.organisation);
  return {
    scenarioId: row.id,
    slug: row.slug,
    title: row.title,
    organisation: row.organisation,
    positionTitle: row.positionTitle,
    defaultTotalMinutes: row.defaultTotalMinutes,
    assessmentMode: resolveAssessmentMode(row.assessmentMode),
    modePolicyVersion: row.modePolicyVersion,
    defenceEnabled: row.defenceEnabled,
    defenceQuestionCount: row.defenceQuestionCount,
    defenceMinutes: row.defenceMinutes,
    source: "db",
    assistantName: brand.name ?? undefined,
    assistantShortName: brand.short ?? undefined,
    tasks: row.tasks.map(materialiseTask),
  };
}

/** Materialise the immutable JSON shape captured by scenario-content-hash.ts. */
export function materialiseScenarioSnapshot(
  snapshot: AssessmentVersionSnapshot,
): RecruitScenarioConfig {
  const brand = deriveAssistantBrand(snapshot.organisation);
  const exhibits = new Map(snapshot.exhibits.map((exhibit) => [exhibit.id, exhibit]));
  return {
    scenarioId: snapshot.id,
    slug: snapshot.slug,
    title: snapshot.title,
    organisation: snapshot.organisation,
    positionTitle: snapshot.positionTitle,
    defaultTotalMinutes: snapshot.defaultTotalMinutes,
    assessmentMode: resolveAssessmentMode(snapshot.assessmentMode),
    modePolicyVersion: snapshot.modePolicyVersion,
    defenceEnabled: snapshot.defenceEnabled,
    defenceQuestionCount: snapshot.defenceQuestionCount,
    defenceMinutes: snapshot.defenceMinutes,
    source: "db",
    assistantName: brand.name ?? undefined,
    assistantShortName: brand.short ?? undefined,
    tasks: snapshot.tasks.map((task) => {
      const kind = task.kind as TaskKind;
      if (kind === "memo_ai") {
        const exhibit = task.exhibitId ? exhibits.get(task.exhibitId) : null;
        return {
          taskId: task.id,
          number: task.number,
          kind: "memo_ai" as const,
          title: task.title,
          briefMarkdown: task.briefMarkdown,
          totalMarks: task.totalMarks,
          systemPrompt: task.systemPrompt ?? "",
          codeExecutionEnabled: taskHasManagedCodeExecution(task.config),
          kubernetesLab: taskKubernetesLab(task.config),
          awsLab: taskAwsLab(task.config),
          exhibitHtml: exhibit?.html ?? "",
          exhibitTitle: exhibit?.title ?? "",
          exhibitSourceId: exhibit?.sourceId ?? exhibit?.id ?? `task-${task.number}-exhibit`,
          deliverableLabel: task.deliverableLabel ?? "Deliverable",
          deliverablePlaceholder: task.deliverablePlaceholder ?? "",
        };
      }
      if (kind === "email_inbox") {
        return {
          taskId: task.id,
          number: task.number,
          kind: "email_inbox" as const,
          title: task.title,
          briefMarkdown: task.briefMarkdown,
          totalMarks: task.totalMarks,
          emails: task.emails.map((email) => ({
            id: email.id,
            orderIndex: email.orderIndex,
            triggerOffsetSeconds: email.triggerOffsetSeconds,
            senderName: email.senderName,
            senderEmail: email.senderEmail,
            subject: email.subject,
            bodyHtml: email.bodyHtml,
            expectedAction: email.expectedAction as "reply" | "ignore" | "flag" | "forward",
            markerNotes: email.markerNotes,
          })),
        };
      }
      const script = task.chatScripts[0];
      return {
        taskId: task.id,
        number: task.number,
        kind: "chat" as const,
        title: task.title,
        briefMarkdown: task.briefMarkdown,
        totalMarks: task.totalMarks,
        script: script
          ? {
              id: script.id,
              triggerOffsetSeconds: script.triggerOffsetSeconds,
              personaName: script.personaName,
              personaRole: script.personaRole,
              openerMessage: script.openerMessage,
              systemPrompt: script.systemPrompt,
              maxTurns: script.maxTurns,
              expectedOutcomes: script.expectedOutcomes,
            }
          : {
              id: "",
              triggerOffsetSeconds: 0,
              personaName: "",
              personaRole: "",
              openerMessage: "",
              systemPrompt: "",
              maxTurns: 8,
              expectedOutcomes: null,
            },
      };
    }),
  };
}

function materialiseTask(task: DbScenarioRow["tasks"][number]): RecruitTaskConfig {
  const kind = task.kind as TaskKind;
  switch (kind) {
    case "memo_ai":
      return {
        taskId: task.id,
        number: task.number,
        kind: "memo_ai",
        title: task.title,
        briefMarkdown: task.briefMarkdown,
        totalMarks: task.totalMarks,
        systemPrompt: task.systemPrompt ?? "",
        codeExecutionEnabled: taskHasManagedCodeExecution(task.config),
        kubernetesLab: taskKubernetesLab(task.config),
        awsLab: taskAwsLab(task.config),
        exhibitHtml: task.exhibit?.html ?? "",
        exhibitTitle: task.exhibit?.title ?? "",
        exhibitSourceId: task.exhibit?.sourceId ?? task.exhibit?.id ?? `task-${task.number}-exhibit`,
        deliverableLabel: task.deliverableLabel ?? "Deliverable",
        deliverablePlaceholder: task.deliverablePlaceholder ?? "",
      };
    case "email_inbox":
      return {
        taskId: task.id,
        number: task.number,
        kind: "email_inbox",
        title: task.title,
        briefMarkdown: task.briefMarkdown,
        totalMarks: task.totalMarks,
        emails: task.emails.map((e) => ({
          id: e.id,
          orderIndex: e.orderIndex,
          triggerOffsetSeconds: e.triggerOffsetSeconds,
          senderName: e.senderName,
          senderEmail: e.senderEmail,
          subject: e.subject,
          bodyHtml: e.bodyHtml,
          expectedAction: e.expectedAction as "reply" | "ignore" | "flag" | "forward",
          markerNotes: e.markerNotes,
        })),
      };
    case "chat": {
      // A chat task always has exactly one script (enforced on publish).
      // If the admin hasn't authored one yet we return a placeholder so the
      // builder UI can still render partial state.
      const s = task.chatScripts[0];
      return {
        taskId: task.id,
        number: task.number,
        kind: "chat",
        title: task.title,
        briefMarkdown: task.briefMarkdown,
        totalMarks: task.totalMarks,
        script: s
          ? {
              id: s.id,
              triggerOffsetSeconds: s.triggerOffsetSeconds,
              personaName: s.personaName,
              personaRole: s.personaRole,
              openerMessage: s.openerMessage,
              systemPrompt: s.systemPrompt,
              maxTurns: s.maxTurns,
              expectedOutcomes: s.expectedOutcomes,
            }
          : {
              id: "",
              triggerOffsetSeconds: 0,
              personaName: "",
              personaRole: "",
              openerMessage: "",
              systemPrompt: "",
              maxTurns: 8,
              expectedOutcomes: null,
            },
      };
    }
    default: {
      // Unknown kind — treat as memo_ai skeleton so the candidate UI doesn't
      // crash. Admin UI will surface this as a validation error on publish.
      return {
        taskId: task.id,
        number: task.number,
        kind: "memo_ai",
        title: task.title,
        briefMarkdown: task.briefMarkdown,
        totalMarks: task.totalMarks,
        systemPrompt: task.systemPrompt ?? "",
        codeExecutionEnabled: taskHasManagedCodeExecution(task.config),
        kubernetesLab: taskKubernetesLab(task.config),
        awsLab: taskAwsLab(task.config),
        exhibitHtml: task.exhibit?.html ?? "",
        exhibitTitle: task.exhibit?.title ?? "",
        exhibitSourceId: task.exhibit?.sourceId ?? task.exhibit?.id ?? `task-${task.number}-exhibit`,
        deliverableLabel: task.deliverableLabel ?? "Deliverable",
        deliverablePlaceholder: task.deliverablePlaceholder ?? "",
      };
    }
  }
}

/**
 * Convenience: look up a scenario by either code id (legacy) or slug. Used
 * by the candidate-facing /assess/[slug] resolution where the URL segment
 * is a slug but legacy deep-links may pass a scenarioId.
 */
export async function getScenarioBySlugOrId(
  slugOrId: string
): Promise<RecruitScenarioConfig | null> {
  const db = await getDbScenarioBySlug(slugOrId);
  if (db) return db;
  const code = getRecruitScenarioById(slugOrId);
  if (code) return code;
  return null;
}
