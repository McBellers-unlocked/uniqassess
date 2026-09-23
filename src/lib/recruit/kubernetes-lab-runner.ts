import { LAB_OUTPUT_MAX_CHARS } from "./kubernetes-lab-config";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export class LabError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}

export type RunnerSession = {
  id: string; status: "starting" | "ready" | "failed" | "stopped" | "expired"; expiresAt: string;
  snapshot?: { capturedAt: string; content: string; truncated: boolean };
  cleanupComplete?: boolean;
};
export type RunnerCommand = {
  id: string; status: "queued" | "running" | "completed" | "failed";
  stdout: string; stderr: string; exitCode: number | null; truncated: boolean;
  startedAt?: string; finishedAt?: string;
};

export type RunnerSettings = { url: string; key: string };

// Read these names explicitly: Next.js replaces the nonsecret Amplify build
// configuration references. The runner key is deliberately absent from next.config.env.
function serverEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    APP_REGION: process.env.APP_REGION,
    KUBERNETES_LABS_ENABLED: process.env.KUBERNETES_LABS_ENABLED,
    KUBERNETES_LAB_CONFIG_SECRET_ARN: process.env.KUBERNETES_LAB_CONFIG_SECRET_ARN,
    KUBERNETES_LAB_RUNNER_URL: process.env.KUBERNETES_LAB_RUNNER_URL,
    KUBERNETES_LAB_RUNNER_KEY: process.env.KUBERNETES_LAB_RUNNER_KEY,
  };
}

/** Pure validation of direct server configuration, retained for local/operator use. */
export function runnerSettings(env: NodeJS.ProcessEnv = serverEnvironment()): RunnerSettings | null {
  if (env.KUBERNETES_LABS_ENABLED !== "true") return null;
  const key = env.KUBERNETES_LAB_RUNNER_KEY ?? "";
  try {
    const url = new URL(env.KUBERNETES_LAB_RUNNER_URL ?? "");
    const local = env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || key.length < 32) return null;
    return { url: url.toString().replace(/\/$/, ""), key };
  } catch { return null; }
}

type SettingsResolverOptions = {
  environment?: () => NodeJS.ProcessEnv;
  readSecret?: (arn: string, region: string) => Promise<string | undefined>;
  now?: () => number;
  cleanupOnly?: boolean;
};

async function readRunnerSecret(arn: string, region: string) {
  const client = new SecretsManagerClient({ region, maxAttempts: 2 });
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: arn }), {
      abortSignal: AbortSignal.timeout(4_000),
    });
    return result.SecretString;
  } finally { client.destroy(); }
}

/** Server-side lookup using the hosting compute role; no secret is embedded at build time. */
export function createRunnerSettingsResolver({
  environment = serverEnvironment, readSecret = readRunnerSecret, now = Date.now, cleanupOnly = false,
}: SettingsResolverOptions = {}) {
  let cached: { identity: string; expiresAt: number; value: RunnerSettings | null } | undefined;
  let pending: { identity: string; promise: Promise<RunnerSettings | null> } | undefined;
  return async function resolve(): Promise<RunnerSettings | null> {
    if (typeof window !== "undefined") throw new LabError("Lab configuration is available only on the server.");
    const env = environment();
    if (!cleanupOnly && env.KUBERNETES_LABS_ENABLED !== "true") return null;
    const arn = env.KUBERNETES_LAB_CONFIG_SECRET_ARN;
    if (!arn) return runnerSettings(cleanupOnly ? { ...env, KUBERNETES_LABS_ENABLED: "true" } : env);
    const region = env.APP_REGION || "eu-west-1";
    const identity = `${arn}\n${region}\n${env.NODE_ENV}`;
    if (cached?.identity === identity && cached.expiresAt > now()) return cached.value;
    if (pending?.identity === identity) return pending.promise;
    const requestedAt = now();
    const promise = (async () => {
      try {
        const text = await readSecret(arn, region);
        const raw: unknown = text ? JSON.parse(text) : null;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid configuration");
        const secret = raw as Record<string, unknown>;
        if (typeof secret.enabled !== "boolean") throw new Error("Invalid configuration");
        const value = secret.enabled || cleanupOnly ? runnerSettings({
          NODE_ENV: env.NODE_ENV,
          KUBERNETES_LABS_ENABLED: "true",
          KUBERNETES_LAB_RUNNER_URL: typeof secret.url === "string" ? secret.url : "",
          KUBERNETES_LAB_RUNNER_KEY: typeof secret.key === "string" ? secret.key : "",
        }) : null;
        if ((secret.enabled || cleanupOnly) && !value) throw new Error("Invalid configuration");
        // Count TTL from request start, never reuse stale credentials after expiry,
        // and share one in-flight lookup across requests in this server process.
        cached = { identity, expiresAt: requestedAt + 60_000, value };
        return value;
      } catch {
        throw new LabError("The lab service configuration is unavailable. Contact your assessment organiser.");
      }
    })();
    pending = { identity, promise };
    try { return await promise; }
    finally { if (pending?.promise === promise) pending = undefined; }
  };
}

