/** Bounded operator actions for the dedicated UNIQassess pilot. No secrets are logged. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.deployment');
mkdirSync(dir, { recursive: true });
const account = '891612540396', region = 'eu-west-1';
const stack = 'uniqassess-kubernetes-pilot';
const bucket = 'uniqassess-lab-artifacts-891612540396-eu-west-1';
const statePath = path.join(dir, 'cloud-state.json');
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { account, region, stack, bucket };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
function aws(service, action, input = {}, targetRegion = region) {
  const file = path.join(dir, `request-${randomBytes(5).toString('hex')}.json`);
  writeFileSync(file, JSON.stringify(input));
  try { return JSON.parse(execFileSync('aws', [service, action, '--cli-input-json', 'file://' + file, '--region', targetRegion, '--output', 'json', '--no-cli-pager'], {encoding:'utf8', env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'}, stdio:['ignore','pipe','pipe'], maxBuffer:20*1024*1024}) || '{}'); }
  catch(error) { throw new Error(`${service} ${action}: ${String(error.stderr || 'request failed').replace(/(?<=SecretString["\s:]+)[^\n]+/g, '[redacted]')}`); }
  finally { unlinkSync(file); }
}
function optional(service, action, input, missing) { try { return aws(service, action, input); } catch(error) { if (error.message.includes(missing)) return null; throw error; } }
function secret(name, value) {
  const found = optional('secretsmanager','describe-secret',{SecretId:name},'ResourceNotFoundException');
  if (found) return found.ARN;
  return aws('secretsmanager','create-secret',{Name:name, SecretString:JSON.stringify(value), Tags:[{Key:'Project',Value:stack}]}).ARN;
}
async function main() {
  if (aws('sts','get-caller-identity').Account !== account) throw new Error('Refusing unexpected AWS account');
  const op = process.argv[2];
  if (op === 'pricing') {
    for (const instance of ['t3.medium','t3.large']) {
      const filters = {instanceType:instance,location:'EU (Ireland)',operatingSystem:'Linux',tenancy:'Shared',preInstalledSw:'NA',capacitystatus:'Used'};
      const data = aws('pricing','get-products',{ServiceCode:'AmazonEC2',Filters:Object.entries(filters).map(([Field,Value])=>({Type:'TERM_MATCH',Field,Value})),MaxResults:10},'us-east-1');
      console.log(instance, data.PriceList.map(JSON.parse).flatMap(p=>Object.values(p.terms.OnDemand).flatMap(t=>Object.values(t.priceDimensions).map(d=>({hourly:d.pricePerUnit.USD,unit:d.unit,description:d.description})))));
    }
  } else if (op === 'prepare') {
    const keyName = stack + '-bootstrap';
    let key = optional('ec2','describe-key-pairs',{KeyNames:[keyName]},'InvalidKeyPair.NotFound');
    if (!key) {
      key = aws('ec2','create-key-pair',{KeyName:keyName,KeyType:'ed25519',KeyFormat:'pem',TagSpecifications:[{ResourceType:'key-pair',Tags:[{Key:'Project',Value:stack}]}]});
      state.bootstrapSecretArn = secret('uniqassess/labs/pilot/bootstrap',{privateKey:key.KeyMaterial});
    } else if (!state.bootstrapSecretArn) state.bootstrapSecretArn = aws('secretsmanager','describe-secret',{SecretId:'uniqassess/labs/pilot/bootstrap'}).ARN;
    state.keyName = keyName;
    state.runnerSecretArn = secret('uniqassess/labs/pilot/runner',{enabled:false,url:'https://lab-runner.uniqassess.org',key:randomBytes(48).toString('base64url')});
    for (const name of ['uniqassess-labs/workspace','uniqassess-labs/broker']) {
      if (!optional('ecr','describe-repositories',{repositoryNames:[name]},'RepositoryNotFoundException')) aws('ecr','create-repository',{repositoryName:name,imageTagMutability:'IMMUTABLE',imageScanningConfiguration:{scanOnPush:true},tags:[{Key:'Project',Value:stack}]});
    }
    save(); console.log(JSON.stringify(state,null,2));
  } else if (op === 'create-stack') {
    const templateFile = process.argv[3];
    const parametersFile = process.argv[4];
    const result = aws('cloudformation','create-stack',{StackName:stack,TemplateBody:readFileSync(path.resolve(templateFile),'utf8'),Parameters:JSON.parse(readFileSync(path.resolve(parametersFile),'utf8')),Capabilities:['CAPABILITY_IAM'],Tags:[{Key:'Project',Value:stack}],OnFailure:'ROLLBACK'});
    state.stackId=result.StackId;save();console.log(result);
  } else if (op === 'status') {
    const result=aws('cloudformation','describe-stacks',{StackName:stack}).Stacks[0];
    state.outputs=Object.fromEntries((result.Outputs||[]).map(x=>[x.OutputKey,x.OutputValue]));if(state.outputs.BootstrapBucketName)state.bucket=state.outputs.BootstrapBucketName;save();console.log({status:result.StackStatus,outputs:state.outputs});
  } else if (op === 'bootstrap-access') {
    aws('iam','put-role-policy',{RoleName:state.outputs.ControlRoleName,PolicyName:'LabBootstrapOnly',PolicyDocument:JSON.stringify({Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['secretsmanager:GetSecretValue'],Resource:[state.bootstrapSecretArn,state.runnerSecretArn]},
      {Effect:'Allow',Action:['ecr:GetAuthorizationToken'],Resource:'*'},
      {Effect:'Allow',Action:['ecr:BatchCheckLayerAvailability','ecr:InitiateLayerUpload','ecr:UploadLayerPart','ecr:CompleteLayerUpload','ecr:PutImage','ecr:BatchGetImage','ecr:GetDownloadUrlForLayer','ecr:DescribeImages'],Resource:[`arn:aws:ecr:${region}:${account}:repository/uniqassess-labs/workspace`,`arn:aws:ecr:${region}:${account}:repository/uniqassess-labs/broker`]}
    ]})});console.log('Scoped bootstrap access attached.');
  } else if (op === 'dns') {
    const name='lab-runner.uniqassess.org.';
    const existing=aws('route53','list-resource-record-sets',{HostedZoneId:'Z09660871HTK8QD7HNPIU',StartRecordName:name,StartRecordType:'A',MaxItems:'1'}).ResourceRecordSets[0];
    if(existing?.Name===name && (existing.Type!=='A'||existing.ResourceRecords?.[0]?.Value!==state.outputs.ControlPublicIp))throw new Error('Conflicting lab DNS record needs review');
    const result=aws('route53','change-resource-record-sets',{HostedZoneId:'Z09660871HTK8QD7HNPIU',ChangeBatch:{Comment:'Dedicated authenticated UNIQassess lab runner',Changes:[{Action:'UPSERT',ResourceRecordSet:{Name:name,Type:'A',TTL:300,ResourceRecords:[{Value:state.outputs.ControlPublicIp}]}}]}});console.log(result.ChangeInfo);
  } else if (op === 'disable-worker-metadata') {
    const result=aws('cloudformation','update-stack',{StackName:stack,UsePreviousTemplate:true,Parameters:[{ParameterKey:'Project',UsePreviousValue:true},{ParameterKey:'UbuntuImage',UsePreviousValue:true},{ParameterKey:'WorkerKeyName',UsePreviousValue:true},{ParameterKey:'WorkerMetadataEndpoint',ParameterValue:'disabled'}],Capabilities:['CAPABILITY_IAM']});console.log(result);
  } else if (op === 'configure-app') {
    const app=aws('amplify','get-app',{appId:'d1wxabrgr6nkub'}).app;
    const role=app.computeRoleArn.split('/').at(-1);
    aws('iam','put-role-policy',{RoleName:role,PolicyName:'KubernetesPilotRunnerConfiguration',PolicyDocument:JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['secretsmanager:GetSecretValue'],Resource:state.runnerSecretArn}]})});
    aws('amplify','update-app',{appId:app.appId,environmentVariables:{...app.environmentVariables,KUBERNETES_LABS_ENABLED:'true',KUBERNETES_LAB_CONFIG_SECRET_ARN:state.runnerSecretArn}});
    console.log('Nonsecret runner locator configured; starts remain disabled in the secret until live verification.');
  } else if (op === 'scheduler-secret') {
    const app=aws('amplify','get-app',{appId:'d1wxabrgr6nkub'}).app;
    const branch=aws('amplify','get-branch',{appId:app.appId,branchName:'main'}).branch;
    const env={...app.environmentVariables,...branch.environmentVariables};
    state.databaseSecretArn=secret('uniqassess/labs/pilot/reconciliation-database',{DATABASE_URL:env.DATABASE_URL});
    save();console.log({databaseSecretArn:state.databaseSecretArn});
  } else if (op === 'send') {
    const commands=readFileSync(path.resolve(process.argv[3]),'utf8').replace(/\r\n/g,'\n');
    const instance=process.argv[4] || state.outputs.ControlInstanceId;
    const response=aws('ssm','send-command',{InstanceIds:[instance],DocumentName:'AWS-RunShellScript',Parameters:{commands:[commands],executionTimeout:['3600']},TimeoutSeconds:600,Comment:'UNIQassess authorized Kubernetes pilot deployment'});
    state.lastCommandId=response.Command.CommandId;save();console.log({commandId:state.lastCommandId});
  } else if (op === 'command') {
    const response=aws('ssm','get-command-invocation',{CommandId:process.argv[3]||state.lastCommandId,InstanceId:state.outputs.ControlInstanceId});
    console.log({status:response.Status,code:response.ResponseCode,stdout:response.StandardOutputContent,stderr:response.StandardErrorContent});
  } else if (op === 'upload') {
    const file=path.resolve(process.argv[3]);const key=process.argv[4];
    execFileSync('aws',['s3','cp',file,`s3://${state.bucket}/${key}`,'--region',region,'--no-cli-pager'],{stdio:'pipe'});console.log({uploaded:key});
  } else throw new Error('Use pricing, prepare, create-stack, status, send, command or upload');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
