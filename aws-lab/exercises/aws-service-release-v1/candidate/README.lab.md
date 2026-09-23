# Order-status release lab

This is a fictional application in a dedicated candidate AWS sandbox. Use the lab's asynchronous jobs; a job can run for up to five minutes. Files persist between successful workspace saves. Check each job's terminal state and logs. The assessment deadline and submission stop admission of work and trigger account cleanup. Never use personal or production credentials.

Project files and Terraform state persist, but downloaded provider caches (`.terraform`) and Python caches (`__pycache__`) do not. Begin each separate Terraform job with `terraform init -input=false`; the supplied pipeline already does this. Shell variables do not carry between jobs.

IAM and alias changes may take time to become visible. Use bounded read/invoke checks and retain the retries as evidence instead of blindly repeating Terraform or deployment mutations.

`session.json` and `terraform.tfvars.json` are provided by the operator. Confirm their fixed account and region against `aws sts get-caller-identity`. They name `function_name`, `application_role_name`, `data_bucket`, `alarm_name`, and the supplied immutable `known_good_version`. The permitted stable alias is `live`. These files contain names, not credentials. Temporary job credentials are supplied by the runner; do not copy them into files, notes or output.

The function, application role, permissions boundary and private bucket already exist. The role boundary, trust, function memory/runtime/timeout/concurrency, bucket policy and pipeline engine are outside your remit. You may update application code, the `app-runtime` inline policy within its protected boundary, the `live` alias and one CloudWatch alarm with the supplied name. Account/region changes, public grants and unrelated resources are not required.

## Application and evidence

- `app.py` is deployed with handler `app.handler`. The operator supplies `BUCKET_NAME` and `ORDER_PREFIX=orders/`.
- The supplied S3 object is `orders/order-1042.json`, containing `{"order_id":"order-1042","status":"confirmed"}`. The provided missing-order test uses `order-9999`.
- Invoke the service with `{"order_id":"order-1042"}`. A successful response has `statusCode:200` and that order/status in its JSON `body`. Missing data is 404; a dependency/access failure must not masquerade as success.
- Local contract tests run with `python -m unittest discover -s tests -v`. They use an in-memory S3 substitute. Passing them proves no real AWS permission or deployment.
- Logs contain request-correlated `dependency_span` and `request_summary` JSON, including measured read duration and result. These are application spans, not an installed distributed tracing/APM platform. Retain request IDs and compare actual before/after measurements; the assessment's synthetic exhibit is separate evidence.
- CloudWatch Embedded Metric Format records `Requests`, `Errors` (5xx only) and `DurationMs` under namespace `UNIQassess/Lab`, dimension `FunctionName=<function_name>`. A returned application 503 is not necessarily a Lambda invocation error, so choose the metric deliberately.
- The bounded test event `{"order_id":"order-1042","exercise_fault":"dependency_unavailable"}` returns a deliberate synthetic 503 and emits one real Errors metric. It performs no S3 request. Use it to test an alarm, label the fault injection, then invoke normally to verify recovery. Metric/alarm processing is asynchronous; poll through separate short jobs. Do not use sustained load or external notifications.

## Release work

The supplied Terraform state imports `aws_iam_role_policy.app_runtime` and `aws_lambda_alias.live`. Use this state and the pinned provider; do not create or replace the function or role. The candidate project contains three kinds of assessed change: the bounded policy, release alias, and a new `aws_cloudwatch_metric_alarm.service_errors` with the supplied name. Retain state files so the operator can reconcile them, but do not include raw state in your written answer.

Complete `pipeline.sh` so it runs tests, validates/reviews a saved plan, applies bounded changes, deploys one identifiable artifact, publishes an immutable version, smoke-tests that version, promotes the alias and verifies the alias. A failing gate must stop the release. Demonstrate a failed gate without deploying failed code. Preserve run IDs, version/artifact identity and relevant output under `evidence/`.

Demonstrate rollback to the recorded known-good version and run the same functional smoke checks afterward. Do not claim that a written rollback command was executed. Explain how rollback of code/alias relates to infrastructure/policy changes and what remains changed.

Make one evidence-led performance improvement that preserves the response contract, and record comparison limitations. Configure the supplied alarm and observe a bounded breach/recovery. A proposed alert alone does not satisfy this task's practical monitoring evidence.

The partner-update architecture extension in the exhibit is a written design task. Do not deploy that extension here. If a platform job or evidence recorder fails, record the failure and use the support route; do not fabricate a successful output.
