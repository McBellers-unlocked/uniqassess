/** Installs a reviewed package. No candidate account or app credentials are returned. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const account = '891612540396';
const region = 'eu-west-1';
const stackName = 'uniqassess-aws-lab-management';
const operation = process.argv[2] ?? 'status';
if (!['install', 'status'].includes(operation)) throw new Error('Use install or status.');
function aws(args) {
  try { const result = execFileSync('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  }); return result.trim() ? JSON.parse(result) : {}; }
  catch { throw new Error('AWS runtime deployment operation failed; inspect stack events.'); }
}
if (aws(['sts', 'get-caller-identity']).Account !== account) throw new Error('Unexpected management account.');
let stack = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName]).Stacks[0];
if (operation === 'install') {
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw new Error('Finish the current stack operation before installing runtime.');
  const artifact = JSON.parse(readFileSync('build/aws-lab/artifacts.json', 'utf8'));
  const bucket = 'uniqassess-aws-lab-artifacts-' + account;
  const runtimeKey = 'runtime/' + artifact.runtimeSha256 + '.zip';
  aws(['s3api', 'put-object', '--bucket', bucket, '--key', runtimeKey, '--body', artifact.runtimePath, '--server-side-encryption', 'AES256']);
  aws(['s3api', 'put-object', '--bucket', bucket, '--key', 'aws-service-release-v1/source.zip', '--body', artifact.fixturePath, '--server-side-encryption', 'AES256']);
  const parameters = [{ ParameterKey: 'RuntimeS3Key', ParameterValue: runtimeKey },
    { ParameterKey: 'CandidateAccessEnabled', ParameterValue: 'true' }, { ParameterKey: 'ReconcileEnabled', ParameterValue: 'true' }];
  const result = aws(['cloudformation', 'update-stack', '--stack-name', stackName,
    '--template-body', 'file://infra/aws-labs/management.cloudformation.json', '--capabilities', 'CAPABILITY_NAMED_IAM', '--parameters', JSON.stringify(parameters)]);
  console.log(JSON.stringify({ updateStarted: true, stackId: result.StackId, runtimeSha256: artifact.runtimeSha256, fixtureSha256: artifact.fixtureSha256 }));
  writeFileSync('build/aws-lab/deployment.json', JSON.stringify({ ...artifact, runtimeKey, checkedAt: new Date().toISOString() }, null, 2));
} else {
  const functionState = aws(['lambda', 'get-function-configuration', '--function-name', 'uniqassess-aws-lab-runner']);
  const schedule = aws(['events', 'describe-rule', '--name', 'uniqassess-aws-lab-reconcile']);
  console.log(JSON.stringify({ stackStatus: stack.StackStatus, functionState: functionState.State, lastUpdate: functionState.LastUpdateStatus,
    handler: functionState.Handler, runnerEnabled: functionState.Environment?.Variables?.AWS_LABS_ENABLED, schedule: schedule.State }));
}
