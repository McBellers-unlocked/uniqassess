/** Operator-side cleanup for only the reviewed pilot. Default mode is read-only. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = path.join(root, '.deployment/bootstrap-cleanup-state.json');
const account = '891612540396', region = 'eu-west-1';
const stack = 'uniqassess-kubernetes-pilot';
const control = 'i-09fa493b2b45c84af', worker = 'i-0771b03a4cdc72d2c';
const role = 'uniqassess-kubernetes-pilot-ControlRole-3tiQo5GwADk9';
const bootstrapArn = `arn:aws:secretsmanager:${region}:${account}:secret:uniqassess/labs/pilot/bootstrap-C5hrdx`;
const runnerArn = `arn:aws:secretsmanager:${region}:${account}:secret:uniqassess/labs/pilot/runner-E7D6ZY`;
const mode = process.argv[2] || '--inspect';
const execute = mode === '--execute-after-acceptance';
const requireCheck = (value, reason) => { if (!value) throw new Error(reason); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function aws(service, action, input = {}, allowMissing = false) {
  try {
    // This script never calls GetSecretValue. Arguments contain only resource
    // identifiers and the nonsecret host cleanup source, never credentials.
    return JSON.parse(execFileSync('aws', [service, action, '--cli-input-json', JSON.stringify(input),
      '--region', region, '--output', 'json', '--no-cli-pager'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000, maxBuffer: 1024 * 1024,
      env: { ...process.env, AWS_PAGER: '', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }) || '{}');
  } catch (error) {
    if (allowMissing && /NoSuchEntity|ResourceNotFoundException|InvocationDoesNotExist/.test(String(error.stderr))) return null;
    throw new Error(`${service} ${action} failed; raw output suppressed.`);
  }
}

function policy(name, optional = false) {
  return aws('iam', 'get-role-policy', { RoleName: role, PolicyName: name }, optional)?.PolicyDocument;
}

function save(state) {
  mkdirSync(path.dirname(evidence), { recursive: true });
  writeFileSync(evidence, JSON.stringify(state, null, 2) + '\n');
}

async function main() {
  requireCheck(['--inspect', '--execute-after-acceptance'].includes(mode), 'Use --inspect or --execute-after-acceptance.');
  requireCheck(aws('sts', 'get-caller-identity').Account === account, 'Unexpected AWS account.');
  const description = aws('cloudformation', 'describe-stacks', { StackName: stack }).Stacks[0];
  requireCheck(['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(description.StackStatus), 'Pilot stack must be stable.');
  const outputs = Object.fromEntries(description.Outputs.map(item => [item.OutputKey, item.OutputValue]));
  requireCheck(outputs.ControlInstanceId === control && outputs.WorkerInstanceId === worker &&
    outputs.ControlRoleName === role && outputs.WorkerPrivateIp === '10.88.0.20', 'Pilot identity changed; re-review cleanup targets.');
  const node = aws('ec2', 'describe-instances', { InstanceIds: [worker] }).Reservations[0].Instances[0];
  requireCheck(!node.IamInstanceProfile && node.MetadataOptions.HttpEndpoint === 'disabled' &&
    node.MetadataOptions.State === 'applied', 'Worker must have disabled metadata and no IAM profile.');
  const management = policy('PilotManagementOnly');
  requireCheck(management, 'Required management policy absent.');
  const runnerBefore = aws('secretsmanager', 'describe-secret', { SecretId: runnerArn });
  requireCheck(runnerBefore.ARN === runnerArn && !runnerBefore.DeletedDate, 'Runner Secret must remain active.');
  const bootstrapBefore = aws('secretsmanager', 'describe-secret', { SecretId: bootstrapArn });
  requireCheck(bootstrapBefore.ARN === bootstrapArn && bootstrapBefore.Name === 'uniqassess/labs/pilot/bootstrap', 'Unexpected bootstrap secret.');
  const state = execute && existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) : {};
  requireCheck(!state.control || state.control === control, 'Cleanup state references a different control.');
  Object.assign(state, { control, worker, role, mode, managementPolicyHash: hash(management) });
  const source = readFileSync(path.join(root, 'infra/kubernetes-labs/cleanup-bootstrap-host.py'), 'utf8');
  const sourceHash = hash(source);
  if (!execute || !state.hostCommandId) {
    const code = `import base64;exec(compile(base64.b64decode('${Buffer.from(source).toString('base64')}'),'cleanup-bootstrap-host.py','exec'))`;
    // Base64 source and fixed mode contain no shell metacharacters requiring
    // expansion. Single quotes safely contain the Python -c expression.
    const command = `python3 -c '${code.replaceAll("'", "'\\''")}' ${mode}`;
    const response = aws('ssm', 'send-command', { InstanceIds: [control], DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: [command], executionTimeout: ['180'] }, TimeoutSeconds: 60,
      Comment: execute ? 'UNIQassess approved post-acceptance bootstrap cleanup' : 'UNIQassess read-only bootstrap cleanup inspection' });
    state.hostCommandId = response.Command.CommandId;
    state.hostSourceHash = sourceHash;
    if (execute) save(state);
  } else requireCheck(state.hostSourceHash === sourceHash, 'Cleanup source changed since command dispatch; inspect the existing command before retrying.');
  console.log(JSON.stringify({ phase: 'host', mode, commandId: state.hostCommandId }));
  let invocation;
  for (let attempt = 0; attempt < 90; attempt++) {
    invocation = aws('ssm', 'get-command-invocation', { CommandId: state.hostCommandId, InstanceId: control }, true);
    if (invocation && !['Pending', 'InProgress', 'Delayed'].includes(invocation.Status)) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  requireCheck(invocation?.Status === 'Success' && invocation.ResponseCode === 0,
    'Host cleanup did not finish successfully. Inspect sanitized SSM output for the printed command ID; cloud access was not changed.');
  state.hostResult = JSON.parse(invocation.StandardOutputContent.trim());
  requireCheck(state.hostResult.mode === mode && state.hostResult.runnerSecretPreserved && state.hostResult.nodesReady,
    'Unexpected host cleanup result.');
  console.log(JSON.stringify({ phase: 'host-complete', result: state.hostResult }));
  if (!execute) {
    console.log(JSON.stringify({ mode, bootstrapPolicyPresent: !!policy('LabBootstrapOnly', true),
      managementPolicyPresent: true, runnerSecretActive: true, bootstrapSecretDeletionScheduled: !!bootstrapBefore.DeletedDate,
      mutationsPerformed: false }));
    return;
  }
  requireCheck(!state.hostResult.privateKeyPresent && state.hostResult.worker.removed,
    'Worker SSH/private-key cleanup incomplete; cloud access retained.');
  state.hostComplete = true; save(state);
  if (policy('LabBootstrapOnly', true)) aws('iam', 'delete-role-policy', { RoleName: role, PolicyName: 'LabBootstrapOnly' });
  requireCheck(!policy('LabBootstrapOnly', true), 'Temporary policy removal did not persist.');
  requireCheck(hash(policy('PilotManagementOnly')) === state.managementPolicyHash, 'Management policy changed unexpectedly.');
  state.bootstrapPolicyRemoved = true; save(state);
  if (!bootstrapBefore.DeletedDate) {
    const deleted = aws('secretsmanager', 'delete-secret', { SecretId: bootstrapArn, RecoveryWindowInDays: 7 });
    requireCheck(deleted.ARN === bootstrapArn && deleted.DeletionDate, 'Unexpected secret deletion response.');
    state.bootstrapSecretRecoveryWindowInDays = 7;
    state.bootstrapSecretDeleteResponseDeletionDate = deleted.DeletionDate;
    save(state);
  }
  const bootstrapAfter = aws('secretsmanager', 'describe-secret', { SecretId: bootstrapArn });
  const runnerAfter = aws('secretsmanager', 'describe-secret', { SecretId: runnerArn });
  requireCheck(bootstrapAfter.DeletedDate, 'Bootstrap secret deletion was not scheduled.');
  requireCheck(runnerAfter.ARN === runnerArn && !runnerAfter.DeletedDate &&
    hash(runnerBefore.VersionIdsToStages) === hash(runnerAfter.VersionIdsToStages), 'Runner Secret changed during cleanup; inspect metadata.');
  state.bootstrapSecretDescribeDeletedDate = bootstrapAfter.DeletedDate;
  state.runnerSecretPreserved = true;
  state.managementPolicyPreserved = true;
  state.completedAt = new Date().toISOString(); save(state);
  console.log(JSON.stringify({ completed: true, bootstrapPolicyRemoved: true, bootstrapSecretDescribeDeletedDate: bootstrapAfter.DeletedDate,
    runnerSecretPreserved: true, managementPolicyPreserved: true, keyPairRegistrationPreserved: true, evidence }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
