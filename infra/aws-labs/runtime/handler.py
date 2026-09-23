"""Private AWS lab controller. Invoked by IAM-authorised app/operator roles only.

Candidate shell code executes in disposable CodeBuild containers in a separate
account. DynamoDB owns leases/idempotency; a protected permissions boundary owns
credential expiry. No app/database credentials enter that account.
"""
from datetime import datetime, timezone
from decimal import Decimal
from contextlib import contextmanager
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import re
import time
import uuid
import zipfile
import tarfile
import copy

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get('REGION', 'eu-west-1')
ACCOUNT = os.environ['SANDBOX_ACCOUNT']
ROLE = os.environ['SANDBOX_ROLE_ARN']
BOUNDARY = os.environ.get('CANDIDATE_BOUNDARY_ARN', f'arn:aws:iam::{ACCOUNT}:policy/uniqassess-lab-candidate-boundary')
TEMPLATE = 'aws-service-release-v1'
TABLE = boto3.resource('dynamodb').Table(os.environ['TABLE_NAME'])
FINAL = ('stopped', 'expired', 'failed')
ACTIVE = ('queued', 'running')
LOG = logging.getLogger(__name__)
LOG.setLevel(logging.INFO)
LIMIT = 32768
# Lambda has a hard 120-second timeout. A lock is never stolen while an earlier
# invocation can still run. The extra minute covers delayed delivery/retries.
WORKER_LOCK_SECONDS = 180


class Failure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def get(key):
    return TABLE.get_item(Key={'id': key}, ConsistentRead=True).get('Item')


def lab(key):
    item = get('L#' + key)
    if not item:
        raise Failure(404, 'Lab not found')
    return item


def update(key, **values):
    names = {f'#n{i}': key for i, key in enumerate(values)}
    attrs = {f':v{i}': value for i, value in enumerate(values.values())}
    TABLE.update_item(Key={'id': key}, UpdateExpression='SET ' + ', '.join(f'#n{i} = :v{i}' for i in range(len(values))),
                      ExpressionAttributeNames=names, ExpressionAttributeValues=attrs)


def conditional_failure(error):
    return error.response['Error']['Code'] in ('ConditionalCheckFailedException', 'TransactionCanceledException')


def transaction(actions):
    # This is the DynamoDB *resource* client's registered serializer. Pass
    # native Python values here; pre-encoding AttributeValues double-serializes.
    TABLE.meta.client.transact_write_items(TransactItems=actions)


