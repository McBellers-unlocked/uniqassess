"""Temporary operator helper. Never invoked by the application or a candidate."""
import json
import re
from datetime import datetime, timezone
import boto3

SANDBOX = "689324611808"
REGION = "eu-west-1"
STACK = "uniqassess-aws-lab-sandbox"
# Root supplies exact application-generated IDs after the browser attempts exist.
# Never accept caller-provided IDs as an allowlist. This extends only the
# read-only absence operation for the two reviewed synthetic browser attempts.
BROWSER_PILOT_LAB_IDS = frozenset({
    "cmue4s0510005lb1elll83jfa",
    "cmue59x3g000pif1elug51yn8",
})


def handler(event, context):
    credentials = boto3.client("sts").assume_role(
        RoleArn=f"arn:aws:iam::{SANDBOX}:role/OrganizationAccountAccessRole",
        RoleSessionName="uniqassess-account-bootstrap", DurationSeconds=900)["Credentials"]
    session = boto3.Session(aws_access_key_id=credentials["AccessKeyId"],
                           aws_secret_access_key=credentials["SecretAccessKey"],
                           aws_session_token=credentials["SessionToken"], region_name=REGION)
    identity = session.client("sts").get_caller_identity()
    if identity["Account"] != SANDBOX:
        raise ValueError("Unexpected sandbox account")
    operation = event.get("operation")
    if operation == "probe":
        limits = session.client("lambda").get_account_settings()
        quotas = []
        for page in session.client("service-quotas").get_paginator("list_service_quotas").paginate(ServiceCode="codebuild"):
            for quota in page["Quotas"]:
                name = quota["QuotaName"].lower()
                if "concurrent" in name and ("small" in name or "arm" in name):
                    quotas.append({"name": quota["QuotaName"], "code": quota["QuotaCode"],
                                   "value": quota["Value"], "adjustable": quota["Adjustable"]})
        return {"accountId": SANDBOX, "lambdaQuota": {
            "concurrentExecutions": limits["AccountLimit"]["ConcurrentExecutions"],
            "unreservedConcurrentExecutions": limits["AccountLimit"]["UnreservedConcurrentExecutions"],
            "existingFunctionCount": limits["AccountUsage"]["FunctionCount"]}, "codeBuildQuotas": quotas}
    if operation == "deploy":
        template = event.get("template")
        if not isinstance(template, dict) or set(template.get("Resources", {})) != {"CandidateBoundary", "OrchestratorRole"}:
            raise ValueError("Expected the reviewed fixed sandbox template")
        if template["Resources"]["CandidateBoundary"]["Properties"]["ManagedPolicyName"] != "uniqassess-lab-candidate-boundary":
            raise ValueError("Unexpected boundary name")
        if template["Resources"]["OrchestratorRole"]["Properties"]["RoleName"] != "uniqassess-aws-lab-orchestrator":
            raise ValueError("Unexpected orchestrator role name")
        cloudformation = session.client("cloudformation")
        arguments = dict(StackName=STACK, TemplateBody=json.dumps(template), Capabilities=["CAPABILITY_NAMED_IAM"])
        try:
            cloudformation.describe_stacks(StackName=STACK)
            try:
                result = cloudformation.update_stack(**arguments)
            except cloudformation.exceptions.ClientError as error:
                if "No updates are to be performed" not in str(error):
                    raise
                return {"accountId": SANDBOX, "status": "unchanged", "stackName": STACK}
        except cloudformation.exceptions.ClientError as error:
            if "does not exist" not in str(error):
                raise
            result = cloudformation.create_stack(**arguments, Tags=[{"Key": "Purpose", "Value": "UNIQassess AWS candidate sandbox"}])
        return {"accountId": SANDBOX, "stackId": result["StackId"]}
    if operation == "stack-status":
        cloudformation = session.client("cloudformation")
        stack = cloudformation.describe_stacks(StackName=STACK)["Stacks"][0]
        failures = [{"resource": item["LogicalResourceId"], "status": item["ResourceStatus"],
                     "reason": item.get("ResourceStatusReason", "")}
                    for item in cloudformation.describe_stack_events(StackName=STACK)["StackEvents"]
                    if "FAILED" in item["ResourceStatus"]]
        return {"accountId": SANDBOX, "stackName": STACK, "status": stack["StackStatus"],
                "outputs": stack.get("Outputs", []), "failures": failures}
    if operation == "protect-storage":
        desired = {"BlockPublicAcls": True, "IgnorePublicAcls": True,
                   "BlockPublicPolicy": True, "RestrictPublicBuckets": True}
        client = session.client("s3control")
        client.put_public_access_block(AccountId=SANDBOX, PublicAccessBlockConfiguration=desired)
        actual = client.get_public_access_block(AccountId=SANDBOX)["PublicAccessBlockConfiguration"]
        if actual != desired:
            raise ValueError("Sandbox S3 public-access protection did not match")
        return {"accountId": SANDBOX, "publicAccessBlock": actual}
    if operation == "verify-lab-absence":
        lab_id = event.get("labId", "")
        if not re.fullmatch(r"[a-z][a-z0-9]{19,34}", lab_id) or not (
                re.fullmatch(r"cawsverify[a-z0-9]{10,25}", lab_id) or lab_id in BROWSER_PILOT_LAB_IDS):
            raise ValueError("Only synthetic verification or explicitly allowlisted browser pilot lab IDs are allowed")
        prefix = "uniqassess-lab-" + lab_id
        absent = {}
        def missing(client, method, **arguments):
            try:
                getattr(client, method)(**arguments)
                return False
            except client.exceptions.ClientError as error:
                if error.response["Error"]["Code"] in ["ResourceNotFoundException", "NoSuchEntity", "NoSuchBucket", "404", "NotFound"]:
                    return True
                raise
        absent["function"] = missing(session.client("lambda"), "get_function_configuration", FunctionName=prefix)
        absent["bucket"] = missing(session.client("s3"), "head_bucket", Bucket=f"uniqassess-lab-{SANDBOX}-{lab_id}")
        projects = session.client("codebuild").batch_get_projects(names=[prefix])
        absent["project"] = not projects["projects"] and prefix in projects.get("projectsNotFound", [])
        iam = session.client("iam")
        absent["applicationRole"] = missing(iam, "get_role", RoleName=prefix + "-app")
        absent["jobRole"] = missing(iam, "get_role", RoleName=prefix + "-job")
        alarms = session.client("cloudwatch").describe_alarms(AlarmNames=[prefix + "-errors"])
        absent["alarm"] = not alarms.get("MetricAlarms") and not alarms.get("CompositeAlarms")
        logs = session.client("logs")
        for key, group in [("applicationLogs", "/aws/lambda/" + prefix), ("jobLogs", "/aws/codebuild/" + prefix)]:
            observed = logs.describe_log_groups(logGroupNamePrefix=group)["logGroups"]
            absent[key] = not any(item["logGroupName"] == group for item in observed)
        return {"accountId": SANDBOX, "labId": lab_id, "observedAt": datetime.now(timezone.utc).isoformat(),
                "absent": absent, "allAbsent": all(absent.values())}
    raise ValueError("Unsupported bootstrap operation")
