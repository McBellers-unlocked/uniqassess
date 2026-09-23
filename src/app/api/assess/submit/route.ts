import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadCandidate, verifySessionCookie } from "@/lib/recruit/candidate-auth";
import { createCandidateDefence } from "@/lib/recruit/defence-service";
import { getAssessmentModePolicy } from "@/lib/recruit/assessment-modes";
import { closeCandidateLabs } from "@/lib/recruit/kubernetes-lab-service";

export const dynamic = "force-dynamic";

/**
 * Submit the entire assessment. Idempotent.
 *
 * Body: { token }. Marks status=submitted, sets submittedAt, locks further
 * mutations. The candidate UI then transitions to the thank-you screen.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token ?? "").trim();
    const result = await loadCandidate(token);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    if (result.candidate.status === "submitted") {
      return NextResponse.json({ ok: true, alreadySubmitted: true });
    }
    if (result.candidate.status !== "started") {
      return NextResponse.json({ error: "Cannot submit; assessment not in progress." }, { status: 400 });
    }
    const cookieOk = await verifySessionCookie(result.candidate);
    if (!cookieOk) return NextResponse.json({ error: "Session mismatch." }, { status: 403 });

    const policy = getAssessmentModePolicy(result.assessment.assessmentMode);
    const declaration = body.toolDeclaration && typeof body.toolDeclaration === "object"
      ? body.toolDeclaration
      : null;
    if (policy.toolDeclarationRequired && !declaration) {
      return NextResponse.json({ error: "A tool-use declaration is required in Open Agent Mode." }, { status: 400 });
    }

    const now = new Date();
    if (declaration) {
      await prisma.$transaction([
        prisma.recruitmentCandidate.update({
          where: { id: result.candidate.id },
          data: { toolDeclaration: declaration, toolDeclarationSubmittedAt: now },
        }),
        prisma.recruitmentActivityEvent.create({
          data: { candidateId: result.candidate.id, eventType: "tool_declaration", metadata: { selfDeclared: true } },
        }),
      ]);
    }
    if (result.assessment.defenceEnabled) {
      const defence = await createCandidateDefence(result.candidate.id, result.assessment);
      await closeCandidateLabs(result.candidate.id).catch(() => {});
      return NextResponse.json({ ok: true, defenceRequired: true, defenceDeadline: defence.deadline });
    }
    await prisma.recruitmentCandidate.update({
      where: { id: result.candidate.id },
      data: { status: "submitted", submittedAt: now, workLockedAt: now },
    });
    await prisma.recruitmentActivityEvent.create({ data: { candidateId: result.candidate.id, eventType: "final_submission" } });
    await closeCandidateLabs(result.candidate.id).catch(() => {});
    return NextResponse.json({ ok: true, submittedAt: now });
  } catch (e) {
    console.error("[assess submit]", e);
    return NextResponse.json({ error: (e as Error).message || "Submit failed" }, { status: 500 });
  }
}
