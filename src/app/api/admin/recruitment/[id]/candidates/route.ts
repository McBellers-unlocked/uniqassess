import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  assertAssessmentAccess,
  requireScenarioBuilder,
} from "@/lib/admin-auth";
import { generateToken, indexToAnonymousId, anonymousIdToIndex } from "@/lib/recruit/tokens";
import { getScenarioForAssessment } from "@/lib/recruit/scenario-loader";
import { syntheticPilotCohortRestriction } from "@/lib/recruit/controlled-pilot";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/recruitment/[id]/candidates
 *   body: { entries: [{name, email}, ...] }
 *
 * Bulk-add candidates to an assessment. Generates a unique token (FAM-XXXX
 * style — the prefix is derived from the scenario slug) and assigns the next
 * anonymous-ID letter sequence per candidate. Idempotent on (assessmentId,
 * email): existing emails are skipped with a `skipped` count returned.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;
  const denied = await assertAssessmentAccess(auth, params.id);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const entriesRaw = Array.isArray(body.entries) ? body.entries : [];
  if (entriesRaw.length === 0) {
    return NextResponse.json({ error: "entries[] required" }, { status: 400 });
  }
  if (entriesRaw.length > 200) {
    return NextResponse.json({ error: "max 200 entries per call" }, { status: 400 });
  }

  // Validate + de-dup within the payload itself
  type Entry = { name: string; email: string };
  const seenInPayload = new Set<string>();
  const entries: Entry[] = [];
  for (const e of entriesRaw) {
    const name = String(e?.name ?? "").trim();
    const email = String(e?.email ?? "").trim().toLowerCase();
    if (!name || name.length < 2) continue;
    if (!/.+@.+\..+/.test(email)) continue;
    if (seenInPayload.has(email)) continue;
    seenInPayload.add(email);
    entries.push({ name, email });
  }
  if (entries.length === 0) {
    return NextResponse.json({ error: "no valid entries" }, { status: 400 });
  }

  const assessment = await prisma.recruitmentAssessment.findUnique({ where: { id: params.id }, include: {
    assessmentVersion: { select: { scenarioSnapshot: true } },
    customScenario: { select: { roleEvidenceRecord: true } },
  } });
  if (!assessment) return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  const pilotRestriction = syntheticPilotCohortRestriction(assessment.assessmentVersion?.scenarioSnapshot, assessment.customScenario?.roleEvidenceRecord);
  if (pilotRestriction) return NextResponse.json({ error: pilotRestriction }, { status: 409 });

  const scenario = await getScenarioForAssessment(assessment);
  const tokenPrefix = (scenario?.slug.toUpperCase().replace(/[^A-Z0-9]/g, "") || "ASS").slice(0, 6);

  const existing = await prisma.recruitmentCandidate.findMany({
    where: { assessmentId: assessment.id },
    select: { email: true, anonymousId: true },
  });
  const existingEmails = new Set(existing.map((r) => r.email));
  // Use max-existing-index + 1 so deleted slots leave gaps but never collide
  // with a freshly-added candidate's anonymous ID.
  const maxIdx = existing.length === 0
    ? -1
    : Math.max(...existing.map((r) => anonymousIdToIndex(r.anonymousId)));

  const created: Array<{ name: string; email: string; token: string; anonymousId: string }> = [];
  const skipped: string[] = [];
  let nextAnonIdx = maxIdx + 1;
  for (const e of entries) {
    if (existingEmails.has(e.email)) {
      skipped.push(e.email);
      continue;
    }
    const anonymousId = indexToAnonymousId(nextAnonIdx++);
    // Retry token generation up to 5x in the unlikely case of a collision
    let token = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateToken(tokenPrefix);
      const hit = await prisma.recruitmentCandidate.findUnique({ where: { token: candidate } });
      if (!hit) { token = candidate; break; }
    }
    if (!token) {
      return NextResponse.json({ error: "token generation collision; retry" }, { status: 500 });
    }
    await prisma.recruitmentCandidate.create({
      data: {
        assessmentId: assessment.id,
        name: e.name,
        email: e.email,
        token,
        anonymousId,
      },
    });
    created.push({ name: e.name, email: e.email, token, anonymousId });
  }

  return NextResponse.json({ created, skipped, totalAfter: existing.length + created.length });
}

/**
 * GET /api/admin/recruitment/[id]/candidates
 *   Returns the full candidate list with URLs (admin sees real names + tokens).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;
  const denied = await assertAssessmentAccess(auth, params.id);
  if (denied) return denied;

  const assessment = await prisma.recruitmentAssessment.findUnique({ where: { id: params.id } });
  if (!assessment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const candidates = await prisma.recruitmentCandidate.findMany({
    where: { assessmentId: assessment.id },
    orderBy: { anonymousId: "asc" },
    select: {
      id: true, name: true, email: true, token: true, anonymousId: true,
      status: true, startedAt: true, submittedAt: true,
    },
  });

  const origin = process.env.NEXTAUTH_URL || `https://${request.headers.get("host") ?? "uniqassess.example"}`;
  const enriched = candidates.map((c) => ({
    ...c,
    assessmentUrl: `${origin}/assess/${assessment.scenarioSlug}?token=${c.token}`,
  }));

  return NextResponse.json({
    assessment: { id: assessment.id, title: assessment.title, scenarioSlug: assessment.scenarioSlug },
    candidates: enriched,
  });
}
