/** Reconnect the existing UNIQassess repository after its rename. Credentials stay in memory. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Hash } from "@smithy/hash-node";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const account = "891612540396", region = "eu-west-1", appId = "d1wxabrgr6nkub";
const oldRepository = "https://github.com/McBellers-unlocked/meritia-assessment";
const repository = "https://github.com/McBellers-unlocked/uniqassess";
const statePath = join(root, ".deployment", "amplify-repository-repair.json");
function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 5 * 1024 * 1024 }).trim();
}
function aws(args) { return JSON.parse(run("aws", [...args, "--region", region, "--output", "json", "--no-cli-pager"])); }

async function main() {
  if (aws(["sts", "get-caller-identity"]).Account !== account) throw new Error("Unexpected AWS account.");
  const app = aws(["amplify", "get-app", "--app-id", appId]).app;
  if (![oldRepository, repository].some((url) => url.toLowerCase() === app.repository.toLowerCase())) throw new Error("Unexpected Amplify source repository.");
  for (const repo of ["McBellers-unlocked/meritia-assessment", "McBellers-unlocked/uniqassess"]) {
    const meta = JSON.parse(run("gh", ["api", `repos/${repo}`]));
    if (meta.id !== 1213536660 || meta.full_name !== "McBellers-unlocked/uniqassess") throw new Error("Repository identity changed; no update performed.");
  }
  const commit = run("gh", ["api", "repos/McBellers-unlocked/uniqassess/commits/main", "--jq", ".sha"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid main commit identity.");
  const before = { repository: app.repository, iamServiceRoleArn: app.iamServiceRoleArn, computeRoleArn: app.computeRoleArn };
  let updated = app;
  if (app.repository.toLowerCase() !== repository.toLowerCase()) {
    const token = run("gh", ["auth", "token", "--hostname", "github.com"]);
    if (!token || /\s/.test(token)) throw new Error("Connected GitHub credential is unavailable.");
    const hostname = `amplify.${region}.amazonaws.com`;
    const signer = new SignatureV4({ credentials: defaultProvider(), region, service: "amplify", sha256: Hash.bind(null, "sha256") });
    const signed = await signer.sign(new HttpRequest({
      protocol: "https:", hostname, path: `/apps/${appId}`, method: "POST",
      headers: { host: hostname, "content-type": "application/json" },
      body: JSON.stringify({ repository, accessToken: token }),
    }));
    const response = await fetch(`https://${hostname}/apps/${appId}`, {
      method: "POST", headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = typeof error.message === "string" ? error.message.split(token).join("[redacted]") : "Request rejected";
      throw new Error(`Amplify repository update failed (${response.status}): ${message}`);
    }
    updated = (await response.json()).app;
  }
  if (updated.repository.toLowerCase() !== repository.toLowerCase() || updated.iamServiceRoleArn !== before.iamServiceRoleArn || updated.computeRoleArn !== before.computeRoleArn) throw new Error("Repository repair verification failed.");
  const record = { ...(existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}), appId, account, region, before, repository, commit, updatedAt: new Date().toISOString(), iamChanges: false };
  writeFileSync(statePath, JSON.stringify(record, null, 2));
  const jobs = aws(["amplify", "list-jobs", "--app-id", appId, "--branch-name", "main", "--max-results", "5"]).jobSummaries;
  if (jobs.some((job) => ["PENDING", "PROVISIONING", "RUNNING", "CANCELLING"].includes(job.status))) {
    console.log(JSON.stringify({ repositoryUpdated: true, runningJobExists: true, iamChanges: false }));
    return;
  }
  const job = aws(["amplify", "start-job", "--app-id", appId, "--branch-name", "main", "--job-type", "RELEASE", "--commit-id", commit, "--job-reason", "Deploy approved Kubernetes pilot after repository rename repair"]).jobSummary;
  record.jobId = job.jobId;
  writeFileSync(statePath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ repositoryUpdated: true, jobId: job.jobId, status: job.status, commit, iamChanges: false }));
}

main().catch((error) => {
  // Child-process objects can include credentials; only show our own bounded diagnostics.
  console.error(error instanceof Error && !Object.hasOwn(error, "stderr") ? error.message : "Repository repair failed. Check the connected GitHub and AWS accounts.");
  process.exitCode = 1;
});
