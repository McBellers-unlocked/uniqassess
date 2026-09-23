import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { labConfigIssue } from "@/lib/recruit/kubernetes-lab-config";
import {
  assertScenarioAccess,
  requireScenarioBuilder,
} from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * PATCH  /api/admin/recruitment/scenarios/[id]/tasks/[taskId] — edit a task
 * DELETE /api/admin/recruitment/scenarios/[id]/tasks/[taskId] — delete a task
 *
 * PATCH accepts any subset of: title, briefMarkdown, totalMarks, number,
 * systemPrompt, exhibitId, deliverableLabel, deliverablePlaceholder, config.
 * Changing `kind` is not allowed (delete + recreate instead — the kind-specific
 * children would orphan).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; taskId: string } }
) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;
  const denied = await assertScenarioAccess(auth, params.id);
  if (denied) return denied;

  const existing = await prisma.recruitmentScenarioTask.findUnique({
    where: { id: params.taskId },
  });
  if (!existing || existing.scenarioId !== params.id) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));

  if (body.kind !== undefined && body.kind !== existing.kind) {
    return NextResponse.json(
      { error: "changing task kind is not supported; delete and recreate the task" },
      { status: 400 }
    );
  }

  const data: Record<string, unknown> = {};

  if (body.title !== undefined) data.title = String(body.title).trim();
  if (body.briefMarkdown !== undefined) data.briefMarkdown = String(body.briefMarkdown);
  if (body.totalMarks !== undefined) {
    const v = Number(body.totalMarks);
    if (!Number.isFinite(v) || v < 0 || v > 1000) {
      return NextResponse.json({ error: "totalMarks must be 0-1000" }, { status: 400 });
    }
    data.totalMarks = v;
  }
  if (body.systemPrompt !== undefined) {
    data.systemPrompt = body.systemPrompt === null ? null : String(body.systemPrompt);
  }
  if (body.exhibitId !== undefined) {
    if (body.exhibitId === null || body.exhibitId === "") {
      data.exhibitId = null;
    } else {
      const exhibit = await prisma.recruitmentScenarioExhibit.findUnique({
        where: { id: String(body.exhibitId) },
      });
      if (!exhibit || exhibit.scenarioId !== params.id) {
        return NextResponse.json({ error: "exhibitId does not belong to this scenario" }, { status: 400 });
      }
      data.exhibitId = body.exhibitId;
    }
  }
  if (body.deliverableLabel !== undefined) {
    data.deliverableLabel = body.deliverableLabel === null ? null : String(body.deliverableLabel);
  }
  if (body.deliverablePlaceholder !== undefined) {
    data.deliverablePlaceholder = body.deliverablePlaceholder === null ? null : String(body.deliverablePlaceholder);
  }
  if (body.config !== undefined) {
    const issue = labConfigIssue(body.config, existing.kind);
    if (issue) return NextResponse.json({ error: issue }, { status: 400 });
    data.config = body.config; // trusted admin; Prisma will serialise
  }

  // Number changes need a 3-step swap when the target ordinal is taken,
  // because the [scenarioId, number] unique index is checked per row and a
  // single UPDATE either way collides on the conflicting task.
  let numberSwap: { v: number; conflict: { id: string; number: number } } | null = null;
  let numberAssign: number | null = null;
  if (body.number !== undefined) {
    const v = Number(body.number);
    if (!Number.isFinite(v) || v < 1) {
      return NextResponse.json({ error: "number must be a positive integer" }, { status: 400 });
    }
    if (v !== existing.number) {
      const conflict = await prisma.recruitmentScenarioTask.findFirst({
        where: { scenarioId: params.id, number: v, NOT: { id: params.taskId } },
        select: { id: true, number: true },
      });
      if (conflict) {
        numberSwap = { v, conflict };
      } else {
        numberAssign = v;
      }
    }
  }

  if (numberSwap) {
    // Park the conflicting task at a negative sentinel (real ordinals are
    // >= 1 so -conflict.number can't collide), update self with all pending
    // field changes + the new number, then move the conflict into self's
    // old slot. Wrapped in a transaction so a partial swap can't leave the
    // scenario with sentinel-numbered or duplicate rows.
    const sentinel = -numberSwap.conflict.number;
    await prisma.$transaction([
      prisma.recruitmentScenarioTask.update({
        where: { id: numberSwap.conflict.id },
        data: { number: sentinel },
      }),
      prisma.recruitmentScenarioTask.update({
        where: { id: existing.id },
        data: { ...data, number: numberSwap.v },
      }),
      prisma.recruitmentScenarioTask.update({
        where: { id: numberSwap.conflict.id },
        data: { number: existing.number },
      }),
    ]);
  } else {
    if (numberAssign !== null) data.number = numberAssign;
    await prisma.recruitmentScenarioTask.update({
      where: { id: params.taskId },
      data,
    });
  }

  await prisma.recruitmentScenario.update({
    where: { id: params.id },
    data: { updatedAt: new Date() },
  });

  const task = await prisma.recruitmentScenarioTask.findUnique({
    where: { id: params.taskId },
  });
  return NextResponse.json({ task });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string; taskId: string } }
) {
  const auth = await requireScenarioBuilder();
  if (!auth.ok) return auth.response;
  const denied = await assertScenarioAccess(auth, params.id);
  if (denied) return denied;

  const existing = await prisma.recruitmentScenarioTask.findUnique({
    where: { id: params.taskId },
  });
  if (!existing || existing.scenarioId !== params.id) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  await prisma.recruitmentScenarioTask.delete({ where: { id: params.taskId } });
  // Renumber remaining tasks so ordinals stay contiguous. Shift everything
  // with number > deleted.number down by one.
  await prisma.recruitmentScenarioTask.updateMany({
    where: { scenarioId: params.id, number: { gt: existing.number } },
    data: { number: { decrement: 1 } },
  });
  await prisma.recruitmentScenario.update({
    where: { id: params.id },
    data: { updatedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
