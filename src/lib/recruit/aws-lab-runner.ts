import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { AWS_LAB_TEMPLATE } from "./aws-lab-config";
import { LabError, type RunnerSettings } from "./kubernetes-lab-runner";

export { LabError, parseRunnerCommand, parseRunnerSession } from "./kubernetes-lab-runner";
export type { RunnerCommand, RunnerSession, RunnerSettings } from "./kubernetes-lab-runner";

const REGION = "eu-west-1";
const FUNCTION_ARN = /^arn:aws:lambda:eu-west-1:891612540396:function:uniqassess-aws-lab(?:[-_A-Za-z0-9]*)(?::[-_A-Za-z0-9]+)?$/;
const SESSION_PATH = /^[a-z][a-z0-9]{19,39}$/;
const COMMAND_PATH = /^[a-z][a-z0-9]{19,39}\/commands\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_COLLECTION_PATH = /^[a-z][a-z0-9]{19,39}\/commands$/;

type AwsEnvironment = { AWS_LABS_ENABLED?: string; AWS_LAB_RUNNER_FUNCTION_ARN?: string; APP_REGION?: string };

function serverEnvironment(): AwsEnvironment {
  return {
    AWS_LABS_ENABLED: process.env.AWS_LABS_ENABLED,
    AWS_LAB_RUNNER_FUNCTION_ARN: process.env.AWS_LAB_RUNNER_FUNCTION_ARN,
    APP_REGION: process.env.APP_REGION,
  };
}

/** IAM authenticates Lambda invocation. The compatibility key is a marker, never a credential. */
export function runnerSettings(env: AwsEnvironment = serverEnvironment(), cleanupOnly = false): RunnerSettings | null {
  if ((!cleanupOnly && env.AWS_LABS_ENABLED !== "true") || (env.APP_REGION && env.APP_REGION !== REGION)) return null;
  const arn = env.AWS_LAB_RUNNER_FUNCTION_ARN ?? "";
  return arn === arn.trim() && FUNCTION_ARN.test(arn) ? { url: arn, key: "aws-iam" } : null;
}

type AwsRunnerEvent = { operation: "health" } | { path: string; method: string; body?: unknown };
type AwsRunnerInvoker = (functionArn: string, event: AwsRunnerEvent) => Promise<unknown>;

async function invokeLambda(functionArn: string, event: AwsRunnerEvent): Promise<unknown> {
  const client = new LambdaClient({ region: REGION, maxAttempts: 1 });
  try {
    const result = await client.send(new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(event)),
    }), { abortSignal: AbortSignal.timeout(8_000) });
    if (result.StatusCode !== 200 || result.FunctionError || !result.Payload || result.Payload.byteLength > 512_000) {
      throw new LabError("The AWS lab service returned an invalid response.");
    }
    return JSON.parse(Buffer.from(result.Payload).toString("utf8"));
  } finally { client.destroy(); }
}

function responseEnvelope(value: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LabError("The AWS lab service returned an invalid response.");
  const envelope = value as Record<string, unknown>;
  if (!Number.isInteger(envelope.statusCode) || Number(envelope.statusCode) < 100 || Number(envelope.statusCode) > 599
    || !envelope.body || typeof envelope.body !== "object" || Array.isArray(envelope.body)) {
    throw new LabError("The AWS lab service returned an invalid response.");
  }
  return { statusCode: envelope.statusCode as number, body: envelope.body as Record<string, unknown> };
}

function validOperation(path: string, method: string, body: unknown): boolean {
  if (path !== path.trim()) return false;
  if (SESSION_PATH.test(path)) return (method === "PUT" && body !== undefined) || (["GET", "DELETE"].includes(method) && body === undefined);
  if (COMMAND_COLLECTION_PATH.test(path)) return method === "POST" && body !== undefined;
  return COMMAND_PATH.test(path) && method === "GET" && body === undefined;
}

/** Dependency boundary keeps account, health and cleanup checks testable without AWS credentials. */
export function createAwsRunnerTransport({
  environment = serverEnvironment,
  invoke = invokeLambda,
}: {
  environment?: () => AwsEnvironment;
  invoke?: AwsRunnerInvoker;
} = {}) {
  async function call(settings: RunnerSettings, event: AwsRunnerEvent) {
    if (typeof window !== "undefined") throw new LabError("AWS lab operations are available only on the server.");
    try {
      if (Buffer.byteLength(JSON.stringify(event), "utf8") > 40_000) throw new LabError("The AWS lab request is too large.", 413);
      const result = await invoke(settings.url, event);
      if (Buffer.byteLength(JSON.stringify(result) ?? "", "utf8") > 512_000) throw new LabError("The AWS lab service response exceeded the permitted size.");
      return responseEnvelope(result);
    } catch (error) {
      if (error instanceof LabError) throw error;
      throw new LabError("The AWS lab service could not be reached. Your saved work is retained; refresh to check its status.");
    }
  }

  async function resolveRunnerSettings(): Promise<RunnerSettings | null> {
    const settings = runnerSettings(environment());
    if (!settings) return null;
    // A configured ARN is insufficient: verify the actual provider, version and
    // control-plane health before publication and every candidate operation.
    const result = await call(settings, { operation: "health" });
    return result.statusCode === 200 && result.body.ready === true && result.body.enabled === true
      && result.body.provider === "aws" && result.body.templateId === AWS_LAB_TEMPLATE.id ? settings : null;
  }

  async function resolveRunnerCleanupSettings(): Promise<RunnerSettings | null> {
    // Cleanup must remain callable when starts are disabled or health is degraded.
    return runnerSettings(environment(), true);
  }

  async function request(settings: RunnerSettings | null, path: string, method: string, body?: unknown) {
    if (!settings) throw new LabError("The AWS practical lab is unavailable. Contact your assessment organiser.");
    if (!validOperation(path, method, body)) throw new LabError("Choose a supported AWS lab operation.", 400);
    const result = await call(settings, { path, method, ...(body !== undefined ? { body } : {}) });
    if (result.statusCode >= 200 && result.statusCode < 300) return result.body;
    if (result.statusCode === 404) throw new LabError("The AWS lab session or job was not found.", 404);
    if (result.statusCode === 409) throw new LabError("The AWS lab is preparing or a job is already running.", 409);
    if (result.statusCode === 429) throw new LabError("The AWS lab has reached its capacity. Try again shortly.", 429);
    throw new LabError("The AWS lab service is unavailable. Your saved work is retained.");
  }

  async function runnerRequest(path: string, method = "GET", body?: unknown): Promise<unknown> {
    // The service checks live readiness before dispatch. Keep each dispatch to
    // one bounded invocation while the controller independently enforces its lease.
    return request(runnerSettings(environment()), path, method, body);
  }

  async function runnerCleanupRequest(path: string, method = "GET", body?: unknown): Promise<unknown> {
    if (!["GET", "DELETE"].includes(method) || body !== undefined) throw new LabError("Reconciliation may only retrieve evidence or close an AWS lab.", 400);
    return request(await resolveRunnerCleanupSettings(), path, method);
  }

  return { resolveRunnerSettings, resolveRunnerCleanupSettings, runnerRequest, runnerCleanupRequest };
}

const transport = createAwsRunnerTransport();
export const { resolveRunnerSettings, resolveRunnerCleanupSettings, runnerRequest, runnerCleanupRequest } = transport;

export async function awsLabRuntimeAvailable(): Promise<boolean> {
  try { return Boolean(await resolveRunnerSettings()); } catch { return false; }
}
