import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PrismaClient } from "@prisma/client";
import { reconcileKubernetesLabs } from "../../../src/lib/recruit/reconcile-kubernetes-labs";

type Secrets = { database: string; runner: string };

export function parseReconciliationSecrets({ database, runner }: Secrets) {
  const db: unknown = JSON.parse(database);
  const config: unknown = JSON.parse(runner);
  if (!db || typeof db !== "object" || Array.isArray(db) || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid configuration");
  const databaseUrl = (db as Record<string, unknown>).DATABASE_URL;
  const lab = config as Record<string, unknown>;
  if (typeof databaseUrl !== "string" || !["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)) throw new Error("Invalid database configuration");
  if (typeof lab.enabled !== "boolean" || typeof lab.url !== "string" || typeof lab.key !== "string" || lab.key.length < 32) throw new Error("Invalid runner configuration");
  const url = new URL(lab.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid runner configuration");
  return { databaseUrl, runnerUrl: url.toString().replace(/\/$/, ""), runnerKey: lab.key };
}

export async function handler() {
  const client = new SecretsManagerClient({ region: process.env.APP_REGION || "eu-west-1", maxAttempts: 2 });
  let prisma: PrismaClient | undefined;
  try {
    const databaseArn = process.env.LAB_RECONCILE_DATABASE_SECRET_ARN;
    const runnerArn = process.env.KUBERNETES_LAB_CONFIG_SECRET_ARN;
    if (!databaseArn || !runnerArn) throw new Error("Missing secret locators");
    const [database, runner] = await Promise.all([databaseArn, runnerArn].map(async (arn) => {
      const result = await client.send(new GetSecretValueCommand({ SecretId: arn }), { abortSignal: AbortSignal.timeout(5_000) });
      if (!result.SecretString) throw new Error("Missing secret value");
      return result.SecretString;
    }));
    const config = parseReconciliationSecrets({ database, runner });
    // Database credentials exist only in trusted app compute, never the lab VPC.
    process.env.KUBERNETES_LABS_ENABLED = "false";
    process.env.KUBERNETES_LAB_RUNNER_URL = config.runnerUrl;
    process.env.KUBERNETES_LAB_RUNNER_KEY = config.runnerKey;
    const locator = process.env.KUBERNETES_LAB_CONFIG_SECRET_ARN;
    delete process.env.KUBERNETES_LAB_CONFIG_SECRET_ARN;
    try {
      prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
      const summary = await reconcileKubernetesLabs(prisma);
      console.log(JSON.stringify(summary));
      if (summary.failed) throw new Error("Some sessions need retry");
      return summary;
    } finally {
      process.env.KUBERNETES_LAB_CONFIG_SECRET_ARN = locator;
      delete process.env.KUBERNETES_LAB_RUNNER_URL;
      delete process.env.KUBERNETES_LAB_RUNNER_KEY;
    }
  } catch {
    throw new Error("Lab reconciliation failed. Check worker permissions, configuration and connectivity.");
  } finally {
    client.destroy();
    await prisma?.$disconnect().catch(() => {});
  }
}
