/** Strictly read-only metadata for the TWO named synthetic DevOps pilots.
 * No command/source/output text, snapshot content, answers, names, tokens or
 * cookies are selected. No candidate API or reconciliation call is made.
 */
import { execFileSync } from 'node:child_process';

const ACCOUNT = '891612540396';
const REGION = 'eu-west-1';
const ROLE = 'uniqassess_lab_reconciler';
const SECRET = 'uniqassess/labs/pilot/reconciliation-database';
const COHORTS = ['devops-two-lab-live-pilot-v1', 'devops-two-lab-expiry-pilot-v1'];
class InspectionFailure extends Error {}
function requireValue(value, message) { if (!value) throw new InspectionFailure(message); }
function aws(args) {
  try {
    return JSON.parse(execFileSync('aws', [...args, '--region', REGION, '--output', 'json', '--no-cli-pager'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000, maxBuffer: 4 * 1024 * 1024,
    }));
  } catch { throw new InspectionFailure('AWS inspection lookup failed; no configuration values were logged.'); }
}

// These fixed pairs intentionally cannot be supplied from CLI or environment.
const FILTER = `((c.assessment_id = $1 AND c.email = 'alpha@devops-pilot.example' AND c.name = 'Synthetic DevOps Pilot Alpha')
  OR (c.assessment_id = $2 AND c.email = 'beta@devops-pilot.example' AND c.name = 'Synthetic DevOps Pilot Beta'))`;

function observations(provider) {
  // Identifiers are drawn only from this private, fixed enumeration.
  const tables = provider === 'aws' ? ['recruitment_aws_lab_sessions', 'recruitment_aws_lab_commands']
    : ['recruitment_lab_sessions', 'recruitment_lab_commands'];
  return `SELECT
    CASE WHEN c.assessment_id = $1 THEN 'alpha' ELSE 'expiry' END AS pilot,
    '${provider}' AS provider, c.id AS candidate_id, c.assessment_id, c.anonymous_id,
    c.status AS candidate_status, c.started_at, c.deadline, c.submitted_at, c.work_locked_at,
    l.id AS lab_id, l.task_number, l.template_id, l.status AS lab_status,
    l.created_at AS lab_created_at, l.updated_at AS lab_updated_at, l.expires_at AS lab_expires_at, l.cleanup_completed_at,
    NULLIF(l.error, '') IS NOT NULL AS lab_has_error,
    l.snapshot IS NOT NULL AND l.snapshot <> 'null'::jsonb AS snapshot_present,
    l.snapshot->>'capturedAt' AS snapshot_captured_at,
    char_length(COALESCE(l.snapshot->>'content', '')) AS snapshot_characters,
    COALESCE(l.snapshot->>'truncated', 'false') = 'true' AS snapshot_truncated,
    NULLIF(l.snapshot->>'error', '') IS NOT NULL AS snapshot_has_error,
    evidence.*
  FROM recruitment_candidates c
  LEFT JOIN ${tables[0]} l ON l.candidate_id = c.id
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
      min(created_at) AS first_created_at, min(started_at) AS first_started_at, max(finished_at) AS last_finished_at
    FROM ${tables[1]} WHERE session_id = l.id
  ) evidence ON true
  WHERE ${FILTER}
  ORDER BY c.assessment_id, l.task_number`;
}

