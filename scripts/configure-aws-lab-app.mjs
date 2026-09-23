/** Connect the fixed AWS lab controller to application and reconciliation compute. */
import { execFileSync } from 'node:child_process';
const account = '891612540396';
const region = 'eu-west-1';
const functionArn = `arn:aws:lambda:${region}:${account}:function:uniqassess-aws-lab-runner`;
function aws(args) {
  try { const out = execFileSync('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  }); return out.trim() ? JSON.parse(out) : {}; }
  catch (error) {
    const code = /\(([^)]+)\) when calling/.exec(String(error.stderr ?? ''))?.[1] ?? 'AwsCliFailure';
    throw new Error(`${args[0]}.${args[1]} failed (${code}); no environment values were logged.`);
  }
}
if (process.argv.length !== 3 || !['enable', 'disable'].includes(process.argv[2])) throw new Error('Use enable or disable.');
if (aws(['sts', 'get-caller-identity']).Account !== account) throw new Error('Unexpected AWS account.');
const enabled = process.argv[2] === 'enable';
const controller = aws(['lambda', 'get-function-configuration', '--function-name', 'uniqassess-aws-lab-runner']);
if (controller.FunctionArn !== functionArn || controller.State !== 'Active') throw new Error('AWS controller is not active.');
const policy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: functionArn }] };
const appRole = 'meritia-amplify-ssr-compute-role';
if (aws(['iam', 'get-role', '--role-name', appRole]).Role.Arn !== `arn:aws:iam::${account}:role/${appRole}`) throw new Error('Unexpected app compute role.');
aws(['iam', 'put-role-policy', '--role-name', appRole, '--policy-name', 'InvokeDedicatedAwsAssessmentLab', '--policy-document', JSON.stringify(policy)]);
const reconcile = aws(['lambda', 'get-function-configuration', '--function-name', 'uniqassess-lab-reconcile-pilot']);
const reconcileRole = reconcile.Role?.split('/').at(-1);
if (!reconcile.Role?.startsWith(`arn:aws:iam::${account}:role/uniqassess-lab-reconciliation-`) || !reconcileRole) throw new Error('Unexpected reconciliation role.');
aws(['iam', 'put-role-policy', '--role-name', reconcileRole, '--policy-name', 'InvokeDedicatedAwsAssessmentLab', '--policy-document', JSON.stringify(policy)]);
aws(['lambda', 'update-function-configuration', '--function-name', 'uniqassess-lab-reconcile-pilot', '--environment', JSON.stringify({
  Variables: { ...reconcile.Environment.Variables, AWS_LAB_RUNNER_FUNCTION_ARN: functionArn, AWS_LABS_ENABLED: 'false' },
})]);
const branch = aws(['amplify', 'get-branch', '--app-id', 'd1wxabrgr6nkub', '--branch-name', 'main']).branch;
aws(['amplify', 'update-branch', '--app-id', 'd1wxabrgr6nkub', '--branch-name', 'main', '--environment-variables', JSON.stringify({
  ...branch.environmentVariables, UNIQASSESS_AWS_LABS_ENABLED: String(enabled), UNIQASSESS_AWS_LAB_RUNNER_FUNCTION_ARN: functionArn,
})]);
console.log(JSON.stringify({ candidateFlag: enabled, functionArn, appInvokePermission: true, cleanupInvokePermission: true,
  reconciliationCandidateOperations: false, applicationRebuildRequired: true }));
