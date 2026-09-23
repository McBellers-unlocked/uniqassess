/**
 * Read-only database evidence for the three fixed synthetic Kubernetes pilots.
 * Run with the configured operator AWS profile. The dedicated reconciliation
 * database secret stays in memory; no candidate content, tokens or cookies are
 * selected. stdout contains only sanitized JSON status/count/timing metrics.
 *
 * Uses a restricted DB role and an explicitly read-only transaction. It does
 * not call candidate APIs, expire attempts, reconcile labs or alter any record.
 */
import { execFileSync } from "node:child_process";

const ACCOUNT = "891612540396";
const REGION = "eu-west-1";
const DB_INSTANCE = "meritia-db";
const SECRET_NAME = "uniqassess/labs/pilot/reconciliation-database";
const DATABASE_ROLE = "uniqassess_lab_reconciler";
const COHORTS = ["kubernetes-live-pilot-v1-normal", "kubernetes-live-pilot-v1-expiry"];

class InspectionFailure extends Error {}
function requireValue(condition, message) {
  if (!condition) throw new InspectionFailure(message);
}

function aws(args) {
  try {
    return JSON.parse(execFileSync("aws", [...args, "--region", REGION, "--output", "json", "--no-cli-pager"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    }));
  } catch {
    throw new InspectionFailure("AWS inspection lookup failed; configuration and secret values were not logged.");
  }
}

function iso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function elapsed(later, earlier) {
  if (!later || !earlier) return null;
  const difference = new Date(later).getTime() - new Date(earlier).getTime();
  return Number.isFinite(difference) && difference >= 0 ? difference : null;
}

function metric(value) {
  return value === null || value === undefined ? null : Number(value);
}

async function auditLabModels(tx, Prisma) {
  const models = Prisma.dmmf.datamodel.models.filter((model) => ["RecruitmentLabSession", "RecruitmentLabCommand"].includes(model.name));
  requireValue(models.length === 2, "The generated Prisma client is missing a lab model.");
  const columns = await tx.$queryRawUnsafe("SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('recruitment_lab_sessions', 'recruitment_lab_commands') ORDER BY table_name, ordinal_position");
  const mismatches = [];
  const tables = models.map((model) => {
    const table = model.dbName ?? model.name;
    const fields = model.fields.filter((field) => field.kind !== "object");
    const actual = columns.filter((column) => column.table_name === table);
    for (const field of fields) {
      const name = field.dbName ?? field.name;
      const column = actual.find((entry) => entry.column_name === name);
      const expectedType = field.nativeType?.[0] === "Uuid" ? "uuid"
        : { String: "text", Int: "integer", Boolean: "boolean", DateTime: "timestamp without time zone", Json: "jsonb" }[field.type];
      if (!column) mismatches.push(`${table}.${name}: missing column`);
      else {
        if (column.data_type !== expectedType) mismatches.push(`${table}.${name}: type mismatch`);
        if ((column.is_nullable === "NO") !== field.isRequired) mismatches.push(`${table}.${name}: nullability mismatch`);
      }
    }
    for (const column of actual) {
      if (!fields.some((field) => (field.dbName ?? field.name) === column.column_name)) mismatches.push(`${table}.${column.column_name}: unmapped column`);
    }
    return { model: model.name, table, prismaScalarFields: fields.length, databaseColumns: actual.length };
  });
  requireValue(mismatches.length === 0, "Lab model/database audit failed: " + mismatches.join("; "));

  const candidateFilter = { assessmentId: { in: COHORTS }, email: { in: ["alpha@kubernetes-pilot.example", "bravo@kubernetes-pilot.example", "expiry@kubernetes-pilot.example"] } };
  const commandSelect = { id: true, sessionId: true, requestId: true, status: true, exitCode: true, truncated: true, createdAt: true, startedAt: true, finishedAt: true };
  const sessions = await tx.recruitmentLabSession.findMany({
    where: { candidate: candidateFilter }, take: 12,
    select: { id: true, candidateId: true, taskNumber: true, templateId: true, status: true, expiresAt: true,
      cleanupCompletedAt: true, createdAt: true, updatedAt: true,
      commands: { select: commandSelect, take: 100 } },
  });
  // Prisma may skip a nested relation fetch if there are no parent rows. This
  // independent delegate query still validates mapped command columns on an
  // empty database, including the nullable exit_code column.
  const commands = await tx.recruitmentLabCommand.findMany({
    where: { session: { candidate: candidateFilter } }, select: commandSelect, take: 1,
  });
  return { passed: true, tables, mismatches, prismaSessionSelectPassed: true,
    prismaNestedCommandsSelectPassed: true, prismaDirectCommandSelectPassed: true,
    sessionRowsObserved: sessions.length, directCommandRowsObserved: commands.length };
}

