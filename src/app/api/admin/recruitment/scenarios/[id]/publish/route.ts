import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  assertScenarioAccess,
  requireScenarioBuilder,
} from "@/lib/admin-auth";
import { evaluatePublicationReadiness } from "@/lib/recruit/validation/publication-readiness";
import { getScenarioContentHash } from "@/lib/recruit/scenario-content-hash";
import { labConfigIssue, taskKubernetesLab } from "@/lib/recruit/kubernetes-lab-config";
import { resolveRunnerSettings } from "@/lib/recruit/kubernetes-lab-runner";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/recruitment/scenarios/[id]/publish
 *
 * Validates the scenario is ready, then flips status to "published" and
 * stamps publishedAt. Validation rules (MVP):
 *   - at least one task
 *   - each task has a title and briefMarkdown
 *   - memo_ai tasks: systemPrompt AND exhibitId set
 *   - email_inbox tasks: at least one email
 *   - chat tasks: exactly one chat script with persona name + system prompt
 *   - totalMinutes sane
 *
 * Archiving / unpublishing uses { action: "archive" | "unpublish" } in the body.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;
  const denied = await assertScenarioAccess(auth, params.id);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "publish");

  const scenario = await prisma.recruitmentScenario.findUnique({
    where: { id: params.id },
    include: {
      tasks: {
        include: { emails: true, chatScripts: true },
        orderBy: { number: "asc" },
      },
      validationRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      reviews: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!scenario) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (action === "archive") {
    // Block archive if still assigned to any non-closed assessment.
    const active = await prisma.recruitmentAssessment.count({
      where: { customScenarioId: scenario.id, closeDate: { gt: new Date() } },
    });
    if (active > 0) {
      return NextResponse.json(
        { error: `${active} active assessment(s) use this scenario; wait for them to close.` },
        { status: 409 }
      );
    }
    const updated = await prisma.recruitmentScenario.update({
      where: { id: scenario.id },
      data: { status: "archived" },
    });
    return NextResponse.json({ scenario: updated });
  }

  if (action === "unpublish") {
    const inUse = await prisma.recruitmentAssessment.count({
      where: { customScenarioId: scenario.id },
    });
    if (inUse > 0) {
      return NextResponse.json(
        { error: "Cannot unpublish: scenario is in use. Archive when assessments close." },
        { status: 409 }
      );
    }
    const updated = await prisma.recruitmentScenario.update({
      where: { id: scenario.id },
      data: { status: "draft", publishedAt: null },
    });
    return NextResponse.json({ scenario: updated });
  }

  // publish — run validation
  const errors: string[] = [];
  if (scenario.tasks.length === 0) {
    errors.push("Scenario must have at least one task.");
  }
  const labRunnerAvailable = scenario.tasks.some((t) => taskKubernetesLab(t.config))
    ? Boolean(await resolveRunnerSettings().catch(() => null)) : false;
  scenario.tasks.forEach((t, idx) => {
    const prefix = `Task ${t.number} (${t.title || `#${idx + 1}`})`;
    const labIssue = labConfigIssue(t.config, t.kind);
    if (labIssue) errors.push(`${prefix}: ${labIssue}`);
    if (taskKubernetesLab(t.config) && !labRunnerAvailable) {
      errors.push(`${prefix}: configure and enable the dedicated Kubernetes lab runner before publishing a practical lab.`);
    }
    if (!t.title?.trim()) errors.push(`${prefix}: title required`);
    if (!t.briefMarkdown?.trim()) errors.push(`${prefix}: brief required`);
    if (t.totalMarks == null || t.totalMarks < 0) {
      errors.push(`${prefix}: totalMarks must be >= 0`);
    }
    if (t.kind === "memo_ai") {
      if (!t.systemPrompt?.trim()) errors.push(`${prefix}: AI system prompt required`);
      if (!t.exhibitId) errors.push(`${prefix}: exhibit required`);
      if (!t.deliverableLabel?.trim()) errors.push(`${prefix}: deliverable label required`);
    } else if (t.kind === "email_inbox") {
      if (t.emails.length === 0) errors.push(`${prefix}: at least one scripted email required`);
      t.emails.forEach((e, ei) => {
        const p2 = `${prefix} email #${ei + 1}`;
        if (!e.senderName?.trim()) errors.push(`${p2}: sender name required`);
        if (!e.senderEmail?.trim()) errors.push(`${p2}: sender email required`);
        if (!e.subject?.trim()) errors.push(`${p2}: subject required`);
        if (!e.bodyHtml?.trim()) errors.push(`${p2}: body required`);
        if (e.triggerOffsetSeconds < 0) errors.push(`${p2}: triggerOffsetSeconds must be >= 0`);
      });
    } else if (t.kind === "chat") {
      if (t.chatScripts.length !== 1) {
        errors.push(`${prefix}: exactly one chat script required (found ${t.chatScripts.length})`);
      } else {
        const s = t.chatScripts[0];
        const p2 = `${prefix} chat script`;
        if (!s.personaName?.trim()) errors.push(`${p2}: persona name required`);
        if (!s.personaRole?.trim()) errors.push(`${p2}: persona role required`);
        if (!s.openerMessage?.trim()) errors.push(`${p2}: opener message required`);
        if (!s.systemPrompt?.trim()) errors.push(`${p2}: system prompt required`);
        if (s.maxTurns < 1 || s.maxTurns > 30) errors.push(`${p2}: maxTurns must be 1-30`);
      }
    } else {
      errors.push(`${prefix}: unknown kind "${t.kind}"`);
    }
  });

  if (errors.length > 0) {
    return NextResponse.json({ error: "Validation failed", details: errors }, { status: 400 });
  }

  const readiness = await evaluatePublicationReadiness(scenario);
  const overrideReason = String(body.overrideReason ?? "").trim();
  if (!readiness.ready && !overrideReason) {
    return NextResponse.json(
      { error: "Publication readiness requirements are not complete", details: readiness.blockers, readiness },
      { status: 409 }
    );
  }
  if (!readiness.ready && overrideReason.length < 20) {
    return NextResponse.json({ error: "A publication override requires a specific reason of at least 20 characters." }, { status: 400 });
  }
  let publicationOverride = null;
  if (!readiness.ready) {
    publicationOverride = await prisma.recruitmentScenarioPublicationOverride.create({
      data: {
        scenarioId: scenario.id,
        scenarioHash: (await getScenarioContentHash(scenario.id)) ?? "unavailable",
        reason: auth.role === "DEMO" ? `[DEMONSTRATION OVERRIDE] ${overrideReason}` : overrideReason,
        userId: auth.userId,
      },
    });
  }

  const updated = await prisma.recruitmentScenario.update({
    where: { id: scenario.id },
    data: { status: "published", publishedAt: new Date() },
  });

  return NextResponse.json({ scenario: updated, readiness, publicationOverride, formallyApproved: readiness.ready });
}
