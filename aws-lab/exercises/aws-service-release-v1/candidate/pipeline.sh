#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build evidence
python -m unittest discover -s tests -v
python - <<'PY'
from zipfile import ZipFile, ZIP_DEFLATED
with ZipFile('build/app.zip', 'w', ZIP_DEFLATED) as archive:
    archive.write('app.py', 'app.py')
PY

# Complete the release and rollback stages. README.lab.md defines success.
# session.json contains operator-supplied non-secret names, not credentials.
FUNCTION_NAME=$(python -c 'import json; print(json.load(open("session.json"))["function_name"])')
REGION=$(python -c 'import json; print(json.load(open("session.json"))["region"])')
aws lambda update-function-code --region "$REGION" --function-name "$FUNCTION_NAME" \
  --zip-file fileb://build/app.zip > evidence/code-update.json
aws lambda wait function-updated --region "$REGION" --function-name "$FUNCTION_NAME"
terraform init -input=false
terraform plan -input=false -var='release_version=$LATEST' -out=build/release.tfplan
terraform apply -input=false build/release.tfplan
