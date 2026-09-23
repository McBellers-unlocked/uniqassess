import test from "node:test";
import assert from "node:assert/strict";
import {
  KUBERNETES_LAB_TEMPLATE, LAB_OUTPUT_MAX_CHARS, labCommandIssue, labConfigIssue,
  labWorkIsActive, taskKubernetesLab,
} from "../src/lib/recruit/kubernetes-lab-config";
import {
  LabError, createRunnerSettingsResolver, parseRunnerCommand, parseRunnerSession, runnerCleanupRequest, runnerRequest, runnerSettings,
} from "../src/lib/recruit/kubernetes-lab-runner";
import { hashScenarioSnapshot } from "../src/lib/recruit/scenario-content-hash";

const config = { kubernetesLab: { enabled: true, templateId: KUBERNETES_LAB_TEMPLATE.id } };
const requestId = "c8fe1f69-69df-40de-97ed-5ef566f15541";

test("lab enablement is explicit, versioned and contains no arbitrary runtime configuration", () => {
  for (const value of [undefined, null, {}, { kubernetesLab: null }, { kubernetesLab: { enabled: false } }]) {
    assert.equal(taskKubernetesLab(value), null);
  }
  assert.equal(taskKubernetesLab(config)?.templateId, KUBERNETES_LAB_TEMPLATE.id);
  assert.ok(labConfigIssue({ kubernetesLab: { enabled: "true" } }));
  assert.ok(labConfigIssue({ kubernetesLab: { enabled: true, templateId: "unreviewed-template" } }));
  assert.ok(labConfigIssue({ kubernetesLab: { ...config.kubernetesLab, url: "https://candidate.example" } }));
  assert.ok(labConfigIssue(config, "chat"));
  assert.equal(labConfigIssue({ ...config, codeExecutionEnabled: true }), null);
  assert.notEqual(hashScenarioSnapshot({ config }), hashScenarioSnapshot({ config: {} }));
});

test("lab work requires a current unlocked started assessment, including exact deadline boundary", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  const candidate = { status: "started", workLockedAt: null, deadline: new Date(now.getTime() + 1) };
  assert.equal(labWorkIsActive(candidate, now), true);
  for (const status of ["invited", "defence", "submitted", "expired"]) {
    assert.equal(labWorkIsActive({ ...candidate, status }, now), false);
  }
  assert.equal(labWorkIsActive({ ...candidate, workLockedAt: now }, now), false);
  assert.equal(labWorkIsActive({ ...candidate, deadline: now }, now), false);
  assert.equal(labWorkIsActive({ ...candidate, deadline: null }, now), false);
  assert.equal(labWorkIsActive({ ...candidate, deadline: "invalid" }, now), false);
});

test("commands preserve multiline shell text but reject missing idempotency and unbounded input", () => {
  assert.equal(labCommandIssue("cat <<'EOF' > service.yaml\napiVersion: v1\nEOF\nkubectl apply -f service.yaml", requestId), null);
  for (const value of [null, 42, " ", "x".repeat(8001), "echo\0foo"]) assert.ok(labCommandIssue(value, requestId));
  assert.ok(labCommandIssue("kubectl get pods", "../../another-session"));
});

test("production runner configuration fails closed and keeps credentials out of URLs", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", KUBERNETES_LABS_ENABLED: "true", KUBERNETES_LAB_RUNNER_URL: "https://runner.example", KUBERNETES_LAB_RUNNER_KEY: "x".repeat(40) };
  assert.ok(runnerSettings(env));
  assert.equal(runnerSettings({ ...env, KUBERNETES_LABS_ENABLED: "false" }), null);
  for (const url of ["http://runner.example", "http://127.0.0.1", "https://key@runner.example", "https://runner.example?secret=1", "file:///tmp/runtime"]) {
    assert.equal(runnerSettings({ ...env, KUBERNETES_LAB_RUNNER_URL: url }), null);
  }
  assert.equal(runnerSettings({ ...env, KUBERNETES_LAB_RUNNER_KEY: "short" }), null);
  assert.ok(runnerSettings({ ...env, NODE_ENV: "development", KUBERNETES_LAB_RUNNER_URL: "http://127.0.0.1:8080" }));
});

