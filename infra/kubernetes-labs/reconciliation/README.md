# Trusted application reconciliation Lambda

This worker copies command results/final snapshots into PostgreSQL and closes expired or submitted labs every minute, independently of candidate browsers. It reuses the application's lifecycle implementation. It can only GET evidence and DELETE labs; candidate operations are disabled in its process even if the runner secret says `enabled: true`.

Deploy it in trusted application infrastructure, **outside the candidate lab VPC**. Do not install this worker or its database credential on the lab control node or candidate nodes. The broker and cluster janitor continue to own independent cluster-side expiry and deletion.

## Build

Use the repository's lockfile (`npm ci`) and then:

```powershell
./scripts/package-lab-reconciler.ps1
```

The command builds the bundle, generates a separate Prisma client with `rhel-openssl-3.0.x`, and writes a unique ZIP under ignored `build/`. It does not modify the application schema/client or read live credentials. `build/lab-reconciler-artifact.json` records the latest directory and ZIP path. The ZIP includes the hidden `.prisma` directory; avoid archive tools that skip dot directories.

On another operator OS, `npm run labs:reconcile:build` emits the artifact directory to archive with its contents at the ZIP root. Package every file, including `node_modules/.prisma/client`. The build uses the pinned Prisma dependency and esbuild installed through the existing lockfile.

Target: `nodejs22.x`, `x86_64`, handler `index.handler`. Node 22 uses Amazon Linux 2023; Prisma needs its OpenSSL 3 Linux engine. See [AWS runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) and [Prisma Lambda deployment](https://docs.prisma.io/docs/orm/v6/prisma-client/deployment/serverless/deploy-to-aws-lambda).

## Configure and deploy

Create two Secrets Manager values in the application region:

- Database secret: `{"DATABASE_URL":"postgresql://..."}`. Prefer a database account limited to the reconciliation tables and required candidate reads. Keep connection/pool timeouts bounded and allow at most four pooled connections.
- Runner secret: `{"enabled":false,"url":"https://runner.example","key":"a-random-shared-key-of-at-least-32-characters"}`. Use the same secret as the application. Cleanup requires valid URL/key fields even when disabled.

For the verified UNIQassess pilot deployment, `node scripts/lab-deployment-ops.mjs reconcile-role` creates or rotates the fixed `uniqassess_lab_reconciler` login and updates only its dedicated database secret. It checks the AWS account, RDS target, secret identity and disabled schedule first. It grants CONNECT/USAGE, SELECT on candidates and the two lab tables, and UPDATE on the two lab tables. The role has no elevated attributes or other table privileges; connection and query timeouts are bounded. Passwords remain in process memory. Existing PostgreSQL PUBLIC privileges are left unchanged, including temporary-table permission; the role has no database/schema CREATE privilege. Reinvoke the Lambda after each rotation before enabling its schedule.

Upload the ZIP to the approved application deployment bucket, then deploy `template.yaml` using `CAPABILITY_IAM` and these parameters:

The current pilot bootstrap bucket expires uploaded objects after seven days. Lambda retains its deployed code, but a later stack rebuild or rollback may need a newly built and uploaded ZIP. Keep the source and lockfile version with the deployment record, use a new content-addressed `CodeKey` when rebuilding, and upload it before recreating the stack. Do not rely on the pilot bucket as a permanent artifact archive.

| Parameter | Value |
| --- | --- |
| `FunctionName` | Dedicated reconciler name; defaults to `uniqassess-lab-reconcile-pilot` |
| `DatabaseSecretArn` | Database secret ARN |
| `RunnerConfigSecretArn` | Shared runner configuration secret ARN |
| `CodeBucket` / `CodeKey` | Uploaded ZIP location |
| `ScheduleEnabled` | Start with `false`; set `true` after a successful manual invocation |

The stack grants only two secret reads and writes to its own log stream. If either secret uses a customer-managed KMS key, add `kms:Decrypt` restricted to that key. The function uses a single reserved concurrency slot, a 55-second timeout and 512 MB of memory. It has no public function URL or API route. The one-minute EventBridge rule can invoke only this function; stale scheduled deliveries and automatic retries are bounded.

The template uses ordinary Lambda networking, not the lab VPC. Verify access to the application's database and runner HTTPS endpoint. If the database needs private networking, place this Lambda in the trusted application VPC and add the required narrowly scoped network permissions and routes; never route it through the candidate environment.

## Acceptance and operation

1. Apply the lab database migration first. Invoke the Lambda once with `{}`. An empty system should return `{"examined":0,"failed":0,"deferred":0}`.
2. Verify a closed candidate session reaches a terminal application state with command output, final snapshot when available, and cleanup completion. Repeat with both candidate enablement switches off.
3. Enable the schedule and confirm fresh successful invocations each minute with the browser closed. Monitor Lambda Errors/Throttles/Duration, EventBridge failed invocations, growing deferred work and labs awaiting cleanup. CloudWatch logs contain numeric summaries and sanitized errors only.
4. Rotate a secret and verify the next invocation picks it up; this Lambda does not cache secret values across invocations. Keep it running while the feature is disabled and existing labs drain.

The shared implementation handles up to 100 pending sessions, four at a time. It stops launching batches after 20 seconds to leave time for bounded in-flight requests. Deferred work remains eligible on the next run. Failed batches record a retry-needed state and fail the invocation; the next scheduled run reconciles idempotently. Runtime failure does not imply candidate failure.
