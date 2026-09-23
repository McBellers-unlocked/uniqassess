import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { labConfigIssue } from "@/lib/recruit/kubernetes-lab-config";
import { awsLabConfigIssue } from "@/lib/recruit/aws-lab-config";
import {
  assertScenarioAccess,
  requireScenarioBuilder,
} from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

const VALID_KINDS = ["memo_ai", "email_inbox", "chat"] as const;
type TaskKind = (typeof VALID_KINDS)[number];

/**
 * POST /api/admin/recruitment/scenarios/[id]/tasks
 *   body: { kind, title?, briefMarkdown?, totalMarks? }
 *
 * Appends a new task to the scenario at the next available `number`.
 * Fields specific to each kind are left to PATCH after creation so the
 * editor can render kind-appropriate forms on an otherwise empty row.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;
  const denied = await assertScenarioAccess(auth, params.id);
  if (denied) return denied;

  const scenario = await prisma.recruitmentScenario.findUnique({
    where: { id: params.id },
    select: { id: true, status: true },
  });
  if (!scenario) return NextResponse.json({ error: "Scenario not found" }, { status: 404 });
  if (scenario.status === "archived") {
    return NextResponse.json({ error: "cannot edit an archived scenario" }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind ?? "") as TaskKind;
  if (!VALID_KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind must be one of ${VALID_KINDS.join(", ")}` }, { status: 400 });
  }
  const configIssue = labConfigIssue(body.config, kind) ?? awsLabConfigIssue(body.config, kind);
  if (configIssue) return NextResponse.json({ error: configIssue }, { status: 400 });
  const title = body.title ? String(body.title).trim() : defaultTitle(kind);
  const briefMarkdown = body.briefMarkdown ? String(body.briefMarkdown) : "";
  const totalMarks = Number.isFinite(body.totalMarks) ? Number(body.totalMarks) : 0;

  // Next ordinal
  const agg = await prisma.recruitmentScenarioTask.aggregate({
    where: { scenarioId: params.id },
    _max: { number: true },
  });
  const nextNumber = (agg._max.number ?? 0) + 1;

  const task = await prisma.recruitmentScenarioTask.create({
    data: {
      scenarioId: params.id,
      number: nextNumber,
      kind,
      title,
      briefMarkdown,
      totalMarks,
      ...(body.config !== undefined ? { config: body.config } : {}),
    },
  });

  // When publishing a scenario we also want the scenario.updatedAt bumped so
  // list pages sort recent edits to the top.
  await prisma.recruitmentScenario.update({
    where: { id: params.id },
    data: { updatedAt: new Date() },
  });

  return NextResponse.json({ task });
}

function defaultTitle(kind: TaskKind): string {
  switch (kind) {
    case "memo_ai": return "Untitled memo task";
    case "email_inbox": return "Untitled inbox task";
    case "chat": return "Untitled chat task";
  }
}
