import test from "node:test";
import assert from "node:assert/strict";
import { createAwsRunnerTransport, LabError, runnerSettings } from "../src/lib/recruit/aws-lab-runner";
import { AWS_LAB_TEMPLATE, awsLabPublicationIssue } from "../src/lib/recruit/aws-lab-config";

const arn = "arn:aws:lambda:eu-west-1:891612540396:function:uniqassess-aws-lab-controller";
const env = { AWS_LABS_ENABLED: "true", AWS_LAB_RUNNER_FUNCTION_ARN: arn, APP_REGION: "eu-west-1" };
const session = "c123456789012345678901234";
const commandId = "c8fe1f69-69df-40de-97ed-5ef566f15541";
const healthy = { statusCode: 200, body: { ready: true, enabled: true, provider: "aws", templateId: AWS_LAB_TEMPLATE.id } };
const aws = { awsLab: { enabled: true, templateId: AWS_LAB_TEMPLATE.id } };

test("AWS runtime configuration only permits the dedicated management-account function and region", () => {
  assert.deepEqual(runnerSettings(env), { url: arn, key: "aws-iam" });
  assert.equal(runnerSettings({ ...env, AWS_LABS_ENABLED: "false" }), null);
  assert.equal(runnerSettings({ ...env, AWS_LABS_ENABLED: "TRUE" }), null);
  assert.equal(runnerSettings({ ...env, APP_REGION: "us-east-1" }), null);
  for (const value of [
    "https://runner.example", "uniqassess-aws-lab-controller", arn.replace("891612540396", "689324611808"),
    arn.replace("eu-west-1", "eu-west-2"), arn.replace("uniqassess-aws-lab-controller", "another-function"), `${arn}\n`,
  ]) assert.equal(runnerSettings({ ...env, AWS_LAB_RUNNER_FUNCTION_ARN: value }), null);
  assert.deepEqual(runnerSettings({ ...env, AWS_LABS_ENABLED: "false" }, true), { url: arn, key: "aws-iam" });
});

test("actual AWS health, provider and template are required before a task can pass publication readiness", async () => {
  const calls: unknown[] = [];
  const transport = createAwsRunnerTransport({ environment: () => env, invoke: async (name, event) => {
    assert.equal(name, arn);
    calls.push(event);
    return healthy;
  } });
  assert.equal(awsLabPublicationIssue(aws), "AWS practical lab setup is required: a dedicated sandbox account, durable job runner and verified cleanup must be available before this assessment can be published or assigned to candidates.");
  assert.equal(awsLabPublicationIssue(aws, "memo_ai", Boolean(await transport.resolveRunnerSettings())), null);
  assert.deepEqual(calls, [{ operation: "health" }]);
  for (const body of [
    { ...healthy.body, ready: false }, { ...healthy.body, enabled: false }, { ...healthy.body, ready: "true" },
    { ...healthy.body, provider: "kubernetes" }, { ...healthy.body, templateId: "other-version" }, {},
  ]) {
    const unavailable = createAwsRunnerTransport({ environment: () => env, invoke: async () => ({ statusCode: 200, body }) });
    assert.equal(await unavailable.resolveRunnerSettings(), null);
  }
});

test("disabled candidate access never invokes Lambda while cleanup still retrieves evidence and deletes", async () => {
  const events: unknown[] = [];
  const transport = createAwsRunnerTransport({
    environment: () => ({ ...env, AWS_LABS_ENABLED: "false" }),
    invoke: async (_, event) => { events.push(event); return { statusCode: 200, body: { id: session } }; },
  });
  assert.equal(await transport.resolveRunnerSettings(), null);
  await assert.rejects(transport.runnerRequest(session, "PUT", { templateId: AWS_LAB_TEMPLATE.id }), LabError);
  assert.equal(events.length, 0);
  await transport.runnerCleanupRequest(session);
  await transport.runnerCleanupRequest(`${session}/commands/${commandId}`);
  await transport.runnerCleanupRequest(session, "DELETE");
  assert.deepEqual(events, [
    { path: session, method: "GET" }, { path: `${session}/commands/${commandId}`, method: "GET" }, { path: session, method: "DELETE" },
  ]);
  for (const method of ["PUT", "POST", "PATCH"]) await assert.rejects(transport.runnerCleanupRequest(session, method), LabError);
  await assert.rejects(transport.runnerCleanupRequest(session, "GET", { anything: true }), LabError);
  assert.equal(events.length, 3);
});

test("AWS transport queues a job using the original persisted ID without browser credentials or automatic retry", async () => {
  const events: unknown[] = [];
  const transport = createAwsRunnerTransport({ environment: () => env, invoke: async (_, event) => {
    events.push(event);
    return { statusCode: 202, body: { id: commandId, status: "queued" } };
  } });
  const body = { id: commandId, command: "terraform plan -input=false" };
  assert.deepEqual(await transport.runnerRequest(`${session}/commands`, "POST", body), { id: commandId, status: "queued" });
  assert.deepEqual(events, [{ path: `${session}/commands`, method: "POST", body }]);
});

test("arbitrary paths, control-plane operations and oversized requests fail before invocation", async () => {
  const transport = createAwsRunnerTransport({ environment: () => env, invoke: async () => assert.fail("must not invoke Lambda") });
  for (const path of ["../../health", "https://runner.example", "health", `${session}/../other`, `${session}/commands/not-a-uuid`]) {
    await assert.rejects(transport.runnerRequest(path), (error: unknown) => error instanceof LabError && error.status === 400);
  }
  await assert.rejects(transport.runnerRequest(session, "POST", {}), LabError);
  await assert.rejects(transport.runnerRequest(session, "GET", {}), LabError);
  await assert.rejects(transport.runnerRequest(`${session}/commands`, "POST", { command: "x".repeat(40_000) }), (error: unknown) => error instanceof LabError && error.status === 413);
});

test("upstream invocation failures and response errors never leak credentials, account data or provider diagnostics", async () => {
  const privateDiagnostic = "AccessDenied private-role-arn private-token";
  const failing = createAwsRunnerTransport({ environment: () => env, invoke: async () => { throw new Error(privateDiagnostic); } });
  await assert.rejects(failing.runnerRequest(session), (error: unknown) => error instanceof LabError && error.status === 503 && !error.message.includes("private"));
  for (const [status, expected] of [[404, 404], [409, 409], [429, 429], [400, 503], [403, 503], [500, 503]]) {
    const transport = createAwsRunnerTransport({ environment: () => env, invoke: async () => ({ statusCode: status, body: { error: privateDiagnostic } }) });
    await assert.rejects(transport.runnerRequest(session), (error: unknown) => error instanceof LabError && error.status === expected && !error.message.includes("private"));
  }
});

test("invalid or excessive Lambda responses cannot be interpreted as readiness or session evidence", async () => {
  for (const value of [null, [], "json", { statusCode: "200", body: {} }, { statusCode: 200, body: "{}" }, { statusCode: 200, body: [] }, { statusCode: 200, body: { output: "x".repeat(512_001) } }]) {
    const transport = createAwsRunnerTransport({ environment: () => env, invoke: async () => value });
    await assert.rejects(transport.resolveRunnerSettings(), LabError);
    await assert.rejects(transport.runnerRequest(session), LabError);
  }
});