// Source text, output text, candidate name/email, token, session cookie, scores,
// and snapshot content are deliberately absent from the selected columns.
const OBSERVATIONS = `
SELECT
  CASE c.email
    WHEN 'alpha@kubernetes-pilot.example' THEN 'alpha'
    WHEN 'bravo@kubernetes-pilot.example' THEN 'bravo'
    WHEN 'expiry@kubernetes-pilot.example' THEN 'expiry'
  END AS pilot,
  c.id AS candidate_id, c.assessment_id, c.anonymous_id,
  c.status AS candidate_status, c.started_at, c.deadline, c.submitted_at, c.work_locked_at,
  l.id AS lab_id, l.task_number, l.template_id, l.status AS lab_status,
  l.created_at AS lab_created_at, l.updated_at AS lab_updated_at,
  l.expires_at AS lab_expires_at, l.cleanup_completed_at,
  NULLIF(l.error, '') IS NOT NULL AS lab_has_error,
  l.snapshot IS NOT NULL AND l.snapshot <> 'null'::jsonb AS snapshot_present,
  l.snapshot->>'capturedAt' AS snapshot_captured_at,
  char_length(COALESCE(l.snapshot->>'content', '')) AS snapshot_characters,
  COALESCE(l.snapshot->>'truncated', 'false') = 'true' AS snapshot_truncated,
  NULLIF(l.snapshot->>'error', '') IS NOT NULL AS snapshot_has_error,
  evidence.total, evidence.queued, evidence.running, evidence.completed, evidence.failed,
  evidence.truncated, evidence.nonzero_exits, evidence.missing_exit_codes,
  evidence.stdout_characters, evidence.stderr_characters,
  evidence.max_stdout_characters, evidence.max_stderr_characters,
  evidence.first_created_at, evidence.first_started_at, evidence.last_finished_at,
  evidence.average_queue_ms, evidence.average_execution_ms, evidence.max_execution_ms
FROM recruitment_candidates c
LEFT JOIN recruitment_lab_sessions l ON l.candidate_id = c.id
LEFT JOIN LATERAL (
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status = 'queued')::int AS queued,
    count(*) FILTER (WHERE status = 'running')::int AS running,
    count(*) FILTER (WHERE status = 'completed')::int AS completed,
    count(*) FILTER (WHERE status = 'failed')::int AS failed,
    count(*) FILTER (WHERE truncated)::int AS truncated,
    count(*) FILTER (WHERE exit_code <> 0)::int AS nonzero_exits,
    count(*) FILTER (WHERE exit_code IS NULL)::int AS missing_exit_codes,
    COALESCE(sum(char_length(stdout)), 0)::bigint AS stdout_characters,
    COALESCE(sum(char_length(stderr)), 0)::bigint AS stderr_characters,
    COALESCE(max(char_length(stdout)), 0)::int AS max_stdout_characters,
    COALESCE(max(char_length(stderr)), 0)::int AS max_stderr_characters,
    min(created_at) AS first_created_at, min(started_at) AS first_started_at,
    max(finished_at) AS last_finished_at,
    round(avg(EXTRACT(EPOCH FROM (started_at - created_at)) * 1000))::bigint AS average_queue_ms,
    round(avg(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000))::bigint AS average_execution_ms,
    round(max(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000))::bigint AS max_execution_ms
  FROM recruitment_lab_commands WHERE session_id = l.id
) evidence ON true
WHERE c.assessment_id IN ($1, $2)
  AND c.email IN ('alpha@kubernetes-pilot.example', 'bravo@kubernetes-pilot.example', 'expiry@kubernetes-pilot.example')
ORDER BY c.assessment_id, c.anonymous_id, l.task_number
`;

