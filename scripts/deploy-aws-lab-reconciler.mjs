import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const region = 'eu-west-1';
function aws(args) {
  try { const out = execFileSync('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  }); return out.trim() ? JSON.parse(out) : {}; }
  catch (error) { throw new Error(`${args[0]}.${args[1]} failed (${ /\(([^)]+)\) when calling/.exec(String(error.stderr ?? ''))?.[1] ?? 'AwsCliFailure'}).`); }
}
if (aws(['sts', 'get-caller-identity']).Account !== '891612540396') throw new Error('Unexpected AWS account.');
const artifact = JSON.parse(readFileSync('build/lab-reconciler-artifact.json', 'utf8'));
const sha = createHash('sha256').update(readFileSync(artifact.zip)).digest('hex');
const bucket = 'uniqassess-aws-lab-artifacts-891612540396';
const key = `reconciliation/${sha}.zip`;
const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', 'uniqassess-lab-reconciliation']).Stacks[0];
if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw new Error('Finish the current reconciliation stack update first.');
const changed = { CodeBucket: bucket, CodeKey: key, AwsRunnerFunctionArn: 'arn:aws:lambda:eu-west-1:891612540396:function:uniqassess-aws-lab-runner' };
const parameters = stack.Parameters.filter(p => !(p.ParameterKey in changed)).map(p => ({ ParameterKey: p.ParameterKey, UsePreviousValue: true }));
parameters.push(...Object.entries(changed).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })));
aws(['cloudformation', 'validate-template', '--template-body', 'file://infra/kubernetes-labs/reconciliation/template.yaml']);
aws(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', artifact.zip, '--server-side-encryption', 'AES256']);
const result = aws(['cloudformation', 'update-stack', '--stack-name', 'uniqassess-lab-reconciliation',
  '--template-body', 'file://infra/kubernetes-labs/reconciliation/template.yaml', '--capabilities', 'CAPABILITY_IAM', '--parameters', JSON.stringify(parameters)]);
console.log(JSON.stringify({ updateStarted: true, stackId: result.StackId, packageSha256: sha }));
