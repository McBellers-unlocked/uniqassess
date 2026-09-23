# AWS service release exercise v1

Package **only `candidate/`** for candidates. `assessor/` contains answers and reference repairs and must never enter a candidate archive, AI context, browser response or exhibit.

The exercise is for a dedicated bounded sandbox account. This directory creates no account, IAM credentials, runner or Terraform state. Runtime acceptance and candidate separation are separate requirements. Candidate-visible synthetic telemetry in the assessment content is not a replacement for live cloud evidence.

## Operator contract

Create one private S3 data bucket with `orders/order-1042.json` containing `{"order_id":"order-1042","status":"confirmed"}`. Include an out-of-scope object such as `private/operator-only.json` with fictional content; neither the application nor candidate should gain access by broadening the inline policy. A protected boundary must enforce the intended object scope independently of candidate-editable policy.

Create a fixed application role, trusted only by Lambda, with protected logging permission and a protected permissions boundary. Its candidate-editable inline policy must be named `app-runtime`; initial `s3:GetObject` resource is `arn:aws:s3:::<data_bucket>/archive/*`. The candidate may repair it to the permitted `orders/*` path, but cannot modify trust, boundary or protected log permissions. A separate protected policy and the boundary permit `s3:ListBucket` only on this exact bucket with `s3:prefix` matching `orders/*`. On an AccessDenied read, the handler performs a bounded exact-key existence check under this prefix: an absent key becomes 404; an existing key or denied existence check remains 503. It does not list source/workspace objects or disguise permission failure as missing data.

Create a Python 3.12 Lambda, handler `app.handler`, memory 256 MB, timeout 10 seconds, reserved concurrency 1, environment `BUCKET_NAME=<data_bucket>`, `ORDER_PREFIX=orders/`. Function configuration and resource-based policies are operator-owned. Candidates require bounded UpdateFunctionCode, PublishVersion, read/wait, InvokeFunction and alias control; they do not need UpdateFunctionConfiguration, CreateFunction, DeleteFunction, AddPermission, PassRole or concurrency mutation.

Publish a known-good immutable version from the reference app (see `assessor/build_solution.py:reference_app`) and record its version number. Then deploy and publish the candidate seed app and create alias `live` pointing to that seeded release; `$LATEST` contains the same seeded code. Published versions use the same role, so the initially wrong inline policy also prevents the known-good version from reading orders until repaired. Restore/test the bounded correct policy while verifying the known-good version, then seed the deliberate incorrect policy before candidate access. Never label an unverified version known-good.

Provide non-secret `session.json` with `account_id`, `region`, `function_name`, `application_role_name`, `data_bucket`, `alarm_name`, `known_good_version`. Provide `terraform.tfvars.json` with the same first six fields plus `release_version` equal to the initial live alias version; do **not** include `known_good_version` as an undeclared Terraform variable. Import:

```text
terraform import aws_iam_role_policy.app_runtime <application_role_name>:app-runtime
terraform import aws_lambda_alias.live <function_name>/live
```

Terraform should initialise using provider `hashicorp/aws` **5.100.0**, retain the generated lock file and imported state, and use the operator-fixed account and region. The remote runtime controls workspace persistence; it must preserve state atomically, prevent concurrent jobs per lease and exclude any operator credentials. Cache provider artifacts separately from candidate state when possible. The candidate creates only `aws_cloudwatch_metric_alarm.service_errors` with the supplied name. It uses custom namespace `UNIQassess/Lab`, metric `Errors`, dimension `FunctionName`; no external alarm action is required or permitted in the pilot.

Reference API shapes: [Lambda alias resource](https://registry.terraform.io/providers/hashicorp/aws/5.100.0/docs/resources/lambda_alias), [CloudWatch alarm resource](https://registry.terraform.io/providers/hashicorp/aws/5.100.0/docs/resources/cloudwatch_metric_alarm).

## Deliberate defects and independent evidence

1. IAM inline policy selects `archive/*`; the handler requests `orders/order-1042.json`. The effective boundary prevents broadening beyond the intended prefix. Retain actual AccessDenied and later success plus denied out-of-scope evidence.
2. Seed pipeline sends `$LATEST` as Terraform's alias release version; the numeric guard rejects it. It lacks immutable publication, matching-version smoke tests and rollback. Candidate must implement and execute the release path; a YAML/shell review earns no execution credit.
3. Handler reads the same object three times sequentially. Recorded dependency spans make the repeated work observable. Reference repair reads it once. Cloud latency is measured, not assumed to match the synthetic 750 ms test clock or assessment exhibit.

The app emits actual measured JSON request/dependency spans and CloudWatch EMF metrics. This is request-level instrumentation, not an installed distributed tracing platform. The explicit `exercise_fault=dependency_unavailable` test event emits a deliberately injected synthetic failure, one real Errors datapoint and no S3 call. Live acceptance must show the alarm transitions using real delivered metrics and later healthy calls, recording processing delay. `SetAlarmState` alone is not proof that the metric condition works.

The role/pipeline/window contract is intentionally narrow. A direct Lambda invocation may succeed at the transport level while its returned payload has statusCode 503; inspect both `FunctionError` and the application response. Test retries/failed gates, partial Terraform apply, alias state, previous version evidence and denied access. Retain concise independent state through the trusted runner, since candidate files/output are editable.

## Local tests and reference workspace

```text
python -m unittest discover -s candidate/tests -v
python -m unittest discover -s assessor -p test_fixture.py -v
python assessor/build_solution.py <new-or-empty-output-directory>
```

The seven candidate contract tests use an in-memory S3 substitute and no boto3 install/credentials/network. The three assessor tests verify the measured repeated-read defect under a deterministic fake dependency clock, semantic-preserving reference fix and strict answer/artifact separation. They do not certify cloud IAM, pipeline operation or Terraform provider execution.

The reference workspace adds a bounded alarm and reference pipeline with reviewed plans, immutable publication, version and alias smoke checks, and `./pipeline.sh rollback`. Copy operator session/tfvars/imported state only into the operator's verification workspace. Do not package this answer workspace for candidates.
