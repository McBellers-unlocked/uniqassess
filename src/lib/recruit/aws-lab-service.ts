import type { PrismaClient, RecruitmentAwsLabSession, RecruitmentAwsLabCommand } from "@prisma/client";
import {
  LAB_ACTIVE_COMMAND_STATUSES, LAB_MAX_COMMANDS, LAB_MAX_MINUTES, LAB_TERMINAL_STATUSES,
  labWorkIsActive, labCommandIssue,
} from "./kubernetes-lab-config";
import {
  LabError, parseRunnerCommand, parseRunnerSession, runnerRequest, runnerCleanupRequest, resolveRunnerSettings, resolveRunnerCleanupSettings,
  type RunnerCommand, type RunnerSession, type RunnerSettings,
} from "./aws-lab-runner";

type LabDatabase = Pick<PrismaClient, "$transaction" | "recruitmentCandidate" | "recruitmentAwsLabSession" | "recruitmentAwsLabCommand" | "recruitmentActivityEvent">;
type SettingsProvider = () => RunnerSettings | null | Promise<RunnerSettings | null>;
export type LabServiceDependencies = {
  db: LabDatabase; request?: typeof runnerRequest; settings?: SettingsProvider;
  cleanupRequest?: typeof runnerCleanupRequest; cleanupSettings?: SettingsProvider;
};

