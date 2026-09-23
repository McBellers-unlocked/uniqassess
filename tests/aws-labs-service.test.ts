import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAwsLabService, type LabServiceDependencies } from "../src/lib/recruit/aws-lab-service";
import { LabError } from "../src/lib/recruit/kubernetes-lab-runner";
import { AWS_LAB_TEMPLATE } from "../src/lib/recruit/aws-lab-config";

type Row = Record<string, any>;
type Call = { path: string; method: string; body?: any; locked: boolean };

/** Deliberately small persistence/broker doubles; tests exercise the real service. */
function fixture(settings: LabServiceDependencies["settings"] = () => ({ url: "https://runner.invalid", key: "test-key" }), cleanupSettings?: LabServiceDependencies["cleanupSettings"]) {
  const candidates = new Map<string, Row>();
  const sessions = new Map<string, Row>();
  const commands = new Map<string, Row>();
  const remoteSessions = new Map<string, Row>();
  const remoteCommands = new Map<string, Row>();
  const calls: Call[] = [];
  let transactionCount = 0;
  let locked = false;
  let transactionTail: Promise<unknown> = Promise.resolve();
  let beforeTransaction: ((count: number) => void) | undefined;
  let interceptRequest: ((call: Call) => Promise<unknown | undefined>) | undefined;
  const clone = <T>(value: T): T => structuredClone(value);
  const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object") {
      if ("in" in value) return value.in.includes(row[key]);
      if ("notIn" in value) return !value.notIn.includes(row[key]);
    }
    return row[key] === value;
  });
  const table = (rows: Map<string, Row>) => ({
    findMany: async ({ where, take }: Row = {}) => clone(Array.from(rows.values()).filter((row) => matches(row, where)).slice(0, take)),
    count: async ({ where }: Row) => Array.from(rows.values()).filter((row) => matches(row, where)).length,
    updateMany: async ({ where, data }: Row) => {
      let count = 0;
      for (const row of Array.from(rows.values())) if (matches(row, where)) { Object.assign(row, clone(data)); count++; }
      return { count };
    },
    update: async ({ where, data }: Row) => {
      const row = rows.get(where.id);
      assert.ok(row, "update targets an existing record");
      Object.assign(row, clone(data));
      return clone(row);
    },
  });
  const sessionTable = {
    ...table(sessions),
    findUnique: async ({ where, include }: Row) => {
      const key = where.candidateId_taskNumber;
      const row = key ? Array.from(sessions.values()).find((s) => s.candidateId === key.candidateId && s.taskNumber === key.taskNumber) : sessions.get(where.id);
      return row ? clone({ ...row, ...(include?.commands ? { commands: Array.from(commands.values()).filter((c) => c.sessionId === row.id) } : {}) }) : null;
    },
    create: async ({ data }: Row) => {
      const row = { id: `clab${String(sessions.size + 1).padStart(21, "0")}`, status: "starting", error: null, snapshot: null, cleanupCompletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...clone(data) };
      sessions.set(row.id, row);
      return clone(row);
    },
  };
  const commandTable = {
    ...table(commands),
    findUnique: async ({ where }: Row) => {
      const key = where.sessionId_requestId;
      const row = key ? Array.from(commands.values()).find((c) => c.sessionId === key.sessionId && c.requestId === key.requestId) : commands.get(where.id);
      return row ? clone(row) : null;
    },
    create: async ({ data }: Row) => {
      const row = { id: randomUUID(), status: "queued", stdout: "", stderr: "", exitCode: null, truncated: false, createdAt: new Date(), startedAt: null, finishedAt: null, ...clone(data) };
      commands.set(row.id, row);
      return clone(row);
    },
  };
  const db = {
    recruitmentCandidate: { findUnique: async ({ where }: Row) => clone(candidates.get(where.id) ?? null) },
    recruitmentAwsLabSession: sessionTable,
    recruitmentAwsLabCommand: commandTable,
    recruitmentActivityEvent: { create: async ({ data }: Row) => data },
    $queryRaw: async () => [],
    $transaction: async <T>(action: (tx: unknown) => Promise<T>) => {
      const run = transactionTail.then(async () => {
        beforeTransaction?.(++transactionCount);
        locked = true;
        try { return await action(db); } finally { locked = false; }
      });
      transactionTail = run.catch(() => {});
      return run;
    },
  };
  const request: NonNullable<LabServiceDependencies["request"]> = async (path, method = "GET", body) => {
    const call = { path, method, body, locked };
    calls.push(call);
    if (interceptRequest) {
      const intercepted = await interceptRequest(call);
      if (intercepted !== undefined) return intercepted;
    }
    const [id, segment, commandId] = path.split("/");
    if (segment === "commands") {
      if (method === "GET") {
        const command = remoteCommands.get(commandId);
        if (!command) throw new LabError("Not found", 404);
        return clone(command);
      }
      const commandBody = body as Row;
      if (!remoteCommands.has(commandBody.id)) remoteCommands.set(commandBody.id, {
        id: commandBody.id, status: "completed", stdout: "healthy", stderr: "", exitCode: 0,
        truncated: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      return clone(remoteCommands.get(commandBody.id));
    }
    if (method === "PUT") {
      if (!remoteSessions.has(id)) remoteSessions.set(id, { id, status: "ready", ...(body as Row) });
    }
    if (method === "DELETE") {
      const previous = remoteSessions.get(id);
      remoteSessions.set(id, { ...previous, id, status: "stopped", expiresAt: previous?.expiresAt ?? new Date().toISOString(), cleanupComplete: true });
    }
    const session = remoteSessions.get(id);
    if (!session) throw new LabError("Not found", 404);
    return clone(session);
  };
  const service = createAwsLabService({ db: db as unknown as LabServiceDependencies["db"], request, settings, cleanupSettings });
  function candidate(id = "candidate-a") {
    const row = { id, status: "started", workLockedAt: null, deadline: new Date(Date.now() + 60_000) };
    candidates.set(id, row);
    return row as Row;
  }
  async function ready(id = "candidate-a", task = 1) {
    if (!candidates.has(id)) candidate(id);
    await service.startLab(id, task, AWS_LAB_TEMPLATE.id);
    return Array.from(sessions.values()).find((s) => s.candidateId === id && s.taskNumber === task)!;
  }
  return { service, candidates, sessions, commands, remoteSessions, remoteCommands, calls, candidate, ready,
    beforeTransaction: (hook: typeof beforeTransaction) => { beforeTransaction = hook; },
    interceptRequest: (hook: typeof interceptRequest) => { interceptRequest = hook; },
    transactionCount: () => transactionCount,
  };
}

test("lab service rejects locked, unstarted and expired work before contacting the runner", async () => {
  for (const change of [{ status: "invited" }, { status: "submitted" }, { workLockedAt: new Date() }, { deadline: new Date(0) }]) {
    const f = fixture();
    Object.assign(f.candidate(), change);
    await assert.rejects(f.service.startLab("candidate-a", 1, AWS_LAB_TEMPLATE.id), (e: unknown) => e instanceof LabError && e.status === 403);
    await assert.rejects(f.service.runLabCommand("candidate-a", 1, "kubectl get pods", randomUUID()), (e: unknown) => e instanceof LabError && e.status === 403);
    assert.equal(f.calls.length, 0);
  }
});

test("async settings gates are awaited before starting work", async () => {
  const f = fixture(async () => null);
  f.candidate();
  await assert.rejects(f.service.startLab("candidate-a", 1, AWS_LAB_TEMPLATE.id), LabError);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessions.size, 0);
  assert.equal((await f.service.readLab("candidate-a", 1)).available, false);
});

