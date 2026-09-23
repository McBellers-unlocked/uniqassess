import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  assertAssessmentAccess,
  requireScenarioBuilder,
} from "@/lib/admin-auth";
import { loadRubricForAssessment } from "@/lib/recruit/rubric";
import { getScenarioForAssessment } from "@/lib/recruit/scenario-loader";
import { isChatTask, isEmailInboxTask } from "@/lib/recruit/types";
import { analyzeTextReuse, type ReuseResult } from "@/lib/recruit/textReuse";
import { criteriaForAssessment } from "@/lib/recruit/assessment-versions";
import { reconcileCandidateLabs } from "@/lib/recruit/kubernetes-lab-service";

export const dynamic = "force-dynamic";

/**
 * GET — load one candidate's submission for marking. STRICTLY BLIND:
 *   does not return name, email, or any other identifying field. The
 *   admin sees only the anonymous ID.
 *
 * POST — save scores + comments + issuesIdentified for one or both tasks.
 *   Body: { task1?: {score, comments, issuesIdentified}, task2?: {...} }
 *   Recomputes candidate.totalScore from the per-task scores.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string; candidateId: string } }
) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;
  const denied = await assertAssessmentAccess(auth, params.id);
  if (denied) return denied;

  const c = await prisma.recruitmentCandidate.findUnique({
    where: { id: params.candidateId },
    select: {
      id: true,
      assessmentId: true,
      anonymousId: true,
      startedAt: true,
      submittedAt: true,
      workLockedAt: true,
      toolDeclaration: true,
      toolDeclarationSubmittedAt: true,
      totalScore: true,
      assessment: { select: { id: true, title: true, scenarioId: true, customScenarioId: true, assessmentVersionId: true, revealedAt: true, assessmentMode: true, modePolicyVersion: true, defenceEnabled: true, defenceMinutes: true, defenceQuestionCount: true } },
      responses: {
        select: {
          taskNumber: true, content: true, wordCount: true, sentAt: true,
          score: true, comments: true, issuesIdentified: true, criterionScores: true, markedAt: true,
        },
      },
      interactions: {
        orderBy: { sequenceNum: "asc" },
        select: {
          id: true, sequenceNum: true, taskNumber: true,
          timestamp: true, actor: true, content: true, structuredPayload: true, schemaVersion: true,
        },
      },
      evidenceBoard: { orderBy: { createdAt: "asc" } },
      defence: true,
      activityEvents: {
        orderBy: { occurredAt: "asc" },
        select: {
          id: true, occurredAt: true, eventType: true, taskNumber: true, metadata: true,
        },
      },
    },
  });
  if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (c.assessmentId !== params.id) return NextResponse.json({ error: "Mismatch" }, { status: 400 });

  // Work-provenance context: how much of each memo overlaps with the AI "knowledge
  // system" output the candidate saw (lexical text reuse — detects copy-paste).
  // Computed in-memory from data already loaded above; advisory only, never
  // scored. Keyed by task number; non-memo tasks have no response row and so
  // get no entry.
  const reuseByTask: Record<number, ReuseResult> = {};
  for (const r of c.responses) {
    const aiTexts = c.interactions
      .filter((i) => i.taskNumber === r.taskNumber && i.actor === "ai")
      .map((i) => i.content);
    reuseByTask[r.taskNumber] = analyzeTextReuse(r.content ?? "", aiTexts);
  }

  const rubric = await loadRubricForAssessment(c.assessment);

  // Resolve the scenario so the marker can see non-memo tasks (the email
  // in-tray and the live persona chat) alongside the scored memos, plus the
  // candidate's email-triage decisions. Scenario content is not candidate
  // identity, so it's safe under blind marking.
  const scenario = await getScenarioForAssessment(c.assessment);
  const scenarioTasks = (scenario?.tasks ?? []).map((t) => {
    if (isEmailInboxTask(t)) {
      return {
        number: t.number,
        kind: t.kind,
        title: t.title,
        emails: t.emails.map((e) => ({
          id: e.id,
          senderName: e.senderName,
          senderEmail: e.senderEmail,
          subject: e.subject,
          bodyHtml: e.bodyHtml,
          triggerOffsetSeconds: e.triggerOffsetSeconds,
          expectedAction: e.expectedAction,
          markerNotes: e.markerNotes,
        })),
      };
    }
    if (isChatTask(t)) {
      return {
        number: t.number,
        kind: t.kind,
        title: t.title,
        persona: {
          personaName: t.script.personaName,
          personaRole: t.script.personaRole,
          openerMessage: t.script.openerMessage,
          maxTurns: t.script.maxTurns,
          expectedOutcomes: t.script.expectedOutcomes,
        },
      };
    }
    return { number: t.number, kind: t.kind, title: t.title, labConfigured: Boolean(t.kubernetesLab) };
  });

  // Select only evidence fields. Provider identifiers, credentials and candidate
  // identity must never reach the blind marking interface.
  await reconcileCandidateLabs(c.id).catch(() => {});
  const labSessionRows = await prisma.recruitmentLabSession.findMany({
    where: { candidateId: c.id },
    orderBy: [{ taskNumber: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      taskNumber: true,
      templateId: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
      error: true,
      snapshot: true,
      cleanupCompletedAt: true,
      commands: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true, command: true, status: true, stdout: true, stderr: true,
          exitCode: true, truncated: true, createdAt: true, startedAt: true, finishedAt: true,
        },
      },
    },
  });
  const labSessions = labSessionRows.map((session) => ({
    ...session,
    // Operational errors can contain provider details; markers need only the
    // fact that delivery failed. Recorded command output remains evidence.
    error: session.error ? "The lab encountered a runtime problem. Consider this when reviewing the evidence." : null,
  }));

  const emailResponses = await prisma.recruitmentEmailResponse.findMany({
    where: { candidateId: c.id },
    orderBy: { deliveredAt: "asc" },
    select: {
      emailId: true,
      action: true,
      replyBody: true,
      deliveredAt: true,
      respondedAt: true,
      markerComment: true,
    },
  });

  const criterionMappings = (await criteriaForAssessment(c.assessment))
    .flatMap((criterion) => criterion.taskMappings.map((mapping) => ({ criterion, mapping })))
    .sort(
      (left, right) => left.mapping.taskNumber - right.mapping.taskNumber || left.criterion.order - right.criterion.order,
    );

  return NextResponse.json({
    candidate: {
      id: c.id,
      anonymousId: c.anonymousId,                // anon only — no name/email leak
      startedAt: c.startedAt,
      submittedAt: c.submittedAt,
      timeTakenMin:
        c.startedAt && c.submittedAt
          ? Math.round((c.submittedAt.getTime() - c.startedAt.getTime()) / 60_000)
          : null,
      totalScore: c.totalScore,
      workLockedAt: c.workLockedAt,
      toolDeclaration: c.toolDeclaration,
      toolDeclarationSubmittedAt: c.toolDeclarationSubmittedAt,
    },
    assessment: c.assessment,
    assistantName: scenario?.assistantName ?? null,
    assistantShortName: scenario?.assistantShortName ?? null,
    rubric,
    criterionMappings: criterionMappings.map((mapping) => ({
      criterionId: mapping.criterion.id,
      code: mapping.criterion.code,
      name: mapping.criterion.name,
      taskNumber: mapping.mapping.taskNumber,
      expectedCandidateEvidence: mapping.mapping.expectedCandidateEvidence,
      maxMarks: mapping.mapping.marks,
    })),
    scenarioTasks,
    responses: c.responses,
    interactions: c.interactions,
    labSessions,
    emailResponses,
    activityEvents: c.activityEvents,
    evidenceBoard: c.evidenceBoard,
    defence: c.defence,
    reuseByTask,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; candidateId: string } }
) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;
  const denied = await assertAssessmentAccess(auth, params.id);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));

  const candidate = await prisma.recruitmentCandidate.findUnique({
    where: { id: params.candidateId },
    select: { id: true, assessmentId: true, assessment: { select: { customScenarioId: true, assessmentVersionId: true } } },
  });
  if (!candidate || candidate.assessmentId !== params.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const markerId = auth.session.user.id;
  const now = new Date();
  type TaskUpdate = {
    score?: number | null;
    comments?: string | null;
    issuesIdentified?: string[] | null;
    criterionScores?: Record<string, number | null> | null;
  };
  // Accept any `taskN` key (N a positive integer), not just task1/task2 —
  // generated scenarios carry 1–5 tasks. The marking page posts one task
  // at a time, but a loop keeps this robust to multi-task payloads.
  const incoming: Record<number, TaskUpdate> = {};
  for (const [key, value] of Object.entries(body)) {
    const m = /^task(\d+)$/.exec(key);
    if (m && value && typeof value === "object") {
      incoming[Number(m[1])] = value as TaskUpdate;
    }
  }

  const allowedCriterionMappings = (await criteriaForAssessment(candidate.assessment))
    .flatMap((criterion) => criterion.taskMappings.map((mapping) => ({
      criterionId: criterion.id,
      marks: mapping.marks,
      taskNumber: mapping.taskNumber,
    })));

  for (const [k, v] of Object.entries(incoming)) {
    const taskNumber = Number(k);
    const score = v.score != null ? Number(v.score) : null;
    const comments = typeof v.comments === "string" ? v.comments : null;
    const issuesIdentified = Array.isArray(v.issuesIdentified) ? v.issuesIdentified.map(String) : null;
    let criterionScores: Record<string, number> | undefined;
    if (score != null && (isNaN(score) || score < 0 || score > 100)) {
      return NextResponse.json({ error: `Task ${taskNumber} score must be 0-100` }, { status: 400 });
    }
    if (v.criterionScores && typeof v.criterionScores === "object" && !Array.isArray(v.criterionScores)) {
      criterionScores = {};
      const allowed = new Map(
        allowedCriterionMappings
          .filter((mapping) => mapping.taskNumber === taskNumber && mapping.marks > 0)
          .map((mapping) => [mapping.criterionId, mapping.marks])
      );
      for (const [criterionId, rawScore] of Object.entries(v.criterionScores)) {
        if (rawScore == null) continue;
        const criterionMax = allowed.get(criterionId);
        const criterionScore = Number(rawScore);
        if (criterionMax == null) {
          return NextResponse.json({ error: `Criterion ${criterionId} is not mapped to task ${taskNumber}` }, { status: 400 });
        }
        if (!Number.isFinite(criterionScore) || criterionScore < 0 || criterionScore > criterionMax) {
          return NextResponse.json(
            { error: `Criterion score for task ${taskNumber} must be between 0 and ${criterionMax}` },
            { status: 400 }
          );
        }
        criterionScores[criterionId] = criterionScore;
      }
    }

    await prisma.recruitmentResponse.upsert({
      where: { candidateId_taskNumber: { candidateId: candidate.id, taskNumber } },
      create: {
        candidateId: candidate.id,
        taskNumber,
        content: "",
        wordCount: 0,
        score,
        comments,
        issuesIdentified: (issuesIdentified ?? null) as unknown as object,
        ...(criterionScores !== undefined ? { criterionScores } : {}),
        markedAt: now,
        markedById: markerId,
      },
      update: {
        score,
        comments,
        issuesIdentified: (issuesIdentified ?? null) as unknown as object,
        ...(criterionScores !== undefined ? { criterionScores } : {}),
        markedAt: now,
        markedById: markerId,
      },
    });
  }

  // Recompute totalScore: sum of any non-null per-task scores
  const responses = await prisma.recruitmentResponse.findMany({
    where: { candidateId: candidate.id },
    select: { score: true },
  });
  const totalScore = responses
    .filter((r) => r.score != null)
    .reduce((s, r) => s + (r.score ?? 0), 0);
  await prisma.recruitmentCandidate.update({
    where: { id: candidate.id },
    data: { totalScore: totalScore || null },
  });

  return NextResponse.json({ ok: true, totalScore });
}