def json_safe(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


@contextmanager
def worker_lock(lab_id, operation):
    token = str(uuid.uuid4())
    acquired = False
    try:
        transaction([
            {'ConditionCheck': {'TableName': TABLE.name, 'Key': {'id': 'POOL'},
                'ConditionExpression': 'leaseId = :id', 'ExpressionAttributeValues': {':id': lab_id}}},
            {'Update': {'TableName': TABLE.name, 'Key': {'id': 'L#' + lab_id},
                'UpdateExpression': 'SET workerToken = :token, workerUntil = :until, workerOperation = :op',
                'ConditionExpression': 'attribute_exists(id) AND (attribute_not_exists(workerToken) OR workerUntil < :now)',
                'ExpressionAttributeValues': {':token': token, ':until': int(time.time()) + WORKER_LOCK_SECONDS,
                    ':op': operation, ':now': int(time.time())}}},
        ])
        acquired = True
    except ClientError as error:
        if not conditional_failure(error):
            raise
    try:
        yield token if acquired else None
    finally:
        if acquired:
            try:
                TABLE.update_item(Key={'id': 'L#' + lab_id},
                    UpdateExpression='REMOVE workerToken, workerUntil, workerOperation',
                    ConditionExpression='workerToken = :token', ExpressionAttributeValues={':token': token})
            except ClientError as error:
                if not conditional_failure(error):
                    raise


def assert_work(item, token, status):
    current, pool = lab(item['labId']), get('POOL')
    if (current.get('workerToken') != token or int(current.get('workerUntil', 0)) <= time.time()
            or not pool or pool.get('leaseId') != item['labId'] or current['status'] != status
            or epoch(current['expiresAt']) <= time.time()):
        raise Failure(409, 'Lab work has closed')
    return current


def set_terminal_command(key, **values):
    names = {f'#n{i}': name for i, name in enumerate(values)}
    names['#status'] = 'status'
    attrs = {f':v{i}': value for i, value in enumerate(values.values())}
    attrs.update({':queued': 'queued', ':running': 'running'})
    try:
        TABLE.update_item(Key={'id': key},
            UpdateExpression='SET ' + ', '.join(f'#n{i} = :v{i}' for i in range(len(values))),
            ConditionExpression='#status IN (:queued, :running)',
            ExpressionAttributeNames=names, ExpressionAttributeValues=attrs)
    except ClientError as error:
        if not conditional_failure(error):
            raise


def child():
    credentials = boto3.client('sts').assume_role(RoleArn=ROLE, RoleSessionName='uniqassess-lab-controller', DurationSeconds=900)['Credentials']
    return boto3.Session(aws_access_key_id=credentials['AccessKeyId'], aws_secret_access_key=credentials['SecretAccessKey'],
                         aws_session_token=credentials['SessionToken'], region_name=REGION)


def invoke_worker(operation, **args):
    boto3.client('lambda').invoke(FunctionName=os.environ['AWS_LAMBDA_FUNCTION_NAME'], InvocationType='Event',
                                  Payload=json.dumps({'operation': operation, **args}).encode())


def names(item):
    prefix = 'uniqassess-lab-' + item['labId']
    return {'prefix': prefix, 'bucket': f'uniqassess-lab-{ACCOUNT}-{item["labId"]}', 'function': prefix,
            'appRole': prefix + '-app', 'jobRole': prefix + '-job', 'project': prefix,
            'alarm': prefix + '-errors', 'logs': '/aws/codebuild/' + prefix}


def boundary(session, expires=None, created=None, item=None):
    iam = session.client('iam')
    policy = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Deny', 'Action': '*', 'Resource': '*'}]}
    if expires:
        if not item or item['expiresAt'] != expires or item['createdAt'] != created:
            raise ValueError('A frozen lease is required to enable its boundary')
        n = names(item)
        _, job = policies(item)
        app = {'Version': '2012-10-17', 'Statement': [
            allow(['s3:GetObject'], f'arn:aws:s3:::{n["bucket"]}/orders/*', expires),
            {**allow(['s3:ListBucket'], f'arn:aws:s3:::{n["bucket"]}', expires), 'Condition': {
                'DateLessThan': {'aws:CurrentTime': expires}, 'StringLike': {'s3:prefix': 'orders/*'}}},
            allow(['logs:CreateLogStream', 'logs:PutLogEvents'],
                  f'arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/{n["function"]}:*', expires),
        ]}
        policy = {'Version': '2012-10-17', 'Statement': []}
        for document, role in [(job, n['jobRole']), (app, n['appRole'])]:
            for statement in copy.deepcopy(document['Statement']):
                statement.setdefault('Condition', {}).setdefault('ArnEquals', {})['aws:PrincipalArn'] = f'arn:aws:iam::{ACCOUNT}:role/{role}'
                policy['Statement'].append(statement)
        for statement in policy['Statement']:
            if statement['Effect'] == 'Allow':
                condition = statement.setdefault('Condition', {})
                condition.setdefault('DateLessThan', {})['aws:CurrentTime'] = expires
                # Old and missing token timestamps are explicitly denied below;
                # do not repeat their long conditions in every allow statement.
        # Explicit Deny also fences permissions obtained through resource-based
        # policies; implicit absence of Allow is insufficient for role sessions.
        policy['Statement'].extend([
            {'Sid': 'NoAlarmActions', 'Effect': 'Deny', 'Action': 'cloudwatch:PutMetricAlarm', 'Resource': '*',
             'Condition': {'ForAnyValue:StringLike': {'cloudwatch:AlarmActions': '*'}}},
            {'Sid': 'ExpiredLease', 'Effect': 'Deny', 'Action': '*', 'Resource': '*',
             'Condition': {'DateGreaterThanEquals': {'aws:CurrentTime': expires}}},
            {'Sid': 'PreviousLeaseCredentials', 'Effect': 'Deny', 'Action': '*', 'Resource': '*',
             'Condition': {'DateLessThan': {'aws:TokenIssueTime': created}}},
            {'Sid': 'RequireTemporaryLeaseCredentials', 'Effect': 'Deny', 'Action': '*', 'Resource': '*',
             'Condition': {'Null': {'aws:TokenIssueTime': 'true'}}},
        ])
    versions = iam.list_policy_versions(PolicyArn=BOUNDARY)['Versions']
    for version in versions:
        if not version['IsDefaultVersion']:
            iam.delete_policy_version(PolicyArn=BOUNDARY, VersionId=version['VersionId'])
    document = json.dumps(policy, separators=(',', ':'))
    if len(document) > 6144:
        raise ValueError('Lease boundary exceeds the IAM managed-policy limit')
    iam.create_policy_version(PolicyArn=BOUNDARY, PolicyDocument=document, SetAsDefault=True)


def allow(actions, resources, expires, **extra):
    return {'Effect': 'Allow', 'Action': actions, 'Resource': resources,
            'Condition': {'DateLessThan': {'aws:CurrentTime': expires}}, **extra}


def policies(item):
    n = names(item)
    deadline = item['expiresAt']
    fn = f'arn:aws:lambda:{REGION}:{ACCOUNT}:function:{n["function"]}'
    role = f'arn:aws:iam::{ACCOUNT}:role/{n["appRole"]}'
    bucket = f'arn:aws:s3:::{n["bucket"]}'
    logs = f'arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/{n["function"]}:*'
    joblogs = f'arn:aws:logs:{REGION}:{ACCOUNT}:log-group:{n["logs"]}:*'
    app = {'Version': '2012-10-17', 'Statement': [
        allow(['s3:GetObject'], bucket + '/archive/*', deadline),
        allow(['logs:CreateLogStream', 'logs:PutLogEvents'], logs, deadline),
        {**allow(['s3:ListBucket'], bucket, deadline), 'Condition': {
            'DateLessThan': {'aws:CurrentTime': deadline}, 'StringLike': {'s3:prefix': 'orders/*'}}},
    ]}
    job = {'Version': '2012-10-17', 'Statement': [
        allow(['s3:GetBucketLocation', 's3:ListBucket'], bucket, deadline),
        allow(['s3:GetObject'], [bucket + '/source/*', bucket + '/workspace/*', bucket + '/orders/*', bucket + '/results/*'], deadline),
        allow(['s3:PutObject'], [bucket + '/workspace/*', bucket + '/results/*'], deadline),
        allow(['lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:GetAlias', 'lambda:ListAliases',
               'lambda:ListVersionsByFunction', 'lambda:UpdateFunctionCode', 'lambda:PublishVersion', 'lambda:CreateAlias',
               'lambda:UpdateAlias', 'lambda:DeleteAlias', 'lambda:InvokeFunction', 'lambda:ListTags'], [fn, fn + ':*'], deadline),
        allow(['iam:GetRole', 'iam:GetRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy'], role, deadline),
        allow(['logs:CreateLogStream', 'logs:PutLogEvents'], joblogs, deadline),
        allow(['logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:FilterLogEvents'], logs, deadline),
        allow(['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:ListTagsForResource',
               'cloudwatch:TagResource', 'cloudwatch:UntagResource'], f'arn:aws:cloudwatch:{REGION}:{ACCOUNT}:alarm:{n["alarm"]}', deadline),
        allow(['sts:GetCallerIdentity', 'cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricData', 'cloudwatch:GetMetricStatistics', 'cloudwatch:ListMetrics'], '*', deadline),
    ]}
    return app, job


def session_result(item):
    return {'id': item['labId'], 'status': item['status'], 'expiresAt': item['expiresAt'],
            'cleanupComplete': item.get('cleanupComplete', False), **({'snapshot': item['snapshot']} if item.get('snapshot') else {})}


def command_result(item):
    return json_safe({key: item[key] for key in ('status', 'stdout', 'stderr', 'exitCode', 'truncated', 'startedAt', 'finishedAt') if key in item} | {'id': item['commandId']})


def acquire(lab_id, body):
    if not isinstance(body, dict):
        raise Failure(400, 'Invalid lab configuration')
    existing = get('L#' + lab_id)
    if existing:
        if existing.get('tombstone'):
            raise Failure(409, 'This lab has already closed')
        if body.get('templateId') != existing['templateId'] or body.get('expiresAt') != existing['expiresAt']:
            raise Failure(409, 'Lab configuration cannot be changed')
        return existing
    try:
        end = epoch(body['expiresAt'])
        if body.get('templateId') != TEMPLATE or not time.time() < end <= time.time() + 7200:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise Failure(400, 'Invalid lab template or expiry') from None
    item = {'id': 'L#' + lab_id, 'labId': lab_id, 'templateId': TEMPLATE, 'expiresAt': body['expiresAt'],
            'createdAt': now(), 'status': 'starting', 'cleanupComplete': False}
    try:
        transaction([
            {'Put': {'TableName': TABLE.name, 'Item': item, 'ConditionExpression': 'attribute_not_exists(id)'}},
            {'Put': {'TableName': TABLE.name, 'Item': {'id': 'POOL', 'leaseId': lab_id},
                     'ConditionExpression': 'attribute_not_exists(leaseId)'}},
        ])
    except ClientError as e:
        if e.response['Error']['Code'] == 'TransactionCanceledException':
            existing = get('L#' + lab_id)
            if existing:
                return acquire(lab_id, body)
            raise Failure(429, 'The AWS sandbox is currently in use') from None
        raise
    invoke_worker('prepare', labId=lab_id)
    return item


def prepare(lab_id):
    with worker_lock(lab_id, 'prepare') as token:
        if token:
            _prepare(lab_id, token)


def _prepare(lab_id, token):
    item = lab(lab_id)
    if item['status'] != 'starting' or epoch(item['expiresAt']) <= time.time():
        return
    if item.get('preparingAt'):
        # An earlier invocation died during provisioning. Never replay its side
        # effects or expose a partially prepared environment to a candidate.
        if not item.get('bootstrapBuild'):
            close(lab_id, 'failed')
        return
    try:
        TABLE.update_item(Key={'id': item['id']}, UpdateExpression='SET preparingAt = :now',
                          ConditionExpression='attribute_not_exists(preparingAt) AND #s = :starting',
                          ExpressionAttributeNames={'#s': 'status'},
                          ExpressionAttributeValues={':now': now(), ':starting': 'starting'})
    except ClientError as error:
        if conditional_failure(error):
            return
        raise
    try:
        session = child()
        n = names(item)
        assert_work(item, token, 'starting')
        boundary(session, item['expiresAt'], item['createdAt'], item)
        s3, iam, lam, logs = [session.client(service) for service in ('s3', 'iam', 'lambda', 'logs')]
        s3.create_bucket(Bucket=n['bucket'], CreateBucketConfiguration={'LocationConstraint': REGION})
        s3.put_public_access_block(Bucket=n['bucket'], PublicAccessBlockConfiguration={
            'BlockPublicAcls': True, 'IgnorePublicAcls': True, 'BlockPublicPolicy': True, 'RestrictPublicBuckets': True})
        s3.put_bucket_encryption(Bucket=n['bucket'], ServerSideEncryptionConfiguration={'Rules': [
            {'ApplyServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}}]})
        s3.put_object(Bucket=n['bucket'], Key='orders/order-1042.json', Body=json.dumps({'order_id': 'order-1042', 'status': 'confirmed'}).encode())
        s3.put_object(Bucket=n['bucket'], Key='private/operator-only.json',
                      Body=json.dumps({'fictional': True, 'purpose': 'Verify that candidate access is denied to an existing out-of-scope object'}).encode())
        app_policy, job_policy = policies(item)
        broken_app_policy = {'Version': '2012-10-17', 'Statement': [app_policy['Statement'][0]]}
        healthy_app_policy = copy.deepcopy(broken_app_policy)
        healthy_app_policy['Statement'][0]['Resource'] = f'arn:aws:s3:::{n["bucket"]}/orders/*'
        for role, service, policy, policy_name in [(n['appRole'], 'lambda.amazonaws.com', app_policy, 'app-runtime'),
                                                    (n['jobRole'], 'codebuild.amazonaws.com', job_policy, 'lease-access')]:
            trust = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': service}, 'Action': 'sts:AssumeRole'}]}
            if service == 'codebuild.amazonaws.com':
                trust['Statement'][0]['Condition'] = {'StringEquals': {'aws:SourceAccount': ACCOUNT},
                    'ArnEquals': {'aws:SourceArn': f'arn:aws:codebuild:{REGION}:{ACCOUNT}:project/{n["project"]}'}}
            iam.create_role(RoleName=role, AssumeRolePolicyDocument=json.dumps(trust), PermissionsBoundary=BOUNDARY)
            iam.put_role_policy(RoleName=role, PolicyName=policy_name,
                                PolicyDocument=json.dumps(healthy_app_policy if role == n['appRole'] else policy))
            if role == n['appRole']:
                # The assessed Terraform policy owns data access only. Keep
                # delivery logs when it is legitimately replaced during repair.
                iam.put_role_policy(RoleName=role, PolicyName='platform-logging',
                                    PolicyDocument=json.dumps({'Version': '2012-10-17', 'Statement': app_policy['Statement'][1:]}))
        for group in ['/aws/lambda/' + n['function'], n['logs']]:
            logs.create_log_group(logGroupName=group)
            logs.put_retention_policy(logGroupName=group, retentionInDays=7)
        source = boto3.client('s3').get_object(Bucket=os.environ['ARTIFACT_BUCKET'], Key=os.environ['ARTIFACT_KEY'])['Body'].read()
        with zipfile.ZipFile(BytesIO(source)) as package:
            files = {name: package.read(name) for name in package.namelist() if name.startswith('candidate/') and not name.endswith('/')}
        if 'candidate/app.py' not in files:
            raise ValueError('Candidate fixture missing')
        broken_code = files['candidate/app.py'].decode('utf-8')
        if broken_code.count('for read_number in range(3):') != 1:
            raise ValueError('Fixture changed: baseline requires review')
        healthy_code = broken_code.replace('for read_number in range(3):', 'for read_number in range(1):')
        def application_zip(source):
            code = BytesIO()
            with zipfile.ZipFile(code, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('app.py', source)
            return code.getvalue()
        # IAM propagation is bounded and happens outside a candidate HTTP request.
        for attempt in range(12):
            assert_work(item, token, 'starting')
            try:
                function = lam.create_function(FunctionName=n['function'], Runtime='python3.12',
                    Role=f'arn:aws:iam::{ACCOUNT}:role/{n["appRole"]}', Handler='app.handler', Code={'ZipFile': application_zip(healthy_code)},
                    Timeout=10, MemorySize=256, Publish=True, Environment={'Variables': {'BUCKET_NAME': n['bucket'], 'ORDER_PREFIX': 'orders/'}},
                    TracingConfig={'Mode': 'PassThrough'})
                break
            except ClientError as error:
                if error.response['Error']['Code'] != 'InvalidParameterValueException' or attempt == 11:
                    raise
                time.sleep(3)
        lam.put_function_concurrency(FunctionName=n['function'], ReservedConcurrentExecutions=1)
        known_good = function['Version']
        wait_function(lam, n['function'], item, token)
        for attempt in range(8):
            assert_work(item, token, 'starting')
            observed = lam.invoke(FunctionName=n['function'], Qualifier=known_good,
                                  Payload=json.dumps({'order_id': 'order-1042'}).encode())
            value = json.loads(observed['Payload'].read())
            if (not observed.get('FunctionError') and value.get('statusCode') == 200
                    and json.loads(value.get('body', '{}')) == {'order_id': 'order-1042', 'status': 'confirmed'}):
                break
            if attempt == 7:
                raise ValueError('Known-good baseline could not be verified')
            time.sleep(2)
        iam.put_role_policy(RoleName=n['appRole'], PolicyName='app-runtime', PolicyDocument=json.dumps(broken_app_policy))
        function = lam.update_function_code(FunctionName=n['function'], ZipFile=application_zip(broken_code), Publish=True)
        wait_function(lam, n['function'], item, token)
        lam.create_alias(FunctionName=n['function'], Name='live', FunctionVersion=function['Version'])
        variables = {'account_id': ACCOUNT, 'region': REGION, 'function_name': n['function'],
            'application_role_name': n['appRole'], 'data_bucket': n['bucket'], 'alarm_name': n['alarm'], 'release_version': function['Version']}
        files['candidate/terraform.tfvars.json'] = json.dumps(variables).encode()
        files['candidate/session.json'] = json.dumps({**variables, 'known_good_version': known_good}).encode()
        workspace = BytesIO()
        with tarfile.open(fileobj=workspace, mode='w:gz') as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo(name.removeprefix('candidate/'))
                entry.size, entry.mode = len(data), 0o644
                archive.addfile(entry, BytesIO(data))
        s3.put_object(Bucket=n['bucket'], Key='workspace/current.tar.gz', Body=workspace.getvalue())
        bootstrap_id = str(uuid.uuid4())
        update(item['id'], bootstrapId=bootstrap_id, knownGoodVersion=known_good)
        source_key = create_source(s3, item, bootstrap_id,
            'terraform init -input=false && terraform import aws_lambda_alias.live ' + n['function'] + '/live && '
            'terraform import aws_iam_role_policy.app_runtime ' + n['appRole'] + ':app-runtime')
        session.client('codebuild').create_project(name=n['project'],
            source={'type': 'S3', 'location': n['bucket'] + '/' + source_key}, artifacts={'type': 'NO_ARTIFACTS'},
            environment={'type': 'LINUX_CONTAINER', 'image': 'aws/codebuild/standard:7.0', 'computeType': 'BUILD_GENERAL1_SMALL', 'privilegedMode': False},
            serviceRole=f'arn:aws:iam::{ACCOUNT}:role/{n["jobRole"]}', timeoutInMinutes=5, queuedTimeoutInMinutes=5,
            concurrentBuildLimit=1, logsConfig={'cloudWatchLogs': {'status': 'ENABLED', 'groupName': n['logs']}})
        assert_work(item, token, 'starting')
        build = start_build(session, item, bootstrap_id, source_key)
        update(item['id'], bootstrapBuild=build)
    except Exception as error:
        LOG.error('Prepare failed: %s', getattr(error, 'response', {}).get('Error', {}).get('Code', type(error).__name__))
        close(lab_id, 'failed')


def wait_function(lam, function_name, item, token):
    for _ in range(20):
        assert_work(item, token, 'starting')
        configuration = lam.get_function_configuration(FunctionName=function_name)
        if configuration.get('State') == 'Failed' or configuration.get('LastUpdateStatus') == 'Failed':
            raise ValueError('Application function provisioning failed')
        if configuration.get('State') == 'Active' and configuration.get('LastUpdateStatus') != 'InProgress':
            return
        time.sleep(1)
    raise ValueError('Application function remained unavailable')


def create_source(s3, item, command_id, command):
    n = names(item)
    source = BytesIO()
    spec = {'version': '0.2', 'env': {'variables': {'LAB_BUCKET': n['bucket'], 'LAB_JOB_ID': command_id,
            'LAB_EXPIRES_AT': item['expiresAt']}},
            'phases': {'build': {'commands': ['python3 job.py']}}}
    with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('job.py', Path('job.py').read_bytes())
        archive.writestr('command.txt', command)
        archive.writestr('buildspec.yml', json.dumps(spec))
    key = 'source/' + command_id + '.zip'
    s3.put_object(Bucket=n['bucket'], Key=key, Body=source.getvalue())
    return key


def start_build(session, item, command_id, source_key):
    n = names(item)
    return session.client('codebuild').start_build(projectName=n['project'],
        sourceLocationOverride=n['bucket'] + '/' + source_key, idempotencyToken=command_id)['build']['id']


def accept_command(item, body):
    if not isinstance(body, dict):
        raise Failure(400, 'Invalid command')
    command_id, text = body.get('id', ''), body.get('command', '')
    if not isinstance(command_id, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', command_id) or not isinstance(text, str) or not text.strip() or len(text) > 8000 or '\0' in text:
        raise Failure(400, 'Invalid command')
    key = 'C#' + item['labId'] + '#' + command_id
    saved = get(key)
    if saved:
        if saved['command'] != text:
            raise Failure(409, 'Command ID has already been used')
        return saved
    if item['status'] != 'ready' or epoch(item['expiresAt']) <= time.time():
        raise Failure(409, 'Lab is not ready')
    record = {'id': key, 'commandId': command_id, 'labId': item['labId'], 'command': text,
              'status': 'queued', 'stdout': '', 'stderr': '', 'exitCode': None, 'truncated': False, 'createdAt': now()}
    try:
        transaction([
            {'ConditionCheck': {'TableName': TABLE.name, 'Key': {'id': 'POOL'},
                'ConditionExpression': 'leaseId = :id', 'ExpressionAttributeValues': {':id': item['labId']}}},
            {'Put': {'TableName': TABLE.name, 'Item': record, 'ConditionExpression': 'attribute_not_exists(id)'}},
            {'Update': {'TableName': TABLE.name, 'Key': {'id': item['id']},
                'UpdateExpression': 'SET activeCommand = :id ADD commandCount :one',
                'ConditionExpression': '#s = :ready AND expiresAt > :now AND attribute_not_exists(activeCommand) AND (attribute_not_exists(commandCount) OR commandCount < :max)',
                'ExpressionAttributeNames': {'#s': 'status'}, 'ExpressionAttributeValues': {
                    ':id': command_id, ':ready': 'ready', ':now': now(), ':one': 1, ':max': 100}}},
        ])
    except ClientError as error:
        if error.response['Error']['Code'] == 'TransactionCanceledException':
            previous = get(key)
            if previous:
                return accept_command(item, body)
            raise Failure(409, 'A command is already running or the lab is closed') from None
        raise
    invoke_worker('dispatch', labId=item['labId'], commandId=command_id)
    return record


def dispatch(lab_id, command_id):
    with worker_lock(lab_id, 'dispatch') as token:
        if token:
            _dispatch(lab_id, command_id, token)


def _dispatch(lab_id, command_id, token):
    item, record = lab(lab_id), get('C#' + lab_id + '#' + command_id)
    if not record or record['status'] not in ACTIVE or record.get('buildId'):
        return
    if item['status'] != 'ready' or epoch(item['expiresAt']) <= time.time():
        set_terminal_command(record['id'], status='failed', stderr='The lab closed before this job started.', finishedAt=now())
        return
    # CodeBuild's token deduplicates only a bounded window. Never redispatch an
    # ambiguous accepted request outside that window.
    if time.time() - epoch(record['createdAt']) > 240:
        set_terminal_command(record['id'], status='failed', stderr='Job acceptance could not be confirmed. The lab was stopped to preserve evidence.', finishedAt=now())
        close(lab_id, 'failed')
        return
    session = child()
    key = create_source(session.client('s3'), item, command_id, record['command'])
    assert_work(item, token, 'ready')
    build = start_build(session, item, command_id, key)
    update(record['id'], buildId=build, status='running', startedAt=now())


def finish_job(session, item, command_id, build_id):
    builds = session.client('codebuild').batch_get_builds(ids=[build_id])['builds']
    if not builds:
        return {'status': 'failed', 'stdout': '', 'stderr': 'The job record was unavailable. Contact the assessment organiser.',
                'exitCode': None, 'truncated': False, 'finishedAt': now()}
    build = builds[0]
    if build['buildStatus'] == 'IN_PROGRESS':
        return None
    result = {'stdout': '', 'stderr': 'The job stopped before it saved a result. Inspect cloud state before retrying.', 'exitCode': None, 'truncated': False}
    try:
        raw = session.client('s3').get_object(Bucket=names(item)['bucket'], Key='results/' + command_id + '.json')['Body'].read(150000)
        value = json.loads(raw)
        if isinstance(value, dict) and isinstance(value.get('stdout'), str) and isinstance(value.get('stderr'), str):
            result = {'stdout': value['stdout'][:LIMIT], 'stderr': value['stderr'][:LIMIT],
                      'exitCode': value.get('exitCode') if type(value.get('exitCode')) is int else None,
                      'truncated': bool(value.get('truncated')) or len(value['stdout']) > LIMIT or len(value['stderr']) > LIMIT}
    except (ClientError, ValueError):
        pass
    result['status'] = 'completed' if build['buildStatus'] == 'SUCCEEDED' and result['exitCode'] is not None else 'failed'
    result['finishedAt'] = now()
    return result


def refresh(item):
    if item.get('cleanupComplete'):
        return item
    if epoch(item['expiresAt']) <= time.time() and item['status'] not in FINAL:
        return close(item['labId'], 'expired')
    session = child()
    if item['status'] == 'starting' and item.get('bootstrapBuild'):
        result = finish_job(session, item, item['bootstrapId'], item['bootstrapBuild'])
        if result:
            if result['exitCode'] == 0 and result['status'] == 'completed':
                try:
                    TABLE.update_item(Key={'id': item['id']}, UpdateExpression='SET #s = :ready',
                        ConditionExpression='#s = :starting AND expiresAt > :now',
                        ExpressionAttributeNames={'#s': 'status'},
                        ExpressionAttributeValues={':ready': 'ready', ':starting': 'starting', ':now': now()})
                except ClientError as error:
                    if not conditional_failure(error):
                        raise
            else:
                LOG.error('Bootstrap job failed; recorded output is retained in the sandbox until cleanup')
                return close(item['labId'], 'failed')
    elif item['status'] == 'starting':
        if not item.get('preparingAt'):
            invoke_worker('prepare', labId=item['labId'])
        elif int(item.get('workerUntil', 0)) < time.time():
            return close(item['labId'], 'failed')
    if item.get('activeCommand'):
        command = get('C#' + item['labId'] + '#' + item['activeCommand'])
        if command and command.get('buildId') and command['status'] in ACTIVE:
            result = finish_job(session, item, command['commandId'], command['buildId'])
            if result:
                set_terminal_command(command['id'], **result)
                try:
                    TABLE.update_item(Key={'id': item['id']}, UpdateExpression='REMOVE activeCommand',
                        ConditionExpression='activeCommand = :id', ExpressionAttributeValues={':id': command['commandId']})
                except ClientError as error:
                    if not conditional_failure(error):
                        raise
        elif command and command['status'] in ACTIVE and item['status'] == 'ready':
            # Recover a lost asynchronous invocation, always reusing its durable
            # ID; dispatch quarantines ambiguous requests older than four minutes.
            invoke_worker('dispatch', labId=item['labId'], commandId=command['commandId'])
    if item['status'] in FINAL:
        invoke_worker('cleanup', labId=item['labId'])
    return lab(item['labId'])


def close(lab_id, state='stopped'):
    item = get('L#' + lab_id)
    if not item:
        item = {'id': 'L#' + lab_id, 'labId': lab_id, 'status': state, 'expiresAt': now(), 'tombstone': True, 'cleanupComplete': True}
        try:
            TABLE.put_item(Item=item, ConditionExpression='attribute_not_exists(id)')
            return item
        except ClientError as error:
            if conditional_failure(error):
                return close(lab_id, state)
            raise
    if item['status'] not in FINAL:
        try:
            TABLE.update_item(Key={'id': item['id']}, UpdateExpression='SET #s = :state',
                ConditionExpression='NOT (#s IN (:stopped, :expired, :failed))',
                ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={
                    ':state': state, ':stopped': 'stopped', ':expired': 'expired', ':failed': 'failed'})
        except ClientError as error:
            if not conditional_failure(error):
                raise
    if not item.get('cleanupComplete'):
        invoke_worker('cleanup', labId=lab_id)
    return lab(lab_id)


def ignore_absent(call, **kwargs):
    try:
        return call(**kwargs)
    except ClientError as error:
        if error.response['Error']['Code'] not in ('ResourceNotFoundException', 'NoSuchEntity', 'NoSuchBucket', 'NoSuchKey', '404'):
            raise
        return None


def cleanup(lab_id):
    with worker_lock(lab_id, 'cleanup') as token:
        if token:
            _cleanup(lab_id, token)


def _cleanup(lab_id, token):
    item = lab(lab_id)
    if item['status'] not in FINAL or item.get('cleanupComplete'):
        return
    pool = get('POOL')
    if not pool or pool.get('leaseId') != lab_id:
        raise ValueError('Cleanup lease ownership mismatch')
    session, n = child(), names(item)
    boundary(session)  # Deny copied job/application credentials before cleanup.
    cb, lam, iam, s3, logs, cw = [session.client(x) for x in ('codebuild', 'lambda', 'iam', 's3', 'logs', 'cloudwatch')]
    ids, next_token = [], None
    while True:
        builds = ignore_absent(cb.list_builds_for_project, projectName=n['project'], sortOrder='DESCENDING',
                              **({'nextToken': next_token} if next_token else {}))
        ids.extend((builds or {}).get('ids', []))
        next_token = (builds or {}).get('nextToken')
        if not next_token:
            break
    if ids:
        states = []
        for offset in range(0, len(ids), 100):
            states.extend(cb.batch_get_builds(ids=ids[offset:offset + 100])['builds'])
        running = [build for build in states if build['buildStatus'] == 'IN_PROGRESS']
        for build in running:
            cb.stop_build(id=build['id'])
        if running:
            return  # Next independent scheduled pass confirms all jobs stopped.
    command_id = item.get('activeCommand')
    if command_id:
        record = get('C#' + lab_id + '#' + command_id)
        if record and record['status'] in ACTIVE:
            result = finish_job(session, item, command_id, record['buildId']) if record.get('buildId') else None
            set_terminal_command(record['id'], **(result or {'status': 'failed', 'stderr': 'The lab closed before this job was accepted.', 'finishedAt': now()}))
    if not item.get('snapshot'):
        fn = ignore_absent(lam.get_function_configuration, FunctionName=n['function'])
        aliases = ignore_absent(lam.list_aliases, FunctionName=n['function'])
        policy = ignore_absent(iam.get_role_policy, RoleName=n['appRole'], PolicyName='app-runtime')
        alarms = cw.describe_alarms(AlarmNames=[n['alarm']])
        observed = {'function': {key: fn.get(key) for key in ('Runtime', 'MemorySize', 'Timeout', 'State', 'LastUpdateStatus', 'CodeSha256', 'Version')} if fn else None,
                    'aliases': [{'name': a['Name'], 'version': a['FunctionVersion']} for a in (aliases or {}).get('Aliases', [])],
                    'applicationPolicy': (policy or {}).get('PolicyDocument'),
                    'alarms': [{'name': a['AlarmName'], 'state': a['StateValue'], 'metric': a.get('MetricName'), 'namespace': a.get('Namespace'),
                                'threshold': a.get('Threshold')} for a in alarms.get('MetricAlarms', [])],
                    'recordingNote': 'Observed AWS state. Candidate job output and application logs require human interpretation.'}
        text = json.dumps(observed, default=str)
        update(item['id'], snapshot={'capturedAt': now(), 'content': text[:LIMIT], 'truncated': len(text) > LIMIT})
    ignore_absent(cb.delete_project, name=n['project'])
    ignore_absent(lam.delete_function, FunctionName=n['function'])
    cw.delete_alarms(AlarmNames=[n['alarm']])
    for name in (n['appRole'], n['jobRole']):
        policies_found = ignore_absent(iam.list_role_policies, RoleName=name)
        for policy in (policies_found or {}).get('PolicyNames', []):
            iam.delete_role_policy(RoleName=name, PolicyName=policy)
        ignore_absent(iam.delete_role, RoleName=name)
    listing = ignore_absent(s3.list_objects_v2, Bucket=n['bucket'])
    while listing and listing.get('Contents'):
        s3.delete_objects(Bucket=n['bucket'], Delete={'Objects': [{'Key': x['Key']} for x in listing['Contents']], 'Quiet': True})
        listing = s3.list_objects_v2(Bucket=n['bucket'])
    ignore_absent(s3.delete_bucket, Bucket=n['bucket'])
    for group in ('/aws/lambda/' + n['function'], n['logs']):
        ignore_absent(logs.delete_log_group, logGroupName=group)
    if ignore_absent(lam.get_function_configuration, FunctionName=n['function']) or cb.batch_get_projects(names=[n['project']])['projects']:
        raise ValueError('Runtime resources still present')
    for role in (n['appRole'], n['jobRole']):
        if ignore_absent(iam.get_role, RoleName=role):
            raise ValueError('A candidate role remains')
    if ignore_absent(s3.head_bucket, Bucket=n['bucket']) is not None:
        raise ValueError('Candidate storage remains')
    # Only confirmed removal releases the exclusive account. A failed pass leaves
    # the pool occupied; it is never silently recycled following a timeout.
    transaction([
        {'Update': {'TableName': TABLE.name, 'Key': {'id': item['id']}, 'UpdateExpression': 'SET cleanupComplete = :true, cleanedAt = :now',
                    'ConditionExpression': 'workerToken = :token AND #s IN (:stopped, :expired, :failed)',
                    'ExpressionAttributeNames': {'#s': 'status'},
                    'ExpressionAttributeValues': {':true': True, ':now': now(), ':token': token,
                        ':stopped': 'stopped', ':expired': 'expired', ':failed': 'failed'}}},
        {'Delete': {'TableName': TABLE.name, 'Key': {'id': 'POOL'}, 'ConditionExpression': 'leaseId = :id', 'ExpressionAttributeValues': {':id': lab_id}}},
    ])


def handler(event, context):
    try:
        if not isinstance(event, dict):
            raise Failure(400, 'Invalid lab request')
        enabled = os.environ.get('AWS_LABS_ENABLED', os.environ.get('LAB_ENABLED')) == 'true'
        if event.get('operation') == 'health':
            ready = False
            if enabled:
                get('POOL')  # Occupied capacity does not make an existing lab unhealthy.
                sandbox = child()
                ready = sandbox.client('sts').get_caller_identity()['Account'] == ACCOUNT
                boto3.client('s3').head_object(Bucket=os.environ['ARTIFACT_BUCKET'], Key=os.environ['ARTIFACT_KEY'])
            return {'statusCode': 200, 'body': {'provider': 'aws', 'templateId': TEMPLATE,
                    'enabled': enabled, 'ready': ready}}
        operation = event.get('operation')
        if operation in ('prepare', 'dispatch', 'cleanup'):
            if not isinstance(event.get('labId'), str) or not re.fullmatch(r'[a-z][a-z0-9]{19,34}', event['labId']):
                raise Failure(400, 'Invalid lab identifier')
            if operation == 'prepare':
                prepare(event['labId'])
            elif operation == 'dispatch':
                if not isinstance(event.get('commandId'), str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', event['commandId']):
                    raise Failure(400, 'Invalid command identifier')
                dispatch(event['labId'], event['commandId'])
            else:
                cleanup(event['labId'])
            return {'statusCode': 200, 'body': {'accepted': True}}
        if operation == 'reconcile':
            pool = get('POOL')
            if pool:
                item = refresh(lab(pool['leaseId']))
                if item['status'] in FINAL:
                    cleanup(item['labId'])
                elif item['status'] == 'starting' and time.time() - epoch(item['createdAt']) > 600:
                    close(item['labId'], 'failed')
            return {'statusCode': 200, 'body': {'checked': bool(pool)}}
        path = event.get('path', '')
        match = re.fullmatch(r'([a-z][a-z0-9]{19,34})(?:/commands(?:/([0-9a-f-]{36}))?)?', path) if isinstance(path, str) else None
        if not match:
            raise Failure(400, 'Invalid lab path')
        lab_id, command_id = match.groups()
        method, body = event.get('method', 'GET'), event.get('body', {})
        if method in ('PUT', 'POST') and not enabled:
            raise Failure(503, 'AWS labs are disabled')
        if method == 'DELETE' and '/commands' not in event['path']:
            result = session_result(close(lab_id))
        elif method == 'PUT' and '/commands' not in event['path']:
            result = session_result(acquire(lab_id, body))
        elif method == 'POST' and event['path'].endswith('/commands'):
            result = command_result(accept_command(lab(lab_id), body))
        elif method == 'GET' and (command_id or '/commands' not in path):
            item = refresh(lab(lab_id))
            if command_id:
                record = get('C#' + lab_id + '#' + command_id)
                if not record:
                    raise Failure(404, 'Job not found')
                result = command_result(record)
            else:
                result = session_result(item)
        else:
            raise Failure(400, 'Unsupported lab operation')
        return {'statusCode': 200, 'body': json_safe(result)}
    except Failure as error:
        return {'statusCode': error.code, 'body': {'error': error.message}}
    except Exception as error:
        LOG.error('Lab controller operation failed: %s', getattr(error, 'response', {}).get('Error', {}).get('Code', type(error).__name__))
        # Scheduled/async operations must fail visibly so Lambda retries and the
        # next scheduled sweep can recover. No credentials/errors are returned.
        if isinstance(event, dict) and event.get('operation'):
            raise RuntimeError('AWS lab background work requires retry') from None
        return {'statusCode': 503, 'body': {'error': 'AWS lab operation requires retry'}}
