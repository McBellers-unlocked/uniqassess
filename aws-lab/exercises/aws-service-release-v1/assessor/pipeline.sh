#!/usr/bin/env bash
# ASSESSOR REFERENCE ONLY. Do not package this file in the candidate workspace.
set -euo pipefail
cd "$(dirname "$0")"
MODE=${1:-release}
[[ "$MODE" == release || "$MODE" == rollback ]] || { echo 'Use release or rollback'; exit 2; }
mkdir -p build evidence
read_field() { python -c 'import json,sys; print(json.load(open("session.json"))[sys.argv[1]])' "$1"; }
FUNCTION_NAME=$(read_field function_name)
REGION=$(read_field region)
ACCOUNT_ID=$(read_field account_id)
KNOWN_GOOD=$(read_field known_good_version)
export AWS_DEFAULT_REGION="$REGION"
OBSERVED_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[[ "$OBSERVED_ACCOUNT" == "$ACCOUNT_ID" ]] || { echo 'Unexpected account; stopped'; exit 3; }
aws sts get-caller-identity > evidence/identity.json
aws lambda get-alias --function-name "$FUNCTION_NAME" --name live > evidence/previous-alias.json
PREVIOUS=$(python -c 'import json; print(json.load(open("evidence/previous-alias.json"))["FunctionVersion"])')
terraform init -input=false
terraform fmt -check
terraform validate

plan_apply() {
  local version=$1 name=$2
  terraform plan -input=false -var="release_version=$version" -out="build/$name.tfplan"
  terraform show -json "build/$name.tfplan" > "evidence/$name-plan.json"
  python - "$name" <<'PY'
import json, sys
plan = json.load(open('evidence/' + sys.argv[1] + '-plan.json'))
allowed = {'aws_iam_role_policy.app_runtime', 'aws_lambda_alias.live', 'aws_cloudwatch_metric_alarm.service_errors'}
for resource in plan.get('resource_changes', []):
    actions = resource['change']['actions']
    if resource['address'] not in allowed or 'delete' in actions:
        raise SystemExit('Unexpected or destructive plan action; stopped: ' + resource['address'])
print('Plan reviewed: only allowed resources; no deletes or replacements')
PY
  terraform apply -input=false "build/$name.tfplan" | tee "evidence/$name-apply.txt"
}

smoke() {
  local version=$1 prefix=$2
  aws lambda invoke --function-name "$FUNCTION_NAME" --qualifier "$version" \
    --cli-binary-format raw-in-base64-out --payload '{"order_id":"order-1042"}' \
    "evidence/$prefix-response.json" > "evidence/$prefix-invoke.json"
  python - "$prefix" <<'PY'
import json,sys
prefix = 'evidence/' + sys.argv[1]
invocation = json.load(open(prefix + '-invoke.json'))
response = json.load(open(prefix + '-response.json'))
if invocation.get('FunctionError') or response.get('statusCode') != 200:
    raise SystemExit('Service smoke check failed')
body = json.loads(response['body'])
assert body == {'order_id': 'order-1042', 'status': 'confirmed'}, body
print('Service smoke check passed; executed version:', invocation.get('ExecutedVersion'))
PY
}

if [[ "$MODE" == rollback ]]; then
  plan_apply "$KNOWN_GOOD" rollback
  smoke live rollback
  aws lambda get-alias --function-name "$FUNCTION_NAME" --name live > evidence/rollback-alias.json
  echo "Rollback completed and service verified; Terraform changes outside the alias remain governed by the reviewed plan"
  exit 0
fi

python -m unittest discover -s tests -v 2>&1 | tee evidence/tests.txt
python - <<'PY'
from zipfile import ZipFile, ZIP_DEFLATED
from hashlib import sha256
from pathlib import Path
with ZipFile('build/app.zip', 'w', ZIP_DEFLATED) as archive:
    archive.write('app.py', 'app.py')
Path('evidence/artifact-sha256.txt').write_text(sha256(Path('build/app.zip').read_bytes()).hexdigest() + '\n')
PY
# Correct the bounded application policy before checking a version that needs it.
plan_apply "$PREVIOUS" infrastructure
aws lambda update-function-code --function-name "$FUNCTION_NAME" --zip-file fileb://build/app.zip > evidence/code-update.json
aws lambda wait function-updated --function-name "$FUNCTION_NAME"
aws lambda publish-version --function-name "$FUNCTION_NAME" > evidence/published-version.json
VERSION=$(python -c 'import json; print(json.load(open("evidence/published-version.json"))["Version"])')
smoke "$VERSION" immutable
plan_apply "$VERSION" release
smoke live live
aws lambda get-alias --function-name "$FUNCTION_NAME" --name live > evidence/released-alias.json
terraform plan -input=false -var="release_version=$VERSION" -detailed-exitcode > evidence/post-release-plan.txt
echo "Release complete; immutable version $VERSION. Use ./pipeline.sh rollback to demonstrate the known-good rollback."
