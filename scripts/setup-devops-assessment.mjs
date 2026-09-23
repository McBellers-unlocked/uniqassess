/** Guarded deployment actions. Hosting/database credentials remain in memory. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const account = '891612540396';
const region = 'eu-west-1';
const migration = '20260923160000_candidate_aws_labs';
function aws(args) {
  try { return JSON.parse(execFileSync('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000,
  })); } catch { throw new Error('AWS deployment lookup failed; no configuration values were logged.'); }
}
const operation = process.argv[2] ?? 'check';
if (process.argv.length > 3 || !['check', 'migrate', 'draft', 'pilot', 'expiry-pilot'].includes(operation)) throw new Error('Use check, migrate, draft, pilot or expiry-pilot.');
const pilot = ['pilot', 'expiry-pilot'].includes(operation);
let acceptancePath;
if (pilot) {
  if (!process.env.DEVOPS_PILOT_ACCEPTANCE_PATH) throw new Error('DEVOPS_PILOT_ACCEPTANCE_PATH is required for synthetic pilot activation.');
  const directory = realpathSync(resolve('.deployment'));
  acceptancePath = realpathSync(resolve(process.env.DEVOPS_PILOT_ACCEPTANCE_PATH));
  const inside = relative(directory, acceptancePath);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('The acceptance report must be a file inside this workspace’s .deployment directory.');
}
let db;
try {
  if (aws(['sts', 'get-caller-identity']).Account !== account) throw new Error('Unexpected management account.');
  const app = aws(['amplify', 'get-app', '--app-id', 'd1wxabrgr6nkub']).app;
  const branch = aws(['amplify', 'get-branch', '--app-id', 'd1wxabrgr6nkub', '--branch-name', 'main']).branch;
  const env = { ...process.env, ...app.environmentVariables, ...branch.environmentVariables };
  if (pilot) env.DEVOPS_PILOT_ACCEPTANCE_PATH = acceptancePath;
  const instance = aws(['rds', 'describe-db-instances', '--db-instance-identifier', 'meritia-db']).DBInstances[0];
  const target = new URL(env.DATABASE_URL);
  if (target.hostname !== instance.Endpoint.Address || target.pathname !== '/meritia' || instance.DBInstanceStatus !== 'available'
    || instance.BackupRetentionPeriod < 1 || !instance.LatestRestorableTime) throw new Error('Database identity/recovery preflight failed.');
  db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const rows = await db.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"');
  if (rows.some(row => !row.finished_at && !row.rolled_back_at)) throw new Error('An unfinished migration requires review.');
  const applied = new Set(rows.filter(row => row.finished_at && !row.rolled_back_at).map(row => row.migration_name));
  const pending = readdirSync('prisma/migrations', { withFileTypes: true }).filter(entry => entry.isDirectory() && !applied.has(entry.name)).map(entry => entry.name);
  if (pending.some(name => name !== migration)) throw new Error('An unrelated migration is pending; refusing automatic deployment.');
  if (pilot && pending.length) throw new Error('Apply and verify the AWS lab migration before synthetic pilot activation.');
  console.log(JSON.stringify({ account, database: 'meritia', recoveryVerified: true, pending, operation }));
  if (operation === 'migrate' && pending.length) {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('AWS lab migration did not complete.');
  }
  if (operation === 'migrate') {
    // Add only the new evidence tables to the existing restricted reconciliation
    // role; its password, connection restrictions and existing grants stay intact.
    await db.$executeRawUnsafe('GRANT SELECT, UPDATE ON public.recruitment_aws_lab_sessions, public.recruitment_aws_lab_commands TO uniqassess_lab_reconciler');
    await db.recruitmentAwsLabSession.findMany({ take: 1, select: { id: true, commands: { take: 1, select: { id: true, exitCode: true } } } });
    await db.recruitmentAwsLabCommand.findMany({ take: 1, select: { id: true, exitCode: true } });
    console.log(JSON.stringify({ awsEvidenceTablesVerified: true, reconciliationGrants: ['SELECT', 'UPDATE'] }));
  }
  if (operation === 'draft') {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-devops-assessment.ts'], { env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('DevOps draft setup did not complete.');
  }
  if (pilot) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/activate-devops-pilot.ts', operation === 'pilot' ? '--execute' : '--execute-expiry'], {
      env, stdio: 'inherit', windowsHide: true,
    });
    if (result.status !== 0) throw new Error('Synthetic DevOps pilot activation did not complete; existing attempts were not reset.');
  }
} catch (error) {
  console.error(error?.name?.startsWith('Prisma') ? 'Database setup failed; inspect permissions and schema.' : error.message);
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