async function main() {
  requireValue(process.argv.length === 2, "This read-only pilot inspection takes no arguments.");
  requireValue(aws(["sts", "get-caller-identity"]).Account === ACCOUNT, "Refusing to inspect a different AWS account.");
  const database = aws(["rds", "describe-db-instances", "--db-instance-identifier", DB_INSTANCE]).DBInstances?.[0];
  requireValue(database?.DBInstanceStatus === "available" && database?.Endpoint?.Address, "The expected deployment database is unavailable.");
  const secret = aws(["secretsmanager", "get-secret-value", "--secret-id", SECRET_NAME]);
  requireValue(secret.Name === SECRET_NAME
    && new RegExp(`^arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:uniqassess/labs/pilot/reconciliation-database-[A-Za-z0-9]{6}$`).test(secret.ARN ?? ""),
  "Refusing an unexpected database secret identity.");
  let url;
  try { url = new URL(JSON.parse(secret.SecretString).DATABASE_URL); }
  catch { throw new InspectionFailure("The restricted database configuration is unreadable."); }
  requireValue(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === database.Endpoint.Address
    && url.pathname === "/meritia" && decodeURIComponent(url.username) === DATABASE_ROLE,
  "Refusing an unexpected database target or role.");
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("pool_timeout", "5");
  const { PrismaClient, Prisma } = await import("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  try {
    const { rows, schemaAudit } = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
      const identity = await tx.$queryRawUnsafe("SELECT current_user AS role, current_setting('transaction_read_only') AS read_only");
      requireValue(identity[0]?.role === DATABASE_ROLE && identity[0]?.read_only === "on", "Database identity or read-only transaction verification failed.");
      const schemaAudit = await auditLabModels(tx, Prisma);
      const rows = await tx.$queryRawUnsafe(OBSERVATIONS, ...COHORTS);
      return { rows, schemaAudit };
    }, { timeout: 20_000, maxWait: 5_000 });
    requireValue(rows.length <= 12, "Unexpected pilot record count; no record details were printed.");
    const observedAt = new Date();
    const candidates = rows.map((row) => ({
      pilot: row.pilot,
      candidateId: row.candidate_id,
      assessmentId: row.assessment_id,
      anonymousId: row.anonymous_id,
      status: row.candidate_status,
      startedAt: iso(row.started_at),
      deadline: iso(row.deadline),
      submittedAt: iso(row.submitted_at),
      workLockedAt: iso(row.work_locked_at),
      pastDeadline: Boolean(row.deadline && new Date(row.deadline) <= observedAt),
      lab: row.lab_id ? {
        id: row.lab_id, taskNumber: row.task_number, templateId: row.template_id, status: row.lab_status,
        createdAt: iso(row.lab_created_at), updatedAt: iso(row.lab_updated_at), expiresAt: iso(row.lab_expires_at),
        cleanupCompletedAt: iso(row.cleanup_completed_at), hasError: row.lab_has_error,
        pastExpiry: Boolean(row.lab_expires_at && new Date(row.lab_expires_at) <= observedAt),
        snapshot: { present: row.snapshot_present, capturedAt: iso(row.snapshot_captured_at),
          characters: metric(row.snapshot_characters), truncated: row.snapshot_truncated, hasError: row.snapshot_has_error },
        commands: {
          total: metric(row.total), queued: metric(row.queued), running: metric(row.running),
          completed: metric(row.completed), failed: metric(row.failed), truncated: metric(row.truncated),
          nonzeroExits: metric(row.nonzero_exits), missingExitCodes: metric(row.missing_exit_codes),
          stdoutCharacters: metric(row.stdout_characters), stderrCharacters: metric(row.stderr_characters),
          maxStdoutCharacters: metric(row.max_stdout_characters), maxStderrCharacters: metric(row.max_stderr_characters),
          firstCreatedAt: iso(row.first_created_at), firstStartedAt: iso(row.first_started_at), lastFinishedAt: iso(row.last_finished_at),
          averageQueueMs: metric(row.average_queue_ms), averageExecutionMs: metric(row.average_execution_ms), maxExecutionMs: metric(row.max_execution_ms),
        },
        timing: {
          recordedLabLifetimeMs: elapsed(row.cleanup_completed_at, row.lab_created_at),
          cleanupAfterWorkLockMs: elapsed(row.cleanup_completed_at, row.work_locked_at),
          cleanupAfterExpiryMs: elapsed(row.cleanup_completed_at, row.lab_expires_at),
          firstCommandStartAfterLabCreationMs: elapsed(row.first_started_at, row.lab_created_at),
        },
      } : null,
    }));
    console.log(JSON.stringify({ suite: "synthetic_pilot_database_observation", observedAt: observedAt.toISOString(),
      readOnly: true, source: "restricted_database_role", schemaAudit, candidatesFound: new Set(rows.map((row) => row.candidate_id)).size,
      cleanupRecordedForLabs: candidates.filter((entry) => entry.lab?.cleanupCompletedAt).length,
      terminalCommandRecords: candidates.reduce((sum, entry) => sum + (entry.lab?.commands.completed ?? 0) + (entry.lab?.commands.failed ?? 0), 0),
      candidates,
      limitations: ["Read-only observation does not expire candidates or trigger reconciliation.", "Database cleanup confirmation is a runner receipt; verify actual namespace absence separately.", "Timing is one synthetic run, not a latency percentile or human-pilot calibration."],
    }, null, 2));
  } finally { await client.$disconnect(); }
}

main().catch((error) => {
  console.log(JSON.stringify({ suite: "synthetic_pilot_database_observation", readOnly: true, failed: true,
    error: error instanceof InspectionFailure ? error.message : "Read-only pilot inspection failed; database and secret details were not logged.",
  }));
  process.exitCode = 1;
});
