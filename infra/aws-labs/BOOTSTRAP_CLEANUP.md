# Temporary AWS lab bootstrap cleanup

Status: **completed at 2026-09-23T13:44:21.187Z** after operator authorization and both independent browser absence receipts. The temporary Lambda and its IAM role/sole inline policy were removed. Exact-resource lookups confirmed the function and role absent; the permanent runtime remained healthy, reconciliation enabled, and the exclusive lease empty. [Sanitized receipt](bootstrap-cleanup-evidence.json).

The only removal targets are in management account `891612540396`, region `eu-west-1`:

- Lambda `uniqassess-aws-lab-account-bootstrap`.
- IAM role `uniqassess-aws-lab-account-bootstrap` and its sole inline policy `AssumeOnlyDedicatedSandbox`.

The guarded operator script is `node infra/aws-labs/cleanup-bootstrap.mjs --inspect`. After final operator authorization, use `--execute-after-acceptance`. Both modes require the passing operator acceptance and the separate Alpha/Beta independent absence receipts; the script reads the exclusive DynamoDB lease and each browser session's cleanup status before allowing removal. It does not trigger lab cleanup.

Do not remove the organization, OU, member account, `OrganizationAccountAccessRole`, scoped child orchestrator, candidate boundary, production application, Kubernetes resources, AWS lab runtime, DynamoDB state, artifact bucket or reconciliation rule.

## Checks before removal

1. Verify STS caller account is exactly `891612540396` and select the explicit default CLI profile and `eu-west-1` region.
2. Save the final synthetic and browser-pilot independent absence receipts. The helper must report the correct child account and all required resources absent; a denied lookup is not absence.
3. Verify the management runtime's stack and function are healthy and its reconciliation rule remains enabled. Verify the exclusive lease is no longer occupied by an unfinished test.
4. Check the helper function's IAM role ARN equals `arn:aws:iam::891612540396:role/uniqassess-aws-lab-account-bootstrap`. Its `ManagedBy` tag must be `uniqassess-aws-lab-account-provisioner`.
5. Check the same tag on the IAM role. Its only inline policy must be `AssumeOnlyDedicatedSandbox`, granting only `sts:AssumeRole` on `arn:aws:iam::689324611808:role/OrganizationAccountAccessRole`. Attached managed policies and instance-profile associations must be empty. Stop if these checks reveal another use.

## Exact removal order

Use the AWS SDK or explicit AWS CLI arguments, passing only the exact names above; no wildcard resource enumeration or deletion:

1. `DeleteFunction` for the bootstrap Lambda. This removes only that helper and its function versions.
2. `DeleteRolePolicy` for `AssumeOnlyDedicatedSandbox` on the bootstrap role.
3. `DeleteRole` for the bootstrap role.

The application and normal controller never invoke this helper. The child `OrganizationAccountAccessRole` remains an Organizations provisioning role; it is not a candidate identity and is not part of this cleanup.

## Confirmation and receipt

Read back the two exact resources. Lambda `GetFunction` must return `ResourceNotFoundException`; IAM `GetRole` must return `NoSuchEntity`. Other errors are failures, not proof of deletion. Recheck the normal lab runtime's health, enabled reconciliation and the final test lease's completed cleanup record.

Save a sanitized `bootstrap-cleanup-evidence.json` with the timestamp, exact deleted resource names/ARNs, target account, absence results, preserved runtime checks and pending items. Do not include credentials or owner email. Update the deployment report's cleanup status only after these checks pass. The account provisioning script can deliberately recreate this helper for future authorized maintenance; do not rerun it merely as a status check after cleanup.
