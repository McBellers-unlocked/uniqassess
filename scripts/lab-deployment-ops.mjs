/** Operator actions for the known UNIQassess deployment. Secrets stay in process memory. */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const account = "891612540396";
const appId = "d1wxabrgr6nkub";
const region = "eu-west-1";
const migration = "20260923120000_candidate_kubernetes_labs";
function aws(args) {
  try { return JSON.parse(execFileSync("aws", [...args, "--region", region, "--output", "json", "--no-cli-pager"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch { throw new Error("AWS metadata/configuration lookup failed. Check the deployment profile and permissions."); }
}

async function main() {
  const operation = process.argv[2] ?? "status";
  if (!["status", "migrate", "pilot"].includes(operation)) throw new Error("Use status, migrate or pilot.");
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
