import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  assertScenarioAccess,
  assessmentScopeWhere,
  requireScenarioBuilder,
} from "@/lib/admin-auth";
import { getRecruitScenarioById } from "@/lib/recruit/fam-p4-2026";
import { getDbScenarioById } from "@/lib/recruit/scenario-loader";
import { buildCohortPolicySnapshot } from "@/lib/recruit/assessment-modes";
import { getOrCreateAssessmentVersion } from "@/lib/recruit/assessment-versions";
import { awsLabPublicationIssues, taskAwsLab } from "@/lib/recruit/aws-lab-config";
import { awsLabRuntimeAvailable } from "@/lib/recruit/aws-lab-runner";

export const dynamic = "force-dynamic";

/**
 * GET   /api/admin/recruitment           — list assessments (admin only)
 * POST  /api/admin/recruitment           — create assessment
 *   body: { title, scenarioId, openDate, closeDate, totalMinutes? }
 */
export async function GET() {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;

  // DEMO users see only their own assessments; ADMIN sees all.
  const assessments = await prisma.recruitmentAssessment.findMany({
    where: assessmentScopeWhere(auth),
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { candidates: true } },
    },
  });
  // Status counts per assessment
  const enriched = await Promise.all(
    assessments.map(async (a) => {
      const grouped = await prisma.recruitmentCandidate.groupBy({
        by: ["status"],
        where: { assessmentId: a.id },
        _count: { _all: true },
      });
      const counts = { invited: 0, started: 0, submitted: 0, expired: 0 } as Record<string, number>;
      for (const g of grouped) counts[g.status] = g._count._all;
      return { ...a, candidateCount: a._count.candidates, counts };
    })
  );
  return NextResponse.json({ assessments: enriched });
}

export async function POST(request: NextRequest) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => ({}));
  const title = String(body.title ?? "").trim();
  const scenarioId = body.scenarioId ? String(body.scenarioId).trim() : "";
  // customScenarioId: cuid of a DB-backed RecruitmentScenario. Takes
  // precedence over scenarioId. Client sends exactly one depending on
  // whether the admin picked a legacy scenario or a custom one.
  const customScenarioId = body.customScenarioId ? String(body.customScenarioId).trim() : "";
  const openDate = body.openDate ? new Date(body.openDate) : null;
  const closeDate = body.closeDate ? new Date(body.closeDate) : null;
  const totalMinutes = Number(body.totalMinutes ?? 0);

  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  if (!scenarioId && !customScenarioId) {
    return NextResponse.json({ error: "scenarioId or customScenarioId required" }, { status: 400 });
  }

  // Resolve scenario: custom (DB) takes precedence. We mirror slug + scenarioId
  // onto the assessment row so URLs and legacy queries keep working.
  let resolvedSlug = "";
  let resolvedScenarioId = "";
  let defaultMinutes = 90;
  let resolvedCustomId: string | null = null;
  let assessmentMode: "EVIDENCE" | "COPILOT" | "OPEN_AGENT" = "EVIDENCE";
  let modePolicyVersion = "1";
  let defenceEnabled = false;
  let defenceQuestionCount = 2;
  let defenceMinutes = 5;
  let assessmentVersionId: string | null = null;

  if (customScenarioId) {
    // DEMO users can only build cohorts on top of scenarios they
    // themselves created — assertScenarioAccess returns 403/404 if not.
    const denied = await assertScenarioAccess(auth, customScenarioId);
    if (denied) return denied;

    const dbScenario = await getDbScenarioById(customScenarioId);
    if (!dbScenario) {
      return NextResponse.json({ error: `Unknown customScenarioId: ${customScenarioId}` }, { status: 400 });
    }
    // Require published status so drafts can't be assigned to a cohort.
    const row = await prisma.recruitmentScenario.findUnique({
      where: { id: customScenarioId },
      include: { tasks: { select: { number: true, title: true, kind: true, config: true } } },
    });
    if (row?.status !== "published") {
      return NextResponse.json({ error: "Scenario must be published before it can be used for a cohort" }, { status: 400 });
    }
    // Published scenarios remain editable. Check their current content before
    // freezing it so adding an unavailable AWS draft cannot bypass publication.
    const awsAvailable = row.tasks.some((task) => taskAwsLab(task.config)) ? await awsLabRuntimeAvailable() : false;
    const labIssues = awsLabPublicationIssues(row.tasks, awsAvailable);
    if (labIssues.length) return NextResponse.json({ error: "Practical lab setup is incomplete", details: labIssues }, { status: 409 });
    resolvedSlug = dbScenario.slug;
    resolvedScenarioId = dbScenario.scenarioId;
    defaultMinutes = dbScenario.defaultTotalMinutes;
    resolvedCustomId = customScenarioId;
    const snapshot = buildCohortPolicySnapshot(row);
    assessmentMode = snapshot.assessmentMode;
    modePolicyVersion = snapshot.modePolicyVersion;
    defenceEnabled = snapshot.defenceEnabled;
    defenceQuestionCount = snapshot.defenceQuestionCount;
    defenceMinutes = snapshot.defenceMinutes;
    const version = await getOrCreateAssessmentVersion(customScenarioId, auth.userId);
    assessmentVersionId = version.id;
  } else {
    // Built-in code-based scenarios are off-limits to DEMO sessions —
    // they aren't owned by any user and would let a demo prospect run
    // assessments against templates the operator hasn't reviewed.
    if (auth.role === "DEMO") {
      return NextResponse.json(
        { error: "Demo sessions can only build assessments from scenarios you've authored." },
        { status: 403 }
      );
    }
    const scenario = getRecruitScenarioById(scenarioId);
    if (!scenario) return NextResponse.json({ error: `Unknown scenarioId: ${scenarioId}` }, { status: 400 });
    resolvedSlug = scenario.slug;
    resolvedScenarioId = scenario.scenarioId;
    defaultMinutes = scenario.defaultTotalMinutes;
  }

  if (!openDate || !closeDate || isNaN(openDate.getTime()) || isNaN(closeDate.getTime())) {
    return NextResponse.json({ error: "openDate and closeDate must be valid dates" }, { status: 400 });
  }
  if (closeDate <= openDate) {
    return NextResponse.json({ error: "closeDate must be after openDate" }, { status: 400 });
  }
  const minutes = totalMinutes > 0 ? totalMinutes : defaultMinutes;

  const created = await prisma.recruitmentAssessment.create({
    data: {
      title,
      scenarioSlug: resolvedSlug,
      scenarioId: resolvedScenarioId,
      customScenarioId: resolvedCustomId,
      totalMinutes: minutes,
      openDate,
      closeDate,
      createdById: auth.session.user.id,
      assessmentMode,
      modePolicyVersion,
      defenceEnabled,
      defenceQuestionCount,
      defenceMinutes,
      assessmentVersionId,
    },
  });
  return NextResponse.json({ assessment: created });
}