test("saved command evidence remains readable when runtime secret lookup fails", async () => {
  let fail = false;
  const f = fixture(async () => {
    if (fail) throw new LabError("Secret service unavailable");
    return { url: "https://runner.invalid", key: "test-key" };
  });
  const lab = await f.ready();
  await f.service.runLabCommand("candidate-a", 1, "kubectl get pods", randomUUID());
  fail = true;
  const state = await f.service.readLab("candidate-a", 1);
  assert.equal(state.available, false);
  assert.equal(state.session?.id, lab.id);
  assert.equal(state.commands[0].stdout, "healthy");
});

test("trusted reconciliation closes and preserves evidence with candidate enablement off", async () => {
  let enabled = true;
  const config = { url: "https://runner.invalid", key: "test-key" };
  const f = fixture(async () => enabled ? config : null, async () => config);
  const lab = await f.ready();
  enabled = false;
  f.candidates.get("candidate-a")!.workLockedAt = new Date();
  const previousCalls = f.calls.length;
  await f.service.reconcileCandidateLabs("candidate-a");
  assert.equal(f.sessions.get(lab.id)?.status, "stopped");
  assert.ok(f.calls.slice(previousCalls).some((call) => call.method === "DELETE"));
  assert.ok(f.calls.slice(previousCalls).every((call) => ["GET", "DELETE"].includes(call.method)));
  await assert.rejects(f.service.startLab("candidate-a", 1, AWS_LAB_TEMPLATE.id), LabError);
});