/** Dependency boundary allows lifecycle tests without a database or cluster. */
export function createAwsLabService({
  db, request = runnerRequest, settings = resolveRunnerSettings,
  cleanupRequest = request, cleanupSettings = settings,
}: LabServiceDependencies) {
  async function readLab(candidateId: string, taskNumber: number) {
    const session = await db.recruitmentAwsLabSession.findUnique({
      where: { candidateId_taskNumber: { candidateId, taskNumber } },
      include: { commands: { orderBy: { createdAt: "asc" } } },
    });
    // Previously saved evidence stays readable during a secret-store outage.
    let available = false;
    try { available = Boolean(await settings()); } catch { /* Runtime operations remain unavailable. */ }
    return {
      available,
      session: session ? { id: session.id, status: session.status, expiresAt: session.expiresAt } : null,
      commands: session?.commands.map((c) => ({
        id: c.id, command: c.command, status: c.status, stdout: c.stdout, stderr: c.stderr,
        exitCode: c.exitCode, truncated: c.truncated, createdAt: c.createdAt,
        startedAt: c.startedAt, finishedAt: c.finishedAt,
      })) ?? [],
    };
  }

  async function persistCommand(sessionId: string, result: RunnerCommand) {
    // Terminal evidence is append-only. A delayed response cannot turn completed into running.
    await db.recruitmentAwsLabCommand.updateMany({
      where: { id: result.id, sessionId, status: { in: LAB_ACTIVE_COMMAND_STATUSES } },
      data: {
        status: result.status, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
        truncated: result.truncated,
        ...(result.startedAt ? { startedAt: new Date(result.startedAt) } : {}),
        ...(result.finishedAt ? { finishedAt: new Date(result.finishedAt) } : {}),
      },
    });
  }

  async function persistSession(session: RecruitmentAwsLabSession, remote: RunnerSession) {
    if (remote.snapshot || remote.cleanupComplete) {
      await db.recruitmentAwsLabSession.update({
        where: { id: session.id },
        data: {
          ...(remote.snapshot ? { snapshot: remote.snapshot } : {}),
          ...(remote.cleanupComplete ? { error: null, cleanupCompletedAt: session.cleanupCompletedAt ?? new Date() } : {}),
        },
      });
    }
    await db.recruitmentAwsLabSession.updateMany({
      where: { id: session.id, status: { notIn: LAB_TERMINAL_STATUSES } },
      data: { status: remote.status },
    });
  }

  async function provision(session: RecruitmentAwsLabSession): Promise<RunnerSession | null> {
    return db.$transaction(async (tx) => {
      // Submission updates the same candidate row. Hold this lock across the
      // bounded broker call so provisioning cannot cross a work lock.
      await tx.$queryRaw`SELECT id FROM recruitment_candidates WHERE id = ${session.candidateId} FOR UPDATE`;
      const candidate = await tx.recruitmentCandidate.findUnique({ where: { id: session.candidateId } });
      const current = await tx.recruitmentAwsLabSession.findUnique({ where: { candidateId_taskNumber: { candidateId: session.candidateId, taskNumber: session.taskNumber } } });
      if (!candidate || !labWorkIsActive(candidate) || !current || current.id !== session.id
          || current.expiresAt <= new Date() || LAB_TERMINAL_STATUSES.includes(current.status)) return null;
      const raw = await request(current.id, "PUT", { templateId: current.templateId, expiresAt: current.expiresAt.toISOString() });
      return parseRunnerSession(raw, current.id);
    }, { maxWait: 5_000, timeout: 12_000 });
  }

  async function dispatchCommand(session: RecruitmentAwsLabSession, command: RecruitmentAwsLabCommand): Promise<RunnerCommand | "closed" | "settled"> {
    return db.$transaction(async (tx) => {
      // Re-authorise under the submit lock immediately before remote dispatch.
      await tx.$queryRaw`SELECT id FROM recruitment_candidates WHERE id = ${session.candidateId} FOR UPDATE`;
      const candidate = await tx.recruitmentCandidate.findUnique({ where: { id: session.candidateId } });
      const current = await tx.recruitmentAwsLabSession.findUnique({ where: { candidateId_taskNumber: { candidateId: session.candidateId, taskNumber: session.taskNumber } } });
      if (!candidate || !labWorkIsActive(candidate) || !current || current.id !== session.id
          || current.status !== "ready" || current.expiresAt <= new Date()) return "closed";
      const saved = await tx.recruitmentAwsLabCommand.findUnique({ where: { id: command.id } });
      if (!saved || saved.sessionId !== current.id || !LAB_ACTIVE_COMMAND_STATUSES.includes(saved.status)) return "settled";
      const raw = await request(`${current.id}/commands`, "POST", { id: saved.id, command: saved.command });
      return parseRunnerCommand(raw, saved.id);
    }, { maxWait: 5_000, timeout: 12_000 });
  }

  async function syncCommands(session: RecruitmentAwsLabSession, mayDispatch: boolean, workClosed = true) {
    const pending = await db.recruitmentAwsLabCommand.findMany({
      where: { sessionId: session.id, status: { in: LAB_ACTIVE_COMMAND_STATUSES } },
      orderBy: { createdAt: "asc" }, take: 1,
    });
    for (const command of pending) {
      let raw: unknown;
      try {
        raw = await cleanupRequest(`${session.id}/commands/${command.id}`);
      } catch (error) {
        if (!(error instanceof LabError) || error.status !== 404) throw error;
        if (!mayDispatch) {
          // A marker viewing a still-active assessment must not cancel a queued
          // command that its candidate request has not dispatched yet.
          if (!workClosed) continue;
          await db.recruitmentAwsLabCommand.updateMany({
            where: { id: command.id, sessionId: session.id, status: { in: LAB_ACTIVE_COMMAND_STATUSES } },
            data: { status: "failed", stderr: "The lab closed before this command was accepted.", finishedAt: new Date() },
          });
          continue;
        }
        // The original POST may have timed out. Always reuse the persisted ID;
        // the runner deduplicates and never executes it a second time.
        const retried = await dispatchCommand(session, command);
        if (retried === "closed") {
          await syncCommands(session, false);
          continue;
        }
        if (retried === "settled") continue;
        raw = retried;
      }
      await persistCommand(session.id, parseRunnerCommand(raw, command.id));
    }
  }

  async function refreshLab(candidateId: string, taskNumber: number, active: boolean, options: { allowDispatch?: boolean } = {}) {
    const session = await db.recruitmentAwsLabSession.findUnique({
      where: { candidateId_taskNumber: { candidateId, taskNumber } },
    });
    const reconciling = options.allowDispatch === false;
    if (!session || !await (reconciling ? cleanupSettings() : settings())) return;
    const candidate = await db.recruitmentCandidate.findUnique({ where: { id: candidateId } });
    const canWork = active && !!candidate && labWorkIsActive(candidate) && session.expiresAt > new Date();
    const closing = !canWork || LAB_TERMINAL_STATUSES.includes(session.status);
    let remote: RunnerSession;
    try { remote = parseRunnerSession(await (reconciling ? cleanupRequest : request)(session.id), session.id); }
    catch (error) {
      if (!(error instanceof LabError) || error.status !== 404) throw error;
      if (closing) {
        await stopLab(session, session.expiresAt <= new Date() ? "expired" : "stopped");
        return;
      }
      if (session.status !== "starting" || options.allowDispatch === false) throw error;
      const started = await provision(session);
      if (!started) { await stopLab(session, "stopped"); return; }
      remote = started;
    }
    // A runner cannot extend the assessment-owned lease.
    if (new Date(remote.expiresAt).getTime() > session.expiresAt.getTime()) {
      await stopLab(session, "failed");
      throw new LabError("The lab lease was invalid and has been closed.");
    }
    if ((closing || session.expiresAt <= new Date()) && !LAB_TERMINAL_STATUSES.includes(remote.status)) {
      await stopLab(session, session.expiresAt <= new Date() ? "expired" : "stopped");
      return;
    }
    await persistSession(session, remote);
    // Re-check the current work lock after the network request, not just the page state.
    const current = await db.recruitmentCandidate.findUnique({ where: { id: candidateId } });
    if ((!current || !labWorkIsActive(current)) && !LAB_TERMINAL_STATUSES.includes(remote.status)) {
      await stopLab(session, session.expiresAt <= new Date() ? "expired" : "stopped");
      return;
    }
    const canRun = !closing && !!current && labWorkIsActive(current) && session.expiresAt > new Date() && remote.status === "ready"
      && !LAB_TERMINAL_STATUSES.includes(session.status) && options.allowDispatch !== false;
    await syncCommands(session, canRun, closing || LAB_TERMINAL_STATUSES.includes(remote.status));
  }

  async function startLab(candidateId: string, taskNumber: number, templateId: string) {
    if (!await settings()) throw new LabError("The practical lab is not available. Contact your assessment organiser.");
    const session = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM recruitment_candidates WHERE id = ${candidateId} FOR UPDATE`;
      const candidate = await tx.recruitmentCandidate.findUnique({ where: { id: candidateId } });
      if (!candidate || !labWorkIsActive(candidate)) throw new LabError("Assessment work is locked or the time has expired.", 403);
      const previous = await tx.recruitmentAwsLabSession.findUnique({ where: { candidateId_taskNumber: { candidateId, taskNumber } } });
      if (previous) {
        if (previous.templateId !== templateId) throw new LabError("The lab configuration does not match this assessment.", 409);
        return previous;
      }
      const expiresAt = new Date(Math.min(candidate.deadline!.getTime(), Date.now() + LAB_MAX_MINUTES * 60_000));
      const created = await tx.recruitmentAwsLabSession.create({ data: { candidateId, taskNumber, templateId, expiresAt } });
      await tx.recruitmentActivityEvent.create({ data: { candidateId, taskNumber, eventType: "aws_lab_started", metadata: { templateId } } });
      return created;
    });
    if (LAB_TERMINAL_STATUSES.includes(session.status)) throw new LabError("This lab has closed and cannot be reset.", 409);
    await refreshLab(candidateId, taskNumber, true);
  }

  async function runLabCommand(candidateId: string, taskNumber: number, command: string, requestId: string) {
    const issue = labCommandIssue(command, requestId);
    if (issue) throw new LabError(issue, 400);
    if (!await settings()) throw new LabError("The practical lab is not available. Contact your assessment organiser.");
    const saved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM recruitment_candidates WHERE id = ${candidateId} FOR UPDATE`;
      const candidate = await tx.recruitmentCandidate.findUnique({ where: { id: candidateId } });
      if (!candidate || !labWorkIsActive(candidate)) throw new LabError("Assessment work is locked or the time has expired.", 403);
      const session = await tx.recruitmentAwsLabSession.findUnique({ where: { candidateId_taskNumber: { candidateId, taskNumber } } });
      if (!session || session.status !== "ready" || session.expiresAt <= new Date()) throw new LabError("Start the lab and wait until it is ready.", 409);
      const previous = await tx.recruitmentAwsLabCommand.findUnique({ where: { sessionId_requestId: { sessionId: session.id, requestId } } });
      if (previous) {
        if (previous.command !== command) throw new LabError("This request ID was already used for a different command.", 409);
        return { session, command: previous };
      }
      const pending = await tx.recruitmentAwsLabCommand.count({ where: { sessionId: session.id, status: { in: LAB_ACTIVE_COMMAND_STATUSES } } });
      if (pending) throw new LabError("Wait for the current command to finish, then refresh the lab.", 409);
      if (await tx.recruitmentAwsLabCommand.count({ where: { sessionId: session.id } }) >= LAB_MAX_COMMANDS) {
        throw new LabError(`This lab has reached its ${LAB_MAX_COMMANDS}-command limit.`, 429);
      }
      const created = await tx.recruitmentAwsLabCommand.create({ data: { sessionId: session.id, requestId, command } });
      return { session, command: created };
    });
    if (!LAB_ACTIVE_COMMAND_STATUSES.includes(saved.command.status)) return;
    const result = await dispatchCommand(saved.session, saved.command);
    if (result === "closed") {
      // An earlier timed-out attempt may already be running. Retrieve its actual
      // result rather than fabricating a failed execution.
      await syncCommands(saved.session, false);
      throw new LabError("Assessment work is locked or the time has expired.", 403);
    }
    if (result !== "settled") await persistCommand(saved.session.id, result);
  }

  async function stopLab(session: RecruitmentAwsLabSession, status: "stopped" | "expired" | "failed", includeCommandEvidence = true) {
    await db.recruitmentAwsLabSession.updateMany({
      where: { id: session.id, status: { notIn: LAB_TERMINAL_STATUSES } }, data: { status },
    });
    // DELETE is durable/idempotent at the runner, including before a delayed PUT.
    const remote = parseRunnerSession(await cleanupRequest(session.id, "DELETE"), session.id);
    await persistSession(session, remote);
    if (includeCommandEvidence) await syncCommands(session, false);
  }

  /** Submission must not fail because lab cleanup is unavailable. The runner also enforces the hard TTL. */
  async function closeCandidateLabs(candidateId: string) {
    const sessions = await db.recruitmentAwsLabSession.findMany({
      // Retry terminal rows too: a prior DELETE may have failed after saving the local lock.
      where: { candidateId },
    });
    await Promise.allSettled(sessions.map(async (session) => {
      // Submission is latency-sensitive; retain the receipt now and collect
      // command output in the periodic reconciler or when marking is opened.
      try { await stopLab(session, session.expiresAt <= new Date() ? "expired" : "stopped", false); }
      catch {
        await db.recruitmentAwsLabSession.update({
          where: { id: session.id }, data: { error: "Cleanup or final evidence retrieval needs reconciliation; the runner lease still expires automatically." },
        });
      }
    }));
  }
  /** Marking reconciles at most two sessions and never dispatches candidate work. */
  async function reconcileCandidateLabs(candidateId: string) {
    const sessions = await db.recruitmentAwsLabSession.findMany({ where: { candidateId }, orderBy: { taskNumber: "asc" }, take: 2 });
    await Promise.allSettled(sessions.map((session) => refreshLab(candidateId, session.taskNumber, true, { allowDispatch: false })));
  }

  return { readLab, refreshLab, startLab, runLabCommand, closeCandidateLabs, reconcileCandidateLabs };
}

type LabService = ReturnType<typeof createAwsLabService>;
let defaultService: Promise<LabService> | undefined;
function service() {
  return defaultService ??= import("@/lib/prisma").then(({ prisma }) => createAwsLabService({
    db: prisma, cleanupRequest: runnerCleanupRequest, cleanupSettings: resolveRunnerCleanupSettings,
  }));
}
export async function readLab(...args: Parameters<LabService["readLab"]>) { return (await service()).readLab(...args); }
export async function refreshLab(...args: Parameters<LabService["refreshLab"]>) { return (await service()).refreshLab(...args); }
export async function startLab(...args: Parameters<LabService["startLab"]>) { return (await service()).startLab(...args); }
export async function runLabCommand(...args: Parameters<LabService["runLabCommand"]>) { return (await service()).runLabCommand(...args); }
export async function closeCandidateLabs(...args: Parameters<LabService["closeCandidateLabs"]>) { return (await service()).closeCandidateLabs(...args); }
export async function reconcileCandidateLabs(...args: Parameters<LabService["reconcileCandidateLabs"]>) { return (await service()).reconcileCandidateLabs(...args); }