const iso = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const ms = (later, earlier) => later && earlier ? Math.max(0, new Date(later).getTime() - new Date(earlier).getTime()) : null;
async function main() {
  requireValue(process.argv.length === 2, 'This read-only inspection takes no arguments.');
  requireValue(aws(['sts', 'get-caller-identity']).Account === ACCOUNT, 'Unexpected management account.');
  const database = aws(['rds', 'describe-db-instances', '--db-instance-identifier', 'meritia-db']).DBInstances?.[0];
  requireValue(database?.DBInstanceStatus === 'available' && database.Endpoint?.Address, 'The expected database is unavailable.');
  const secret = aws(['secretsmanager', 'get-secret-value', '--secret-id', SECRET]);
  requireValue(secret.Name === SECRET && /^arn:aws:secretsmanager:eu-west-1:891612540396:secret:uniqassess\/labs\/pilot\/reconciliation-database-[A-Za-z0-9]{6}$/.test(secret.ARN ?? ''), 'Unexpected database secret identity.');
  let url;
  try { url = new URL(JSON.parse(secret.SecretString).DATABASE_URL); }
  catch { throw new InspectionFailure('The restricted database configuration is unreadable.'); }
  requireValue(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === database.Endpoint.Address
    && url.pathname === '/meritia' && decodeURIComponent(url.username) === ROLE, 'Unexpected database target or role.');
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('connect_timeout', '5');
  url.searchParams.set('pool_timeout', '5');
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  try {
    const rows = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
      const identity = await tx.$queryRawUnsafe("SELECT current_user AS role, current_setting('transaction_read_only') AS read_only");
      requireValue(identity[0]?.role === ROLE && identity[0]?.read_only === 'on', 'Database role/read-only verification failed.');
      // Only counts are selected until the exact fictional identity set passes.
      const scope = await tx.$queryRawUnsafe(`SELECT c.assessment_id, count(*)::int AS total,
        count(*) FILTER (WHERE ${FILTER} AND c.anonymous_id = 'Candidate A')::int AS expected
        FROM recruitment_candidates c WHERE c.assessment_id IN ($1, $2) GROUP BY c.assessment_id`, ...COHORTS);
      requireValue(scope.length <= 2 && scope.every((row) => row.total === 1 && row.expected === 1), 'Synthetic pilot identity/count mismatch; no record details were selected.');
      const k8 = await tx.$queryRawUnsafe(observations('kubernetes'), ...COHORTS);
      const awsRows = await tx.$queryRawUnsafe(observations('aws'), ...COHORTS);
      return [...k8, ...awsRows];
    }, { timeout: 20000, maxWait: 5000 });
    requireValue(rows.length <= 4 && rows.every((row) => !row.lab_id || (row.provider === 'aws'
      ? row.task_number === 2 && row.template_id === 'aws-service-release-v1'
      : row.task_number === 1 && row.template_id === 'kubernetes-troubleshooting-v1')), 'Unexpected synthetic task/session count; no record details were printed.');
    const observedAt = new Date();
    const records = rows.map((row) => ({
      pilot: row.pilot, provider: row.provider, candidateId: row.candidate_id, cohortId: row.assessment_id,
      candidateStatus: row.candidate_status, startedAt: iso(row.started_at), deadline: iso(row.deadline),
      submittedAt: iso(row.submitted_at), workLockedAt: iso(row.work_locked_at),
      pastDeadline: Boolean(row.deadline && new Date(row.deadline) <= observedAt),
      lab: row.lab_id ? {
        id: row.lab_id, taskNumber: row.task_number, templateId: row.template_id, status: row.lab_status,
        createdAt: iso(row.lab_created_at), updatedAt: iso(row.lab_updated_at), expiresAt: iso(row.lab_expires_at),
        cleanupCompletedAt: iso(row.cleanup_completed_at), hasError: row.lab_has_error,
        snapshot: { present: row.snapshot_present, capturedAt: iso(row.snapshot_captured_at), characters: row.snapshot_characters,
          truncated: row.snapshot_truncated, hasError: row.snapshot_has_error },
        commands: { total: row.total, queued: row.queued, running: row.running, completed: row.completed, failed: row.failed,
          truncated: row.truncated, nonzeroExits: row.nonzero_exits, missingExitCodes: row.missing_exit_codes,
          stdoutCharacters: Number(row.stdout_characters), stderrCharacters: Number(row.stderr_characters),
          maxStdoutCharacters: row.max_stdout_characters, maxStderrCharacters: row.max_stderr_characters,
          firstCreatedAt: iso(row.first_created_at), firstStartedAt: iso(row.first_started_at), lastFinishedAt: iso(row.last_finished_at) },
        cleanupAfterDeadlineMs: ms(row.cleanup_completed_at, row.deadline),
        cleanupAfterWorkLockMs: ms(row.cleanup_completed_at, row.work_locked_at),
      } : null,
    }));
    console.log(JSON.stringify({ suite: 'devops_two_synthetic_pilots_database_observation', observedAt: observedAt.toISOString(),
      readOnly: true, source: 'restricted_database_role', candidatesFound: new Set(rows.map((row) => row.candidate_id)).size, records,
      limitations: ['This read does not expire, submit or reconcile an attempt.', 'Database cleanup is a runner receipt; actual resource absence requires independent cloud checks.', 'These technical pilot timings are not human calibration or performance percentiles.'],
    }, null, 2));
  } finally { await client.$disconnect(); }
}
main().catch((error) => {
  console.log(JSON.stringify({ suite: 'devops_two_synthetic_pilots_database_observation', readOnly: true, failed: true,
    error: error instanceof InspectionFailure ? error.message : 'Read-only inspection failed; no database or secret details were logged.' }));
  process.exitCode = 1;
});
