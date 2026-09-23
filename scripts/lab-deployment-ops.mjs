/** Operator actions for the known UNIQassess deployment. Secrets stay in process memory. */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DescribeSecretCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const account = "891612540396";
const appId = "d1wxabrgr6nkub";
const region = "eu-west-1";
const migration = "20260923120000_candidate_kubernetes_labs";
function aws(args) {
  try { return JSON.parse(execFileSync("aws", [...args, "--region", region, "--output", "json", "--no-cli-pager"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch { throw new Error("AWS metadata/configuration lookup failed. Check the deployment profile and permissions."); }
}

async function configureReconciliationRole(client, sourceUrl, PrismaClient) {
  const role = "uniqassess_lab_reconciler";
  const state = JSON.parse(readFileSync(path.join(root, ".deployment/cloud-state.json"), "utf8"));
  const reconciliation = JSON.parse(readFileSync(path.join(root, ".deployment/reconciliation-state.json"), "utf8"));
  const secretArn = state.databaseSecretArn;
  if (typeof secretArn !== "string" || !new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:uniqassess/labs/pilot/reconciliation-database-[A-Za-z0-9]{6}$`).test(secretArn)) {
    throw new Error("Refusing unexpected reconciliation secret target.");
  }
  if (typeof reconciliation.scheduleArn !== "string" || !reconciliation.scheduleArn.startsWith(`arn:aws:events:${region}:${account}:rule/uniqassess-lab-reconciliation-`)) {
    throw new Error("Refusing unexpected reconciliation schedule.");
  }
  const schedule = aws(["events", "describe-rule", "--name", reconciliation.scheduleArn.split("/").at(-1)]);
  if (schedule.State !== "DISABLED") throw new Error("Disable the reconciliation schedule before rotating its database login.");
  const secrets = new SecretsManagerClient({ region });
  try {
    const metadata = await secrets.send(new DescribeSecretCommand({ SecretId: secretArn }));
    if (metadata.ARN !== secretArn || metadata.Name !== "uniqassess/labs/pilot/reconciliation-database") throw new Error("Reconciliation secret identity did not match.");
    const existing = await client.$queryRawUnsafe("SELECT oid::text AS oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1", role);
    if (existing.length) {
      if (existing[0].rolsuper || existing[0].rolcreatedb || existing[0].rolcreaterole || existing[0].rolreplication || existing[0].rolbypassrls) throw new Error("Existing reconciliation role has unexpected elevated attributes; review before changing it.");
      const links = await client.$queryRawUnsafe("SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member = $1::oid OR roleid = $1::oid) AS memberships, EXISTS(SELECT 1 FROM pg_class WHERE relowner = $1::oid) OR EXISTS(SELECT 1 FROM pg_database WHERE datdba = $1::oid) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner = $1::oid) AS ownership", existing[0].oid);
      if (links[0].memberships || links[0].ownership) throw new Error("Existing reconciliation role has unexpected memberships or ownership.");
    }
    const password = randomBytes(32).toString("hex");
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid generated reconciliation password.");
    // SQL identifiers are fixed source literals; the only interpolated SQL value is validated random hex.
    // Do not log these statements or Prisma driver error objects.
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`${existing.length ? "ALTER" : "CREATE"} ROLE uniqassess_lab_reconciler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD '${password}'`);
      for (const statement of [
        "REVOKE ALL PRIVILEGES ON DATABASE meritia FROM uniqassess_lab_reconciler",
        "REVOKE ALL PRIVILEGES ON SCHEMA public FROM uniqassess_lab_reconciler",
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM uniqassess_lab_reconciler",
        "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM uniqassess_lab_reconciler",
        "GRANT CONNECT ON DATABASE meritia TO uniqassess_lab_reconciler",
        "GRANT USAGE ON SCHEMA public TO uniqassess_lab_reconciler",
        "GRANT SELECT ON public.recruitment_candidates, public.recruitment_lab_sessions, public.recruitment_lab_commands TO uniqassess_lab_reconciler",
        "GRANT UPDATE ON public.recruitment_lab_sessions, public.recruitment_lab_commands TO uniqassess_lab_reconciler",
        "ALTER ROLE uniqassess_lab_reconciler SET statement_timeout = '10s'",
        "ALTER ROLE uniqassess_lab_reconciler SET lock_timeout = '3s'",
        "ALTER ROLE uniqassess_lab_reconciler SET idle_in_transaction_session_timeout = '15s'",
      ]) await tx.$executeRawUnsafe(statement);
    }, { timeout: 20_000, maxWait: 5_000 });
    const attributes = await client.$queryRawUnsafe("SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname = $1", role);
    const flags = attributes[0];
    if (!flags?.rolcanlogin || flags.rolsuper || flags.rolcreatedb || flags.rolcreaterole || flags.rolinherit || flags.rolreplication || flags.rolbypassrls || flags.rolconnlimit !== 4) throw new Error("Reconciliation role attribute verification failed.");
    const privileges = await client.$queryRawUnsafe("SELECT c.relname, has_table_privilege($1,c.oid,'SELECT') AS can_select, has_table_privilege($1,c.oid,'UPDATE') AS can_update, has_table_privilege($1,c.oid,'INSERT') OR has_table_privilege($1,c.oid,'DELETE') OR has_table_privilege($1,c.oid,'TRUNCATE') OR has_table_privilege($1,c.oid,'REFERENCES') OR has_table_privilege($1,c.oid,'TRIGGER') AS other_access FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname", role);
    const reads = new Set(["recruitment_candidates", "recruitment_lab_sessions", "recruitment_lab_commands"]);
    const writes = new Set(["recruitment_lab_sessions", "recruitment_lab_commands"]);
    if (privileges.some((item) => item.can_select !== reads.has(item.relname) || item.can_update !== writes.has(item.relname) || item.other_access) || privileges.filter((item) => reads.has(item.relname)).length !== 3) throw new Error("Reconciliation role has unexpected effective table privileges; shared PUBLIC policy was not changed.");
    const boundary = await client.$queryRawUnsafe("SELECT has_database_privilege($1,'meritia','CONNECT') AS can_connect, has_database_privilege($1,'meritia','CREATE') AS can_create_database_objects, has_database_privilege($1,'meritia','TEMP') AS public_temporary_tables, has_schema_privilege($1,'public','USAGE') AS can_use_schema, has_schema_privilege($1,'public','CREATE') AS can_create_schema_objects", role);
    if (!boundary[0].can_connect || !boundary[0].can_use_schema || boundary[0].can_create_database_objects || boundary[0].can_create_schema_objects) throw new Error("Reconciliation database/schema boundary verification failed.");
    const restrictedUrl = new URL(sourceUrl);
    restrictedUrl.username = role;
    restrictedUrl.password = password;
    restrictedUrl.searchParams.set("connection_limit", "4");
    restrictedUrl.searchParams.set("connect_timeout", "5");
    restrictedUrl.searchParams.set("pool_timeout", "5");
    const probe = new PrismaClient({ datasources: { db: { url: restrictedUrl.toString() } } });
    try {
      const identity = await probe.$queryRawUnsafe("SELECT current_user AS role");
      if (identity[0]?.role !== role) throw new Error("Unexpected reconciliation database identity.");
      await probe.recruitmentLabSession.findMany({ take: 1, select: { id: true, candidate: { select: { id: true } }, commands: { take: 1, select: { id: true } } } });
    } finally { await probe.$disconnect(); }
    await secrets.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: JSON.stringify({ DATABASE_URL: restrictedUrl.toString() }) }));
    console.log(JSON.stringify({ role, verifiedRoleAttributes: flags, allowedReads: [...reads], allowedUpdates: [...writes], otherTablePrivileges: false, databaseBoundary: boundary[0], dedicatedSecretUpdated: true, scheduleEnabled: false }));
  } finally { secrets.destroy(); }
}

async function main() {
  const operation = process.argv[2] ?? "status";
  if (!["status", "migrate", "pilot", "reconcile-role"].includes(operation)) throw new Error("Use status, migrate, pilot or reconcile-role.");
  if (aws(["sts", "get-caller-identity"]).Account !== account) throw new Error("Refusing to use a different AWS account.");
  const app = aws(["amplify", "get-app", "--app-id", appId]).app;
  const branch = aws(["amplify", "get-branch", "--app-id", appId, "--branch-name", "main"]).branch;
  const env = { ...process.env, ...app.environmentVariables, ...branch.environmentVariables };
  const db = aws(["rds", "describe-db-instances", "--db-instance-identifier", "meritia-db"]).DBInstances[0];
  const url = new URL(env.DATABASE_URL ?? "");
  if (url.hostname !== db.Endpoint.Address || url.pathname !== "/meritia") throw new Error("Refusing unexpected database target.");
  if (db.DBInstanceStatus !== "available" || db.BackupRetentionPeriod < 1 || !db.LatestRestorableTime) throw new Error("The deployment database or recovery configuration is not ready.");
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const rows = await client.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at');
    const unfinished = rows.filter((row) => !row.finished_at && !row.rolled_back_at);
    if (unfinished.length) throw new Error("An unfinished migration requires review before continuing.");
    const done = new Set(rows.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name));
    const { readdirSync } = await import("node:fs");
    const pending = readdirSync(path.join(root, "prisma/migrations"), { withFileTypes: true }).filter((item) => item.isDirectory() && !done.has(item.name)).map((item) => item.name);
    console.log(JSON.stringify({ account, databaseHost: url.hostname, recoveryTime: db.LatestRestorableTime, applied: [...done], pending }, null, 2));
    if (operation === "migrate" && pending.some((name) => name !== migration)) throw new Error("Other migrations are pending; review those before applying the lab change.");
    if (operation === "reconcile-role") {
      if (pending.length) throw new Error("Apply the lab migration before provisioning the reconciliation login.");
      await configureReconciliationRole(client, env.DATABASE_URL, PrismaClient);
    }
    if (operation === "migrate" && pending.length) {
      const result = spawnSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], { cwd: root, env, stdio: "inherit" });
      if (result.status !== 0) throw new Error("Database migration failed.");
    }
    if (operation === "pilot") {
      if (pending.length) throw new Error("Apply the lab migration before creating the pilot.");
      const result = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/seed-kubernetes-pilot.ts")], { cwd: root, env, stdio: "inherit" });
      if (result.status !== 0) throw new Error("Pilot creation failed.");
    }
    if (operation === "migrate") {
      const tables = await client.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('recruitment_lab_sessions','recruitment_lab_commands') ORDER BY table_name");
      if (tables.length !== 2) throw new Error("Lab tables were not both found after migration.");
      console.log("Verified both lab evidence tables exist.");
    }
  } finally { await client.$disconnect(); }
}

main().catch((error) => {
  // Do not print database driver objects or child process buffers: they can contain credentials.
  console.error(error instanceof Error && !error.name.startsWith("Prisma") ? error.message : "Database preflight failed. Check deployment connectivity and migration state.");
  process.exitCode = 1;
});