test("runtime records are bound to the requested ID and bounded before persistence", () => {
  const result = { id: requestId, status: "completed", stdout: "x".repeat(LAB_OUTPUT_MAX_CHARS + 1), stderr: "", exitCode: 0, truncated: false };
  assert.equal(parseRunnerCommand(result, requestId).stdout.length, LAB_OUTPUT_MAX_CHARS);
  assert.equal(parseRunnerCommand(result, requestId).truncated, true);
  assert.throws(() => parseRunnerCommand(result, "different-id"), LabError);
  assert.throws(() => parseRunnerCommand({ ...result, exitCode: "0" }, requestId), LabError);
  assert.throws(() => parseRunnerCommand({ ...result, startedAt: "invalid" }, requestId), LabError);
  assert.throws(() => parseRunnerSession({ id: "a", status: "ready", expiresAt: "invalid" }, "a"), LabError);
  const session = parseRunnerSession({ id: "a", status: "stopped", expiresAt: "2026-09-23T10:00:00Z", secret: "never expose", snapshot: { capturedAt: "2026-09-23T09:59:00Z", content: "safe state", truncated: false }, cleanupComplete: true }, "a");
  assert.equal("secret" in session, false);
  assert.equal(session.snapshot?.content, "safe state");
  assert.equal(session.cleanupComplete, true);
});

