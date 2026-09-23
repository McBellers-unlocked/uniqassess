/**
 * Opt-in live application acceptance for synthetic pilot Bravo only.
 * Required: PILOT_CANDIDATE_TOKEN=K8P-EVGK.
 * Optional: PILOT_BASE_URL (HTTPS origin; defaults to https://www.uniqassess.org).
 * Optional: PILOT_PERSIST_SESSION=1 saves/resumes the cookie only in the ignored
 * .deployment/bravo-session.json, for recovery after an interrupted operator run.
 *
 * Never starts Alpha or the expiry candidate. No browser automation is used.
 * This script submits Bravo in finally, preserving recorded work and closing its
 * lab. Main checks have 250 seconds; the total budget including cleanup is 300.
 * Only a JSON summary is printed; no cookies, tokens, response bodies or outputs.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const BRAVO_TOKEN = "K8P-EVGK";
const ALPHA_TOKEN = "K8P-KBUK";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionFile = path.join(root, ".deployment", "bravo-session.json");
const ACTIVE = new Set(["queued", "running"]);

class CheckFailure extends Error {}
function requireValue(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

class PilotChecks {
  constructor() {
    this.started = Date.now();
    this.mainDeadline = this.started + 250_000;
    this.finalDeadline = this.started + 300_000;
    this.token = process.env.PILOT_CANDIDATE_TOKEN ?? "";
    requireValue(/^K8P-[A-Z2-9]{4}$/.test(this.token) && this.token === BRAVO_TOKEN,
      "Provide only the known synthetic Bravo token through PILOT_CANDIDATE_TOKEN.");
    let base;
    try { base = new URL(process.env.PILOT_BASE_URL ?? "https://www.uniqassess.org"); }
    catch { throw new CheckFailure("PILOT_BASE_URL must be a valid HTTPS application origin."); }
    requireValue(base.protocol === "https:" && !base.username && !base.password && !base.search
      && !base.hash && base.pathname === "/", "PILOT_BASE_URL must be a credential-free HTTPS application origin.");
    this.origin = base.origin;
    this.persistSession = process.env.PILOT_PERSIST_SESSION === "1";
    this.cookie = "";
    this.startAttempted = false;
    this.results = [];
    this.commandIds = new Set();
    this.labSessionId = null;
  }

  budget(cleanup = false) {
    const remaining = (cleanup ? this.finalDeadline : this.mainDeadline) - Date.now();
    requireValue(remaining > 0, cleanup ? "Final cleanup exceeded the five-minute total budget." : "Main checks exceeded their reserved time budget.");
    return remaining;
  }

  async restoreCookie() {
    if (!this.persistSession) return;
    let saved;
    try { saved = JSON.parse(await readFile(sessionFile, "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw new CheckFailure("The saved Bravo session could not be read safely.");
    }
    requireValue(saved.origin === this.origin && saved.token === this.token
      && typeof saved.cookie === "string" && /^recruit_session=[^;\r\n]+$/.test(saved.cookie),
    "The saved session does not belong to this synthetic Bravo application target.");
    this.cookie = saved.cookie;
  }

  async saveCookie() {
    if (!this.persistSession || !this.cookie) return;
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ origin: this.origin, token: this.token, cookie: this.cookie }), { mode: 0o600 });
  }

  async request(method, route, { body, expected = 200, authenticated = true, origin = this.origin, cleanup = false, captureCookie = false } = {}) {
    const remaining = this.budget(cleanup);
    const headers = { Accept: "application/json", Origin: origin };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated && this.cookie) headers.Cookie = this.cookie;
    let response;
    try {
      response = await fetch(this.origin + route, {
        method, headers, redirect: "error", cache: "no-store",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(Math.min(25_000, remaining)),
      });
    } catch { throw new CheckFailure("Application request failed or timed out; request details were not logged."); }
    if (captureCookie) {
      const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
      const session = cookies.find((value) => value.startsWith("recruit_session="));
      if (session) {
        const cookie = session.split(";", 1)[0];
        requireValue(/^recruit_session=[^;\r\n]+$/.test(cookie), "The application returned an invalid session cookie.");
        this.cookie = cookie;
        await this.saveCookie();
      }
    }
    requireValue(response.status === expected, `Application returned HTTP ${response.status}; expected ${expected}.`);
    let value;
    try { value = await response.json(); }
    catch { throw new CheckFailure("The application returned invalid JSON."); }
    requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Application response was not an object.");
    return value;
  }

  route(token = this.token, taskNumber = 1) {
    return "/api/assess/lab?" + new URLSearchParams({ token, taskNumber: String(taskNumber) });
  }

  async state(options = {}) {
    const value = await this.request("GET", this.route(), options);
    requireValue(typeof value.available === "boolean" && Array.isArray(value.commands), "The lab state response was incomplete.");
    return value;
  }

  async poll(read, done, seconds, label) {
    const deadline = Math.min(this.mainDeadline, Date.now() + seconds * 1000);
    while (Date.now() < deadline) {
      const value = await read();
      if (done(value)) return value;
      await delay(Math.min(1000, Math.max(1, deadline - Date.now())));
    }
    throw new CheckFailure(label + " did not finish within its bounded wait.");
  }

  async check(name, action) {
    const started = Date.now();
    try {
      const details = await action();
      this.results.push({ check: name, passed: true, seconds: Number(((Date.now() - started) / 1000).toFixed(2)), ...(details ?? {}) });
    } catch (error) {
      this.results.push({ check: name, passed: false, error: error instanceof CheckFailure ? error.message : "Unexpected acceptance-check failure." });
      throw error;
    }
  }

  commandBody(command, requestId = randomUUID()) {
    return { token: this.token, taskNumber: 1, action: "command", command, requestId };
  }

  async enqueue(body) {
    const before = await this.state();
    const ids = new Set(before.commands.map((entry) => entry.id));
    const result = await this.request("POST", "/api/assess/lab", { body });
    const added = result.commands?.filter((entry) => !ids.has(entry.id)) ?? [];
    requireValue(added.length === 1 && added[0].command === body.command, "A new command was not recorded exactly once.");
    this.commandIds.add(added[0].id);
    return added[0].id;
  }

  async completed(id) {
    const state = await this.poll(() => this.state(), (value) => {
      const command = value.commands.find((entry) => entry.id === id);
      return command && !ACTIVE.has(command.status);
    }, 35, "Recorded command");
    return state.commands.find((entry) => entry.id === id);
  }

  async run(command) {
    return this.completed(await this.enqueue(this.commandBody(command)));
  }

  async startAssessment() {
    await this.restoreCookie();
    this.startAttempted = true;
    const result = await this.request("POST", "/api/assess/start", { body: { token: this.token }, captureCookie: true });
    requireValue(result.ok === true && result.submitted === false && Boolean(result.deadline), "Bravo is not an active pilot attempt; this harness never resets submitted work.");
    requireValue(Boolean(this.cookie), "No Bravo session cookie is available; the attempt cannot be safely exercised.");
  }

  async accessChecks() {
    await this.request("GET", this.route(), { authenticated: false, expected: 403 });
    await this.request("GET", this.route(ALPHA_TOKEN), { expected: 403 });
    await this.request("GET", this.route(this.token, 999), { expected: 404 });
    await this.request("POST", "/api/assess/lab", {
      body: { token: this.token, taskNumber: 999, action: "start" }, expected: 404,
    });
    await this.request("POST", "/api/assess/lab", {
      body: { token: this.token, taskNumber: 1, action: "start" }, origin: "https://synthetic-cross-origin.invalid", expected: 403,
    });
    return { missingCookieDenied: true, alphaTokenWithBravoCookieDenied: true, invalidTaskDenied: true, foreignOriginDenied: true };
  }

  async startLab() {
    // Enabling is cached by application workers for up to 60 seconds. Wait
    // before creating a lab so a stale disabled read does not consume the pilot.
    const available = await this.poll(() => this.state(), (value) => value.available === true, 65, "Runner enablement propagation");
    requireValue(available.available === true, "The deployed application has no available runner configuration.");
    const first = await this.request("POST", "/api/assess/lab", { body: { token: this.token, taskNumber: 1, action: "start" } });
    requireValue(first.available === true && Boolean(first.session?.id), "The deployed application did not provision a practical lab.");
    this.labSessionId = first.session.id;
    const ready = await this.poll(() => this.state(), (value) => value.session?.status !== "starting", 110, "Lab provisioning");
    requireValue(ready.available === true && ready.session?.id === this.labSessionId && ready.session.status === "ready", "The application lab did not become ready.");
    return { sessionId: this.labSessionId };
  }

  async outputAndPersistence() {
    const filename = "/workspace/api-pilot-" + randomUUID() + ".txt";
    const saved = await this.run(`printf 'pilot-persistent\\n' > '${filename}'; printf 'stdout-marker\\n'; printf 'stderr-marker\\n' >&2`);
    requireValue(saved.status === "completed" && saved.exitCode === 0 && saved.stdout === "stdout-marker\n"
      && saved.stderr === "stderr-marker\n", "Recorded successful command output or exit status was incorrect.");
    const loaded = await this.run(`cat '${filename}'; exit 7`);
    requireValue(loaded.status === "completed" && loaded.exitCode === 7 && loaded.stdout === "pilot-persistent\n",
      "Workspace state or the nonzero command exit status was not retained.");
    const refreshed = await this.state();
    requireValue(refreshed.commands.some((entry) => entry.id === loaded.id && entry.stdout === loaded.stdout && entry.exitCode === 7),
      "Refreshing lost recorded command evidence.");
    return { workspacePersisted: true, stdoutRecorded: true, stderrRecorded: true, nonzeroExitRecorded: true };
  }

  async retryAndConcurrency() {
    const filename = "/workspace/api-counter-" + randomUUID();
    const body = this.commandBody(`printf 'once\\n' >> '${filename}'; sleep 8; cat '${filename}'`);
    const id = await this.enqueue(body);
    const results = await Promise.allSettled([
      this.request("POST", "/api/assess/lab", { body }),
      this.request("POST", "/api/assess/lab", { body: { ...body, command: "printf 'different\\n'" }, expected: 409 }),
      this.request("POST", "/api/assess/lab", { body: this.commandBody("printf 'concurrent\\n'"), expected: 409 }),
    ]);
    // Inspect every outcome; never abandon a concurrent request on first rejection.
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const repeated = results[0].value;
    requireValue(repeated.commands.filter((entry) => entry.command === body.command).length === 1
      && repeated.commands.some((entry) => entry.id === id), "The identical request ID created duplicate command evidence.");
    const done = await this.completed(id);
    requireValue(done.status === "completed" && done.exitCode === 0 && done.stdout === "once\n", "The retried command did not execute exactly once.");
    const after = await this.request("POST", "/api/assess/lab", { body });
    requireValue(after.commands.filter((entry) => entry.command === body.command).length === 1
      && after.commands.find((entry) => entry.id === id)?.stdout === "once\n", "Retry after completion changed retained evidence.");
    const counter = await this.run(`cat '${filename}'`);
    requireValue(counter.status === "completed" && counter.exitCode === 0 && counter.stdout === "once\n", "An identical request executed again after completion.");
    return { requestIdDeduplicated: true, changedCommandDenied: true, concurrentCommandDenied: true };
  }

  async submit(cleanup = false) {
    const result = await this.request("POST", "/api/assess/submit", { body: { token: this.token }, cleanup });
    requireValue(result.ok === true && result.defenceRequired !== true, "Bravo submission did not close its main work.");
    return result;
  }

  async submissionChecks() {
    await this.submit();
    await this.request("POST", "/api/assess/lab", { body: this.commandBody("printf 'late\\n'"), expected: 403 });
    await this.request("POST", "/api/assess/lab", { body: { token: this.token, taskNumber: 1, action: "start" }, expected: 403 });
    const state = await this.state();
    requireValue(["stopped", "expired", "failed"].includes(state.session?.status), "Submission did not lock the lab session.");
    requireValue([...this.commandIds].every((id) => state.commands.some((entry) => entry.id === id)), "Submission lost previously recorded command evidence.");
    await this.request("GET", this.route(), { authenticated: false, expected: 403 });
    await this.request("GET", this.route(ALPHA_TOKEN), { expected: 403 });
    return { closedStatus: state.session.status, evidenceRecordsRetained: this.commandIds.size, lateCommandsDenied: true, missingCookieStillDenied: true };
  }

  async cleanup() {
    if (!this.startAttempted) return;
    let passed = false;
    try {
      await this.submit(true);
      passed = true;
    } catch { /* Report only a fixed error; no cookie or API response is printed. */ }
    this.results.push({ check: "finally_submit_bravo", passed,
      ...(passed ? {} : { error: "Bravo cleanup submission was not confirmed; operator follow-up is required." }) });
    requireValue(passed, "Bravo cleanup submission was not confirmed.");
  }
}

async function main() {
  let suite;
  let passed = false;
  let failure;
  try {
    suite = new PilotChecks();
    await suite.check("start_synthetic_bravo", () => suite.startAssessment());
    await suite.check("session_task_and_origin_boundaries", () => suite.accessChecks());
    await suite.check("live_lab_ready", () => suite.startLab());
    await suite.check("recorded_output_exit_status_and_workspace_persistence", () => suite.outputAndPersistence());
    await suite.check("request_id_and_concurrency", () => suite.retryAndConcurrency());
    await suite.check("submission_lockout_and_authenticated_evidence", () => suite.submissionChecks());
    passed = true;
  } catch (error) {
    failure = error instanceof CheckFailure ? error.message : "Unexpected application acceptance failure; details were not logged.";
  } finally {
    if (suite) {
      try { await suite.cleanup(); }
      catch { passed = false; }
    }
  }
  console.log(JSON.stringify({ suite: "synthetic_bravo_application_api", passed,
    seconds: suite ? Number(((Date.now() - suite.started) / 1000).toFixed(2)) : 0,
    checks: suite?.results ?? [], ...(failure ? { error: failure } : {}),
  }, null, 2));
  process.exitCode = passed ? 0 : 1;
}

await main();
