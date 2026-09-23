import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const MANAGEMENT = '891612540396';
const SANDBOX = '689324611808';
const STACK = 'uniqassess-aws-lab-management';
const HELPER = 'uniqassess-aws-lab-account-bootstrap';
const base = fileURLToPath(new URL('.', import.meta.url));
const operation = process.argv[2];
if (!['deploy', 'status', 'protect-storage', 'helper-probe'].includes(operation) || process.argv.length !== 3) {
  throw new Error('Usage: node infra/aws-labs/deploy-control.mjs deploy|status|protect-storage|helper-probe');
}
async function aws(service, command, args = []) {
  const env = { ...process.env, AWS_PROFILE: 'default', AWS_DEFAULT_REGION: 'eu-west-1', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
  delete env.AWS_ACCESS_KEY_ID; delete env.AWS_SECRET_ACCESS_KEY; delete env.AWS_SESSION_TOKEN;
  try {
    const { stdout } = await run('aws', [service, command, ...args, '--region', 'eu-west-1', '--output', 'json', '--no-cli-pager'],
      { env, windowsHide: true, timeout: 90_000, maxBuffer: 3 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    const text = String(error.stderr ?? '');
    const safe = new Error(`${service}.${command}: ${/\(([^)]+)\) when calling/.exec(text)?.[1] ?? 'AwsCliFailure'}`);
    safe.missingStack = text.includes('does not exist');
    safe.noUpdates = text.includes('No updates are to be performed');
    throw safe;
  }
}
const identity = await aws('sts', 'get-caller-identity');
if (identity.Account !== MANAGEMENT) throw new Error('Unexpected management account.');
const evidence = JSON.parse(await readFile(join(base, 'account-provisioning-evidence.json'), 'utf8'));
if (!evidence.assumeRoleVerified || evidence.sandboxAccountId !== SANDBOX) throw new Error('Sandbox preflight is not verified.');
async function helper(payload) {
  const directory = await mkdtemp(join(tmpdir(), 'uniqassess-control-deploy-'));
  try {
    const responsePath = join(directory, 'response.json');
    const invocation = await aws('lambda', 'invoke', ['--function-name', HELPER, '--cli-binary-format', 'raw-in-base64-out',
      '--payload', JSON.stringify(payload), responsePath]);
    const response = JSON.parse(await readFile(responsePath, 'utf8'));
    if (invocation.FunctionError) throw new Error(`Child bootstrap failed: ${response.errorType}: ${response.errorMessage}`);
    if (response.accountId !== SANDBOX) throw new Error('Bootstrap response account mismatch.');
    return response;
  } finally {
    if (!directory.startsWith(join(tmpdir(), 'uniqassess-control-deploy-'))) throw new Error('Unexpected temporary directory.');
    await rm(directory, { recursive: true, force: true });
  }
}
async function managementStatus() {
  const stack = (await aws('cloudformation', 'describe-stacks', ['--stack-name', STACK])).Stacks[0];
  return { accountId: MANAGEMENT, stackName: STACK, status: stack.StackStatus, outputs: stack.Outputs ?? [], parameters: stack.Parameters ?? [] };
}
if (operation === 'helper-probe') console.log(JSON.stringify(await helper({ operation: 'probe' }), null, 2));
if (operation === 'protect-storage') console.log(JSON.stringify(await helper({ operation: 'protect-storage' }), null, 2));
if (operation === 'status') {
  console.log(JSON.stringify({ management: await managementStatus(), sandbox: await helper({ operation: 'stack-status' }) }, null, 2));
}
if (operation === 'deploy') {
  const managementPath = join(base, 'management.cloudformation.json');
  const sandbox = JSON.parse(await readFile(join(base, 'sandbox.cloudformation.json'), 'utf8'));
  await aws('cloudformation', 'validate-template', ['--template-body', `file://${managementPath}`]);
  await aws('cloudformation', 'validate-template', ['--template-body', `file://${join(base, 'sandbox.cloudformation.json')}`]);
  let create = false;
  let current;
  try { current = await managementStatus(); } catch (error) { if (!error.missingStack) throw error; create = true; }
  try {
    const parameters = (current?.parameters ?? []).map((parameter) => ({ ParameterKey: parameter.ParameterKey, UsePreviousValue: true }));
    const result = await aws('cloudformation', create ? 'create-stack' : 'update-stack', ['--stack-name', STACK,
      '--template-body', `file://${managementPath}`, '--capabilities', 'CAPABILITY_NAMED_IAM',
      ...(parameters.length ? ['--parameters', JSON.stringify(parameters)] : [])]);
    console.log(JSON.stringify({ managementStackId: result.StackId }));
  } catch (error) { if (!error.noUpdates) throw error; }
  let status;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    status = await managementStatus();
    if (['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(status.status)) break;
    if (/FAILED|ROLLBACK/.test(status.status)) throw new Error(`Management stack failed: ${status.status}`);
    if (attempt % 3 === 0) console.log(JSON.stringify({ managementStatus: status.status }));
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(status?.status)) throw new Error('Management stack still pending; use status before retry.');
  console.log(JSON.stringify({ management: status }));
  console.log(JSON.stringify(await helper({ operation: 'deploy', template: sandbox })));
  let child;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    child = await helper({ operation: 'stack-status' });
    if (['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(child.status)) break;
    if (/FAILED|ROLLBACK/.test(child.status)) throw new Error(`Sandbox stack failed: ${JSON.stringify(child)}`);
    if (attempt % 3 === 0) console.log(JSON.stringify({ sandboxStatus: child.status }));
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(child?.status)) throw new Error('Sandbox stack still pending; use status before retry.');
  const publicAccess = await helper({ operation: 'protect-storage' });
  const parameterValues = Object.fromEntries((status.parameters ?? []).map((parameter) => [parameter.ParameterKey, parameter.ParameterValue]));
  const receipt = { checkedAt: new Date().toISOString(), management: status, sandbox: child,
    sandboxPublicAccessBlock: publicAccess.publicAccessBlock, runtimeInstalled: Boolean(parameterValues.RuntimeS3Key),
    candidateAccessEnabled: parameterValues.CandidateAccessEnabled === 'true',
    reconcileScheduleEnabled: parameterValues.ReconcileEnabled === 'true', bootstrapHelperCleanupPending: true };
  await writeFile(join(base, 'control-deployment-evidence.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}