export const resolveRunnerSettings = createRunnerSettingsResolver();
// Disablement closes the candidate entry point, but must not stop evidence and cleanup.
export const resolveRunnerCleanupSettings = createRunnerSettingsResolver({ cleanupOnly: true });

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LabError("The lab service returned an invalid response.");
  return raw as Record<string, unknown>;
}
export function parseRunnerSession(raw: unknown, id: string): RunnerSession {
  const r = asRecord(raw);
  if (r.id !== id || !["starting", "ready", "failed", "stopped", "expired"].includes(String(r.status)) || !validTime(r.expiresAt)) {
    throw new LabError("The lab service returned an invalid session.");
  }
  let snapshot: RunnerSession["snapshot"];
  if (r.snapshot != null) {
    const s = asRecord(r.snapshot);
    if (!validTime(s.capturedAt) || typeof s.content !== "string" || typeof s.truncated !== "boolean") {
      throw new LabError("The lab service returned an invalid final snapshot.");
    }
    snapshot = { capturedAt: s.capturedAt, content: s.content.slice(0, LAB_OUTPUT_MAX_CHARS), truncated: s.truncated || s.content.length > LAB_OUTPUT_MAX_CHARS };
  }
  return { id, status: r.status as RunnerSession["status"], expiresAt: r.expiresAt,
    ...(snapshot ? { snapshot } : {}), cleanupComplete: r.cleanupComplete === true };
}
export function parseRunnerCommand(raw: unknown, id: string): RunnerCommand {
  const r = asRecord(raw);
  if (r.id !== id || !["queued", "running", "completed", "failed"].includes(String(r.status)) ||
      typeof r.stdout !== "string" || typeof r.stderr !== "string" ||
      !(r.exitCode === null || Number.isInteger(r.exitCode)) || typeof r.truncated !== "boolean" ||
      (r.startedAt != null && !validTime(r.startedAt)) || (r.finishedAt != null && !validTime(r.finishedAt))) {
    throw new LabError("The lab service returned an invalid command result.");
  }
  return {
    id, status: r.status as RunnerCommand["status"], stdout: r.stdout.slice(0, LAB_OUTPUT_MAX_CHARS),
    stderr: r.stderr.slice(0, LAB_OUTPUT_MAX_CHARS), exitCode: r.exitCode as number | null,
    truncated: r.truncated || r.stdout.length > LAB_OUTPUT_MAX_CHARS || r.stderr.length > LAB_OUTPUT_MAX_CHARS,
    ...(validTime(r.startedAt) ? { startedAt: r.startedAt } : {}),
    ...(validTime(r.finishedAt) ? { finishedAt: r.finishedAt } : {}),
  };
}

/** The application only talks to an operator-configured service. It never executes shell commands. */
export async function runnerRequest(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const settings = await resolveRunnerSettings();
  if (!settings) throw new LabError("The practical lab is not available. Contact your assessment organiser.");
  return requestWithSettings(settings, path, method, body);
}

/** Restricted transport for trusted reconciliation and submission cleanup. Never runs candidate work. */
export async function runnerCleanupRequest(path: string, method = "GET", body?: unknown): Promise<unknown> {
  if (!["GET", "DELETE"].includes(method) || body !== undefined) throw new LabError("Reconciliation may only retrieve evidence or close a lab.", 400);
  const settings = await resolveRunnerCleanupSettings();
  if (!settings) throw new LabError("The lab cleanup service is not configured.");
  return requestWithSettings(settings, path, method);
}

async function requestWithSettings(settings: RunnerSettings, path: string, method: string, body?: unknown): Promise<unknown> {
  try {
    const response = await fetch(`${settings.url}/v1/labs/${path}`, {
      method, headers: { Authorization: `Bearer ${settings.key}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8_000), cache: "no-store", redirect: "error",
    });
    if (!response.ok) {
      // Never relay broker/cluster details, keys or upstream error bodies to candidates.
      if (response.status === 404) throw new LabError("The lab session or command was not found.", 404);
      if (response.status === 409) throw new LabError("The lab is still preparing or a command is already running.", 409);
      if (response.status === 429) throw new LabError("The lab has reached its capacity. Try again shortly.", 429);
      throw new LabError("The lab service is unavailable. Your saved work is retained.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new LabError("The lab service returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 512_000) throw new LabError("The lab service response exceeded the permitted size.");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof LabError) throw error;
    throw new LabError("The lab service could not be reached. Your saved work is retained; refresh to check its status.");
  }
}