test("candidate and task scoping prevents reading or operating another lab", async () => {
  const f = fixture();
  const a = await f.ready();
  await f.service.runLabCommand("candidate-a", 1, "kubectl get pods", randomUUID());
  f.candidate("candidate-b");
  assert.equal((await f.service.readLab("candidate-b", 1)).session, null);
  assert.deepEqual((await f.service.readLab("candidate-a", 2)).commands, []);
  const before = f.calls.length;
  await assert.rejects(f.service.runLabCommand("candidate-b", 1, "kubectl get pods", randomUUID()), (e: unknown) => e instanceof LabError && e.status === 409);
  await f.service.reconcileCandidateLabs("candidate-b");
  assert.equal(f.calls.length, before);
  const b = await f.ready("candidate-b");
  assert.notEqual(a.id, b.id);
  assert.equal((await f.service.readLab("candidate-b", 1)).commands.length, 0);
});

test("concurrent retries reuse one command and runner dispatch holds the candidate lock", async () => {
  const f = fixture();
  await f.ready();
  const requestId = randomUUID();
  await Promise.all([
    f.service.runLabCommand("candidate-a", 1, "kubectl get pods", requestId),
    f.service.runLabCommand("candidate-a", 1, "kubectl get pods", requestId),
  ]);
  assert.equal(f.commands.size, 1);
  assert.equal(f.remoteCommands.size, 1);
  const posts = f.calls.filter((c) => c.method === "POST");
  assert.ok(posts.length >= 1);
  assert.ok(posts.every((c) => c.locked));
  assert.equal(new Set(posts.map((c) => c.body.id)).size, 1);
  await assert.rejects(f.service.runLabCommand("candidate-a", 1, "kubectl delete pod app", requestId), (e: unknown) => e instanceof LabError && e.status === 409);
});

test("submission between enqueue and dispatch prevents command execution", async () => {
  const f = fixture();
  await f.ready();
  const dispatchTransaction = f.transactionCount() + 2;
  f.beforeTransaction((count) => {
    if (count === dispatchTransaction) Object.assign(f.candidates.get("candidate-a")!, { status: "submitted", workLockedAt: new Date() });
  });
  await assert.rejects(f.service.runLabCommand("candidate-a", 1, "kubectl get pods", randomUUID()), (e: unknown) => e instanceof LabError && e.status === 403);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(Array.from(f.commands.values())[0].status, "failed");
});

test("a stale start request cannot provision after submission wins the lock", async () => {
  const f = fixture();
  f.candidate();
  f.beforeTransaction((count) => {
    if (count === 2) Object.assign(f.candidates.get("candidate-a")!, { status: "submitted", workLockedAt: new Date() });
  });
  await f.service.startLab("candidate-a", 1, AWS_LAB_TEMPLATE.id);
  assert.equal(f.calls.filter((c) => c.method === "PUT").length, 0);
  assert.ok(f.calls.some((c) => c.method === "DELETE"));
});