test("server settings retrieve and rotate the secret at a maximum 60-second cache age", async () => {
  let clock = 10_000;
  let calls = 0;
  const keys = ["first-".repeat(8), "second-".repeat(8)];
  const resolve = createRunnerSettingsResolver({
    environment: () => ({ NODE_ENV: "production", APP_REGION: "eu-west-1", KUBERNETES_LABS_ENABLED: "true", KUBERNETES_LAB_CONFIG_SECRET_ARN: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:labs" }),
    now: () => clock,
    readSecret: async (arn, region) => {
      assert.equal(arn, "arn:aws:secretsmanager:eu-west-1:123456789012:secret:labs");
      assert.equal(region, "eu-west-1");
      return JSON.stringify({ enabled: true, url: "https://runner.example/", key: keys[calls++] });
    },
  });
  const results = await Promise.all([resolve(), resolve(), resolve()]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result?.key === keys[0] && result.url === "https://runner.example"));
  clock += 59_999;
  assert.equal((await resolve())?.key, keys[0]);
  clock++;
  assert.equal((await resolve())?.key, keys[1]);
  assert.equal(calls, 2);
});

test("secret outage never reuses expired credentials or exposes upstream diagnostics", async () => {
  let clock = 0;
  let fail = false;
  const resolve = createRunnerSettingsResolver({
    environment: () => ({ NODE_ENV: "production", KUBERNETES_LABS_ENABLED: "true", KUBERNETES_LAB_CONFIG_SECRET_ARN: "private-arn" }),
    now: () => clock,
    readSecret: async () => {
      if (fail) throw new Error("private-arn contains secret-value");
      return JSON.stringify({ enabled: true, url: "https://runner.example", key: "secret-value".repeat(4) });
    },
  });
  assert.ok(await resolve());
  clock = 60_000;
  fail = true;
  await assert.rejects(resolve(), (error: unknown) => error instanceof LabError && error.status === 503 && !/private-arn|secret-value/.test(error.message));
  fail = false;
  assert.ok(await resolve(), "failed refresh can be retried after service recovery");
});

test("configured secret takes precedence and malformed or disabled values fail closed", async () => {
  for (const secret of ["not-json", "null", "[]", JSON.stringify({ enabled: "true" }), JSON.stringify({ enabled: true, url: "http://runner.example", key: "x".repeat(40) })]) {
    const resolve = createRunnerSettingsResolver({
      environment: () => ({ NODE_ENV: "production", KUBERNETES_LABS_ENABLED: "true", KUBERNETES_LAB_CONFIG_SECRET_ARN: "labs", KUBERNETES_LAB_RUNNER_URL: "https://fallback.example", KUBERNETES_LAB_RUNNER_KEY: "x".repeat(40) }),
      readSecret: async () => secret,
    });
    await assert.rejects(resolve(), LabError);
  }
  const disabled = createRunnerSettingsResolver({
    environment: () => ({ NODE_ENV: "production", KUBERNETES_LABS_ENABLED: "true", KUBERNETES_LAB_CONFIG_SECRET_ARN: "labs" }),
    readSecret: async () => JSON.stringify({ enabled: false }),
  });
  assert.equal(await disabled(), null);
  const off = createRunnerSettingsResolver({
    environment: () => ({ NODE_ENV: "production", KUBERNETES_LABS_ENABLED: "false", KUBERNETES_LAB_CONFIG_SECRET_ARN: "labs" }),
    readSecret: async () => { assert.fail("disabled feature must not access AWS"); },
  });
  assert.equal(await off(), null);
});

test("self-hosted settings retain direct server environment support without AWS calls", async () => {
  const resolve = createRunnerSettingsResolver({
    environment: () => ({ NODE_ENV: "development", KUBERNETES_LABS_ENABLED: "true", KUBERNETES_LAB_RUNNER_URL: "http://127.0.0.1:8080", KUBERNETES_LAB_RUNNER_KEY: "x".repeat(40) }),
    readSecret: async () => { assert.fail("direct server configuration must not access AWS"); },
  });
  assert.equal((await resolve())?.url, "http://127.0.0.1:8080");
});

test("cleanup configuration remains available after candidate work is disabled", async () => {
  const environment = () => ({ NODE_ENV: "production" as const, KUBERNETES_LABS_ENABLED: "false", KUBERNETES_LAB_CONFIG_SECRET_ARN: "labs" });
  const readSecret = async () => JSON.stringify({ enabled: false, url: "https://runner.example", key: "x".repeat(40) });
  assert.equal(await createRunnerSettingsResolver({ environment, readSecret })(), null);
  assert.equal((await createRunnerSettingsResolver({ environment, readSecret, cleanupOnly: true })())?.url, "https://runner.example");
  await assert.rejects(runnerCleanupRequest("test", "PUT", {}), /only retrieve/);
  await assert.rejects(runnerCleanupRequest("test/commands", "POST", {}), /only retrieve/);
});

test("runner HTTP client sends commands only to configured service and redacts upstream errors", async (t) => {
  const names = ["KUBERNETES_LABS_ENABLED", "KUBERNETES_LAB_CONFIG_SECRET_ARN", "KUBERNETES_LAB_RUNNER_URL", "KUBERNETES_LAB_RUNNER_KEY"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.KUBERNETES_LABS_ENABLED = "true";
  delete process.env.KUBERNETES_LAB_CONFIG_SECRET_ARN;
  process.env.KUBERNETES_LAB_RUNNER_URL = "https://runner.example";
  process.env.KUBERNETES_LAB_RUNNER_KEY = "secret-key-that-is-never-client-visible";
  try {
    const mock = t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(url, "https://runner.example/v1/labs/test/commands");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${process.env.KUBERNETES_LAB_RUNNER_KEY}`);
      assert.deepEqual(JSON.parse(init?.body as string), { id: requestId, command: "kubectl get pods\necho '$HOME'" });
      return new Response(JSON.stringify({ id: requestId }), { status: 200 });
    });
    assert.deepEqual(await runnerRequest("test/commands", "POST", { id: requestId, command: "kubectl get pods\necho '$HOME'" }), { id: requestId });
    mock.mock.mockImplementation(async () => new Response("AWS_SECRET_ACCESS_KEY=private", { status: 500 }));
    await assert.rejects(runnerRequest("test"), (error: unknown) => error instanceof LabError && !error.message.includes("private"));
    mock.mock.mockImplementation(async () => new Response("x".repeat(512_001), { status: 200 }));
    await assert.rejects(runnerRequest("test"), /exceeded/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});
