import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadCandidate, verifySessionCookie } from "@/lib/recruit/candidate-auth";
import { getScenarioForAssessment } from "@/lib/recruit/scenario-loader";
import { isChatTask, isMemoAiTask } from "@/lib/recruit/types";
import { getAssessmentModePolicy } from "@/lib/recruit/assessment-modes";

export const dynamic = "force-dynamic";

/**
 * Personalise a task brief for this candidate. Briefs may use {{name}} /
 * {{firstName}} tokens (e.g. in the "To" line and salutation); we substitute
 * them server-side so the brief reaching the browser is already addressed to
 * the candidate and no literal token is ever shown. No-op for briefs without
 * tokens (the IDSC built-ins). The candidate's name is their own and is only
 * returned to their own authenticated session — marking stays blind elsewhere.
 */
function personaliseBrief(md: string, name: string | null | undefined): string {
  const full = (name ?? "").trim();
  const first = full.split(/\s+/)[0] || full;
  return md
    .replace(/\{\{\s*(name|candidateName|fullName)\s*\}\}/gi, full || "Director")
    .replace(/\{\{\s*firstName\s*\}\}/gi, first || "Director");
}

/**
 * Read full candidate state: scenario content (both tasks), responses,
 * interactions, server-side time remaining.
 *
 * Pre-start (status=invited): returns scenario meta only (no exhibits / prompts)
 * so the landing page can render a brief without leaking content.
 *
 * Started: full content + the candidate's responses + interactions for both tasks.
 *
 * Submitted/expired: read-only view, no further mutation accepted.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const result = await loadCandidate(params.token);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { candidate, assessment } = result;

  const scenario = await getScenarioForAssessment(assessment);
  if (!scenario) return NextResponse.json({ error: "Scenario config missing" }, { status: 500 });
  const modePolicy = getAssessmentModePolicy(assessment.assessmentMode);

  // PRE-START: minimal payload
  if (candidate.status === "invited") {
    return NextResponse.json({
      stage: "invited",
      assessment: {
        title: assessment.title,
        totalMinutes: assessment.totalMinutes,
        closeDate: assessment.closeDate,
        assessmentMode: assessment.assessmentMode,
        modePolicyVersion: assessment.modePolicyVersion,
        defenceEnabled: assessment.defenceEnabled,
        defenceMinutes: assessment.defenceMinutes,
      },
      scenario: {
        title: scenario.title,
        organisation: scenario.organisation,
        positionTitle: scenario.positionTitle,
        taskCount: scenario.tasks.length,
        // Number of written (memo) deliverables — the switchable tasks the
        // landing page should describe — and whether a live chat/IM can fire.
        memoTaskCount: scenario.tasks.filter(isMemoAiTask).length,
        practicalTaskCount: scenario.tasks.filter((task) => isMemoAiTask(task) && (task.kubernetesLab || task.awsLab)).length,
        source: scenario.source,
        hasLiveMessage: scenario.tasks.some(isChatTask),
        assistantName: scenario.assistantName ?? null,
        assistantShortName: scenario.assistantShortName ?? null,
        assessmentMode: assessment.assessmentMode,
        modePolicy,
      },
      candidate: { anonymousId: candidate.anonymousId },
    });
  }

  // For started/submitted, require the cookie
  const cookieOk = await verifySessionCookie(candidate);
  if ((candidate.status === "started" || candidate.status === "defence") && !cookieOk) {
    return NextResponse.json(
      { error: "This assessment is in progress in another browser session." },
      { status: 403 }
    );
  }

  const [responses, interactions, evidenceBoard, defence] = await Promise.all([
    prisma.recruitmentResponse.findMany({ where: { candidateId: candidate.id }, orderBy: { taskNumber: "asc" } }),
    prisma.recruitmentInteraction.findMany({
      where: { candidateId: candidate.id },
      orderBy: { sequenceNum: "asc" },
      select: { id: true, sequenceNum: true, taskNumber: true, timestamp: true, actor: true, content: true, structuredPayload: true, schemaVersion: true, metadata: true },
    }),
    prisma.recruitmentCandidateEvidence.findMany({ where: { candidateId: candidate.id }, orderBy: { createdAt: "asc" } }),
    prisma.recruitmentCandidateDefence.findUnique({ where: { candidateId: candidate.id } }),
  ]);

  return NextResponse.json({
    stage: candidate.status, // "started" | "submitted" | "expired"
    assessment: {
      id: assessment.id,
      title: assessment.title,
      totalMinutes: assessment.totalMinutes,
      closeDate: assessment.closeDate,
      assessmentMode: assessment.assessmentMode,
      modePolicyVersion: assessment.modePolicyVersion,
      defenceEnabled: assessment.defenceEnabled,
      defenceMinutes: assessment.defenceMinutes,
    },
    scenario: {
      title: scenario.title,
      organisation: scenario.organisation,
      positionTitle: scenario.positionTitle,
      assistantName: scenario.assistantName ?? null,
      assistantShortName: scenario.assistantShortName ?? null,
      assessmentMode: assessment.assessmentMode,
      modePolicy,
      // taskCount reports ALL tasks so the landing page accurately describes
      // what the candidate will encounter. `tasks` below is narrowed to the
      // memo_ai subset — those are the tasks the AssessmentView renders
      // directly. Email and chat tasks come in through /api/assess/events
      // and are rendered by the LiveEventsOverlay.
      taskCount: scenario.tasks.length,
      tasks: scenario.tasks
        .filter(isMemoAiTask)
        .map((t) => ({
          number: t.number,
          kind: t.kind,
          title: t.title,
          briefMarkdown: personaliseBrief(t.briefMarkdown, candidate.name),
          totalMarks: t.totalMarks,
          codeExecutionEnabled: t.codeExecutionEnabled === true,
          kubernetesLab: t.kubernetesLab ?? null,
          awsLab: t.awsLab ?? null,
          exhibitTitle: t.exhibitTitle,
          exhibitHtml: t.exhibitHtml,
          deliverableLabel: t.deliverableLabel,
          deliverablePlaceholder: t.deliverablePlaceholder,
          taskId: t.taskId ?? null,
          exhibitSourceId: t.exhibitSourceId ?? `${scenario.scenarioId}-task-${t.number}-exhibit`,
        })),
    },
    candidate: {
      anonymousId: candidate.anonymousId,
      startedAt: candidate.startedAt,
      deadline: candidate.deadline,
      submittedAt: candidate.submittedAt,
      workLockedAt: candidate.workLockedAt,
      toolDeclaration: candidate.toolDeclaration,
    },
    responses: responses.map((r) => ({
      taskNumber: r.taskNumber,
      content: r.content,
      wordCount: r.wordCount,
      updatedAt: r.updatedAt,
      sentAt: r.sentAt,
    })),
    interactions,
    evidenceBoard,
    defence,
  });
}
