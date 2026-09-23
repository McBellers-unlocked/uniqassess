import type { PrismaClient } from "@prisma/client";
import { createKubernetesLabService } from "./kubernetes-lab-service";
import { resolveRunnerCleanupSettings, runnerCleanupRequest } from "./kubernetes-lab-runner";
import { LAB_ACTIVE_COMMAND_STATUSES, LAB_TERMINAL_STATUSES } from "./kubernetes-lab-config";

/** Trusted scheduled work only: no provision or command dispatch, including when the feature is off. */
export async function reconcileKubernetesLabs(prisma: PrismaClient) {
  if (!await resolveRunnerCleanupSettings()) throw new Error("Configure the lab runner server environment before reconciliation.");
  const { refreshLab } = createKubernetesLabService({
    db: prisma, cleanupRequest: runnerCleanupRequest, cleanupSettings: resolveRunnerCleanupSettings,
  });
  const now = new Date();
  const sessions = await prisma.recruitmentLabSession.findMany({
    where: { OR: [
      { cleanupCompletedAt: null, OR: [
        { expiresAt: { lte: now } }, { status: { in: LAB_TERMINAL_STATUSES } },
        { candidate: { workLockedAt: { not: null } } }, { candidate: { status: { not: "started" } } },
      ] },
      { commands: { some: { status: { in: LAB_ACTIVE_COMMAND_STATUSES } } } },
    ] },
    orderBy: { updatedAt: "asc" }, take: 100,
    select: { id: true, candidateId: true, taskNumber: true },
  });
  let failed = 0;
  let examined = 0;
  const batchDeadline = Date.now() + 20_000;
  for (let offset = 0; offset < sessions.length; offset += 4) {
    if (Date.now() >= batchDeadline) break;
    const batch = await Promise.allSettled(sessions.slice(offset, offset + 4).map(async (session) => {
      try { await refreshLab(session.candidateId, session.taskNumber, true, { allowDispatch: false }); }
      catch (error) {
        await prisma.recruitmentLabSession.update({ where: { id: session.id }, data: { error: "Scheduled lab reconciliation could not reach the runner. Retry required." } });
        throw error;
      }
    }));
    failed += batch.filter((item) => item.status === "rejected").length;
    examined += batch.length;
  }
  return { examined, failed, deferred: sessions.length - examined };
}
