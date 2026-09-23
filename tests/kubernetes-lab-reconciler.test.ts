import test from "node:test";
import assert from "node:assert/strict";
import { handler, parseReconciliationSecrets } from "../infra/kubernetes-labs/reconciliation/handler";

const database = JSON.stringify({ DATABASE_URL: "postgresql://worker:private@database.example/assessment" });
const runner = JSON.stringify({ enabled: false, url: "https://runner.example/", key: "x".repeat(40) });

test("reconciler accepts disabled candidate configuration while retaining a valid cleanup destination", () => {
  const settings = parseReconciliationSecrets({ database, runner });
  assert.equal(settings.runnerUrl, "https://runner.example");
  assert.equal(settings.databaseUrl, JSON.parse(database).DATABASE_URL);
  for (const invalid of ["null", "[]", "{}", JSON.stringify({ enabled: false }), JSON.stringify({ enabled: false, url: "http://runner.example", key: "x".repeat(40) })]) {
    assert.throws(() => parseReconciliationSecrets({ database, runner: invalid }));
  }
  assert.throws(() => parseReconciliationSecrets({ database: JSON.stringify({ DATABASE_URL: "https://database.example" }), runner }));
});

test("Lambda configuration failure exposes only its sanitized operator error", async () => {
  const previous = process.env.LAB_RECONCILE_DATABASE_SECRET_ARN;
  delete process.env.LAB_RECONCILE_DATABASE_SECRET_ARN;
  try {
    await assert.rejects(handler(), (error: unknown) => error instanceof Error && error.message === "Lab reconciliation failed. Check worker permissions, configuration and connectivity.");
  } finally {
    if (previous === undefined) delete process.env.LAB_RECONCILE_DATABASE_SECRET_ARN;
    else process.env.LAB_RECONCILE_DATABASE_SECRET_ARN = previous;
  }
});