test("ambiguous command dispatch is reconciled without executing it again", async () => {
  const f = fixture();
  await f.ready();
  f.interceptRequest(async (call) => {
    if (call.method === "POST") {
      f.remoteCommands.set(call.body.id, { id: call.body.id, status: "completed", stdout: "recovered", stderr: "", exitCode: 0, truncated: false });
      throw new LabError("Connection lost");
    }
    return undefined;
  });
  await assert.rejects(f.service.runLabCommand("candidate-a", 1, "kubectl get pods", randomUUID()));
  f.interceptRequest(undefined);
  await f.service.refreshLab("candidate-a", 1, true);
  const result = (await f.service.readLab("candidate-a", 1)).commands[0];
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, "recovered");
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
});

test("cleanup retries terminal local records and saves asynchronous final evidence", async () => {
  const f = fixture();
  const session = await f.ready();
  f.candidates.get("candidate-a")!.status = "submitted";
  f.interceptRequest(async (call) => { if (call.method === "DELETE") throw new LabError("Unavailable"); return undefined; });
  await f.service.closeCandidateLabs("candidate-a");
  assert.equal(f.sessions.get(session.id)!.status, "stopped");
  assert.ok(f.sessions.get(session.id)!.error);
  assert.equal(f.remoteSessions.get(session.id)!.status, "ready");
  f.interceptRequest(undefined);
  await f.service.refreshLab("candidate-a", 1, false);
  assert.equal(f.remoteSessions.get(session.id)!.status, "stopped");
  const snapshot = { capturedAt: new Date().toISOString(), content: '{"readyReplicas":2}', truncated: false };
  f.remoteSessions.get(session.id)!.snapshot = snapshot;
  await f.service.reconcileCandidateLabs("candidate-a");
  assert.deepEqual(f.sessions.get(session.id)!.snapshot, snapshot);
  assert.ok(f.sessions.get(session.id)!.cleanupCompletedAt);
  assert.equal(f.sessions.get(session.id)!.error, null);
});

test("marker reconciliation never dispatches or cancels an active candidate's queued work", async () => {
  const f = fixture();
  await f.ready();
  f.interceptRequest(async (call) => { if (call.method === "POST") throw new LabError("Not accepted yet"); return undefined; });
  await assert.rejects(f.service.runLabCommand("candidate-a", 1, "kubectl get pods", randomUUID()));
  f.interceptRequest(undefined);
  const before = f.calls.length;
  await f.service.reconcileCandidateLabs("candidate-a");
  assert.equal(Array.from(f.commands.values())[0].status, "queued");
  assert.ok(f.calls.slice(before).every((call) => call.method === "GET"));
  assert.equal(f.remoteCommands.size, 0);
});

test("submission acknowledges cleanup promptly and marking later retains final command output", async () => {
  const f = fixture();
  await f.ready();
  f.interceptRequest(async (call) => {
    if (call.method !== "POST") return undefined;
    const result = { id: call.body.id, status: "running", stdout: "", stderr: "", exitCode: null, truncated: false };
    f.remoteCommands.set(result.id, result);
    return result;
  });
  await f.service.runLabCommand("candidate-a", 1, "kubectl rollout status deployment/app", randomUUID());
  f.interceptRequest(undefined);
  f.candidates.get("candidate-a")!.status = "submitted";
  const beforeClose = f.calls.length;
  await f.service.closeCandidateLabs("candidate-a");
  assert.deepEqual(f.calls.slice(beforeClose).map((call) => call.method), ["DELETE"]);
  const command = Array.from(f.commands.values())[0];
  assert.equal(command.status, "running");
  f.remoteCommands.set(command.id, { id: command.id, status: "failed", stdout: "Waiting for deployment rollout", stderr: "The lab ended before this command completed.", exitCode: null, truncated: false, finishedAt: new Date().toISOString() });
  await f.service.reconcileCandidateLabs("candidate-a");
  assert.equal(f.commands.get(command.id)!.status, "failed");
  assert.equal(f.commands.get(command.id)!.stdout, "Waiting for deployment rollout");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});
