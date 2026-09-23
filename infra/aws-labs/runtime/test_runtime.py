"""Offline runtime checks. boto3 uses dummy credentials; no cloud calls are made."""
import copy
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from io import BytesIO
import importlib.util
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

os.environ.update(AWS_DEFAULT_REGION='eu-west-1', AWS_ACCESS_KEY_ID='unit-test',
                  AWS_SECRET_ACCESS_KEY='unit-test', AWS_EC2_METADATA_DISABLED='true',
                  SANDBOX_ACCOUNT='689324611808', SANDBOX_ROLE_ARN='arn:aws:iam::689324611808:role/unit-test',
                  TABLE_NAME='unit-test', LAB_BUCKET='unit-test', LAB_JOB_ID='unit-test')

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parent
def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

h = module('lab_handler', 'handler.py')
j = module('lab_job', 'job.py')
LAB = 'c123456789012345678901234'
CMD = 'c8fe1f69-69df-40de-97ed-5ef566f15541'

def stamp(seconds=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def session(status='ready'):
    return {'id': 'L#' + LAB, 'labId': LAB, 'templateId': h.TEMPLATE, 'status': status,
            'expiresAt': stamp(3600), 'createdAt': stamp(-10), 'cleanupComplete': False}

def conditional(code='ConditionalCheckFailedException'):
    return ClientError({'Error': {'Code': code, 'Message': 'unit test condition'}}, 'test')

class MemoryTable:
    """Small conditional store used to force lifecycle interleavings."""
    name = 'unit-test'
    def __init__(self, item=None):
        self.rows = {'POOL': {'id': 'POOL', 'leaseId': LAB}}
        if item:
            self.rows[item['id']] = copy.deepcopy(item)
        self.meta = Mock()
        self.meta.client.transact_write_items.side_effect = self.transact

    def get_item(self, Key, **_):
        value = self.rows.get(Key['id'])
        return {'Item': copy.deepcopy(value)} if value else {}

    def check(self, row, condition, values):
        if not condition:
            return
        passed = True
        if condition == 'attribute_not_exists(id)':
            passed = row is None
        elif condition == 'attribute_not_exists(leaseId)':
            passed = not row or 'leaseId' not in row
        elif condition == 'leaseId = :id':
            passed = bool(row) and row.get('leaseId') == values[':id']
        elif 'workerUntil < :now' in condition:
            passed = bool(row) and ('workerToken' not in row or row['workerUntil'] < values[':now'])
        elif condition == 'workerToken = :token':
            passed = bool(row) and row.get('workerToken') == values[':token']
        elif condition.startswith('NOT (#s IN'):
            passed = bool(row) and row.get('status') not in h.FINAL
        elif condition.startswith('#s = :starting'):
            passed = bool(row) and row.get('status') == 'starting' and row['expiresAt'] > values[':now']
        elif condition.startswith('#status IN'):
            passed = bool(row) and row.get('status') in h.ACTIVE
        elif condition == 'activeCommand = :id':
            passed = bool(row) and row.get('activeCommand') == values[':id']
        elif condition.startswith('attribute_not_exists(preparingAt)'):
            passed = bool(row) and row.get('status') == 'starting' and 'preparingAt' not in row
        elif condition.startswith('#s = :ready'):
            passed = bool(row) and row.get('status') == 'ready' and row['expiresAt'] > values[':now'] and 'activeCommand' not in row and row.get('commandCount', 0) < 100
        elif condition.startswith('workerToken = :token AND'):
            passed = bool(row) and row.get('workerToken') == values[':token'] and row['status'] in h.FINAL
        else:
            raise AssertionError('Unhandled test condition: ' + condition)
        if not passed:
            raise conditional()

    def put_item(self, Item, ConditionExpression=None, **_):
        self.check(self.rows.get(Item['id']), ConditionExpression, {})
        self.rows[Item['id']] = copy.deepcopy(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues=None, ExpressionAttributeNames=None, ConditionExpression=None, **_):
        values, names = ExpressionAttributeValues or {}, ExpressionAttributeNames or {}
        self.check(self.rows.get(Key['id']), ConditionExpression, values)
        row = self.rows.setdefault(Key['id'], dict(Key))
        if UpdateExpression.startswith('REMOVE '):
            for name in UpdateExpression[7:].split(', '):
                row.pop(names.get(name, name), None)
        else:
            fields, _, addition = UpdateExpression[4:].partition(' ADD ')
            for field in fields.split(', '):
                name, value = field.split(' = ')
                row[names.get(name, name)] = copy.deepcopy(values[value])
            if addition:
                name, value = addition.split(' ')
                row[name] = row.get(name, 0) + values[value]

    def transact(self, TransactItems):
        before = copy.deepcopy(self.rows)
        try:
            for entry in TransactItems:
                operation, args = next(iter(entry.items()))
                args = {k: v for k, v in args.items() if k != 'TableName'}
                if operation == 'Put':
                    self.put_item(**args)
                elif operation == 'Update':
                    self.update_item(**args)
                else:
                    self.check(self.rows.get(args['Key']['id']), args.get('ConditionExpression'), args.get('ExpressionAttributeValues', {}))
                    if operation == 'Delete':
                        self.rows.pop(args['Key']['id'], None)
        except ClientError:
            self.rows = before
            raise conditional('TransactionCanceledException')

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.table = MemoryTable(session())
        self.table_patch = patch.object(h, 'TABLE', self.table)
        self.table_patch.start()
        self.invokes = patch.object(h, 'invoke_worker', Mock()).start()
        self.addCleanup(patch.stopall)

    def test_native_resource_transaction_serialization(self):
        table = boto3.resource('dynamodb', region_name='eu-west-1').Table('unit-test')
        observed = []
        class Intercept(Exception): pass
        def capture(params, **_):
            observed.append(json.loads(params['body']))
            raise Intercept()
        table.meta.client.meta.events.register('before-call.dynamodb.TransactWriteItems', capture)
        with patch.object(h, 'TABLE', table), self.assertRaises(Intercept):
            h.transaction([{'Put': {'TableName': table.name, 'Item': {'id': 'test', 'count': 1, 'exitCode': None}}}])
        self.assertEqual(observed[0]['TransactItems'][0]['Put']['Item'], {'id': {'S': 'test'}, 'count': {'N': '1'}, 'exitCode': {'NULL': True}})

    def test_decimal_exit_code_is_json_serializable(self):
        result = h.command_result({'id': 'private-storage-key', 'commandId': CMD, 'status': 'completed', 'exitCode': Decimal(7)})
        self.assertEqual(json.loads(json.dumps(result)), {'id': CMD, 'status': 'completed', 'exitCode': 7})

    def test_cleanup_waits_for_prepare_and_old_cleanup_cannot_touch_next_lease(self):
        self.table.rows['L#' + LAB]['status'] = 'starting'
        with patch.object(h, '_cleanup') as clean:
            with h.worker_lock(LAB, 'prepare') as token:
                self.assertIsNotNone(token)
                h.close(LAB)
                h.cleanup(LAB)
                clean.assert_not_called()
                self.assertEqual(self.table.rows['POOL']['leaseId'], LAB)
            h.cleanup(LAB)
            self.assertEqual(clean.call_count, 1)
            self.table.rows['POOL']['leaseId'] = 'another-lease'
            h.cleanup(LAB)
            self.assertEqual(clean.call_count, 1)

    def test_refresh_cannot_resurrect_a_closed_bootstrap(self):
        item = self.table.rows['L#' + LAB]
        item.update(status='starting', bootstrapId=CMD, bootstrapBuild='build')
        def finish(*_):
            h.close(LAB)
            return {'exitCode': 0, 'status': 'completed'}
        with patch.object(h, 'child', Mock()), patch.object(h, 'finish_job', side_effect=finish):
            self.assertEqual(h.refresh(copy.deepcopy(item))['status'], 'stopped')

    def test_dispatch_is_at_most_once_and_checks_close_before_start(self):
        record = {'id': 'C#' + LAB + '#' + CMD, 'commandId': CMD, 'labId': LAB,
                  'status': 'queued', 'command': 'echo test', 'createdAt': stamp()}
        self.table.rows[record['id']] = record
        with patch.object(h, 'child', Mock()), patch.object(h, 'create_source', return_value='source'), patch.object(h, 'start_build', return_value='build') as start:
            h.dispatch(LAB, CMD)
            h.dispatch(LAB, CMD)
            self.assertEqual(start.call_count, 1)
        record.pop('buildId')
        record['status'] = 'queued'
        with patch.object(h, 'child', Mock()), patch.object(h, 'create_source', side_effect=lambda *_: h.close(LAB)), patch.object(h, 'start_build') as start:
            with self.assertRaises(h.Failure): h.dispatch(LAB, CMD)
            start.assert_not_called()

    def test_ambiguous_old_dispatch_stops_instead_of_replaying(self):
        record = {'id': 'C#' + LAB + '#' + CMD, 'commandId': CMD, 'labId': LAB,
                  'status': 'queued', 'command': 'echo test', 'createdAt': stamp(-241)}
        self.table.rows[record['id']] = record
        with patch.object(h, 'child') as child:
            h.dispatch(LAB, CMD)
            child.assert_not_called()
        self.assertEqual(self.table.rows[record['id']]['status'], 'failed')
        self.assertEqual(self.table.rows['L#' + LAB]['status'], 'failed')

    def test_delete_before_create_stays_closed_and_command_identity_is_immutable(self):
        self.table.rows.pop('L#' + LAB)
        h.close(LAB)
        with self.assertRaises(h.Failure) as failure:
            h.acquire(LAB, {'templateId': h.TEMPLATE, 'expiresAt': stamp(3600)})
        self.assertEqual(failure.exception.code, 409)
        self.table.rows['L#' + LAB] = session()
        record = h.accept_command(session(), {'id': CMD, 'command': 'echo first'})
        self.assertEqual(h.accept_command(session(), {'id': CMD, 'command': 'echo first'}), record)
        with self.assertRaises(h.Failure): h.accept_command(session(), {'id': CMD, 'command': 'echo changed'})

    def test_terminal_command_evidence_is_append_only(self):
        key = 'C#' + LAB + '#' + CMD
        self.table.rows[key] = {'id': key, 'status': 'completed', 'stdout': 'original'}
        h.set_terminal_command(key, status='failed', stdout='late')
        self.assertEqual(self.table.rows[key]['stdout'], 'original')

    def test_dynamic_boundary_scopes_principals_expiry_old_tokens_and_no_alarm_actions(self):
        iam, sandbox = Mock(), Mock()
        sandbox.client.return_value = iam
        iam.list_policy_versions.return_value = {'Versions': []}
        item = session()
        h.boundary(sandbox, item['expiresAt'], item['createdAt'], item)
        document = iam.create_policy_version.call_args.kwargs['PolicyDocument']
        self.assertLessEqual(len(document), 6144)
        policy = json.loads(document)
        denies = {s.get('Sid'): s for s in policy['Statement'] if s['Effect'] == 'Deny'}
        self.assertIn('ExpiredLease', denies)
        self.assertIn('PreviousLeaseCredentials', denies)
        self.assertIn('RequireTemporaryLeaseCredentials', denies)
        self.assertIn('NoAlarmActions', denies)
        app = [s for s in policy['Statement'] if s['Effect'] == 'Allow' and s['Condition']['ArnEquals']['aws:PrincipalArn'].endswith('-app')]
        self.assertEqual({a for s in app for a in s['Action']}, {'s3:GetObject', 's3:ListBucket', 'logs:CreateLogStream', 'logs:PutLogEvents'})
        self.assertNotRegex(json.dumps(app), r'/source/|/workspace/|/results/')
        for s in app:
            if 's3:ListBucket' in s['Action']:
                self.assertEqual(s['Condition']['StringLike']['s3:prefix'], 'orders/*')
        h.boundary(sandbox)
        self.assertEqual(json.loads(iam.create_policy_version.call_args.kwargs['PolicyDocument'])['Statement'], [{'Effect': 'Deny', 'Action': '*', 'Resource': '*'}])

    def test_longest_lab_name_still_has_a_valid_bucket_and_bounded_policy(self):
        item = session()
        item['labId'] = 'c' + '1' * 34
        self.assertLessEqual(len(h.names(item)['bucket']), 63)
        iam, sandbox = Mock(), Mock()
        sandbox.client.return_value = iam
        iam.list_policy_versions.return_value = {'Versions': []}
        h.boundary(sandbox, item['expiresAt'], item['createdAt'], item)
        self.assertLessEqual(len(iam.create_policy_version.call_args.kwargs['PolicyDocument']), 6144)
        self.assertEqual(h.handler({'path': 'c' + '1' * 39, 'method': 'GET'}, None)['statusCode'], 400)

    def test_health_checks_storage_and_actual_sandbox_identity_even_when_busy(self):
        sandbox = Mock()
        sandbox.client.return_value.get_caller_identity.return_value = {'Account': h.ACCOUNT}
        with patch.dict(os.environ, {'AWS_LABS_ENABLED': 'true', 'ARTIFACT_BUCKET': 'fixture', 'ARTIFACT_KEY': 'source.zip'}), patch.object(h, 'child', return_value=sandbox), patch.object(h.boto3, 'client', Mock()):
            self.assertTrue(h.handler({'operation': 'health'}, None)['body']['ready'])
            sandbox.client.return_value.get_caller_identity.return_value = {'Account': 'wrong-account'}
            self.assertFalse(h.handler({'operation': 'health'}, None)['body']['ready'])

    def test_workspace_extraction_rejects_paths_and_symlinks(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)]:
            with tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / 'workspace.tar.gz'
                with tarfile.open(archive, 'w:gz') as output:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    entry.linkname = '../outside'
                    output.addfile(entry, BytesIO())
                with self.assertRaises(ValueError): j.safe_extract(archive, Path(directory) / 'target')


if __name__ == '__main__':
    unittest.main()
