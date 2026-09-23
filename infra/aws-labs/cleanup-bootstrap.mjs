/** Removes only the temporary, tagged AWS account bootstrap helper after acceptance. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const mode=process.argv[2]||'--inspect';
const execute=mode==='--execute-after-acceptance';
const account='891612540396',region='eu-west-1';
const helper='uniqassess-aws-lab-account-bootstrap';
const helperRole=`arn:aws:iam::${account}:role/${helper}`;
const policy='AssumeOnlyDedicatedSandbox';
const runtime='uniqassess-aws-lab-runner';
const managedBy='uniqassess-aws-lab-account-provisioner';
const check=(ok,message)=>{if(!ok)throw Error(message)};
check(['--inspect','--execute-after-acceptance'].includes(mode),'Unsupported mode');
function aws(service,action,args=[],missingCode){
  try{return JSON.parse(execFileSync('aws',[service,action,...args,'--profile','default','--region',region,'--output','json','--no-cli-pager'],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:90000,maxBuffer:1048576})||'{}');}
  catch(error){
    const code=String(error.stderr||'').match(/An error occurred \(([^)]+)\)/)?.[1];
    if(missingCode&&code===missingCode)return null;
    throw Error(`${service} ${action} failed (${code||'unavailable'}); raw output suppressed`);
  }
}
const readJson=path=>JSON.parse(readFileSync(join(root,path),'utf8'));
const scalar=value=>Array.isArray(value)?value:[value];
function runtimeState(){
  const stack=aws('cloudformation','describe-stacks',['--stack-name','uniqassess-aws-lab-management']).Stacks[0];
  check(['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus),'Runtime stack is not stable');
  const config=aws('lambda','get-function-configuration',['--function-name',runtime]);
  check(config.State==='Active'&&config.LastUpdateStatus==='Successful'&&config.Handler==='handler.handler'&&
    config.Environment?.Variables?.AWS_LABS_ENABLED==='true'&&config.Role===`arn:aws:iam::${account}:role/${runtime}`,'Runtime configuration unexpected');
  const rule=aws('events','describe-rule',['--name','uniqassess-aws-lab-reconcile']);
  check(rule.State==='ENABLED','Reconciliation is disabled');
  const pool=aws('dynamodb','get-item',['--table-name','uniqassess-aws-lab-sessions','--key',JSON.stringify({id:{S:'POOL'}}),'--consistent-read','--projection-expression','id,leaseId']);
  check(!pool.Item,'Exclusive lease must be released before removing bootstrap access');
  const leases={};
  for(const id of ['cmue4s0510005lb1elll83jfa','cmue59x3g000pif1elug51yn8']){
    const item=aws('dynamodb','get-item',['--table-name','uniqassess-aws-lab-sessions','--key',JSON.stringify({id:{S:'L#'+id}}),'--consistent-read','--projection-expression','id,#s,cleanupComplete,cleanedAt','--expression-attribute-names',JSON.stringify({'#s':'status'})]).Item;
    check(item&&['stopped','expired'].includes(item.status?.S)&&item.cleanupComplete?.BOOL===true,'Browser lease cleanup is incomplete');
    leases[id]={status:item.status.S,cleanupComplete:true,cleanedAt:item.cleanedAt?.S};
  }
  return {observedAt:new Date().toISOString(),stackStatus:stack.StackStatus,functionName:runtime,state:config.State,lastUpdate:config.LastUpdateStatus,
    codeSha256:Buffer.from(config.CodeSha256,'base64').toString('hex'),reconciliation:rule.State,poolEmpty:true,leases};
}

check(aws('sts','get-caller-identity').Account===account,'Unexpected AWS caller');
const alpha=readJson('.deployment/devops-alpha-independent-absence.json');
const beta=readJson('.deployment/devops-beta-independent-absence.json');
const acceptance=readJson('.deployment/aws-lab-acceptance-20260923c1d2e3f4/acceptance.json');
check(alpha.allAbsent&&alpha.aws.labId==='cmue4s0510005lb1elll83jfa'&&alpha.kubernetes.namespace==='ua-lab-cmue4sj4u0009lb1encxfgxjx'&&
  beta.allAbsent&&beta.aws.labId==='cmue59x3g000pif1elug51yn8'&&Date.parse(beta.aws.observedAt)>Date.parse('2026-09-23T13:39:47.540Z'),'Required independent browser absence evidence missing');
check(acceptance.passed===true&&acceptance.runId==='20260923c1d2e3f4'&&acceptance.checks.every(c=>c.passed),'Operator acceptance did not pass');
const before=runtimeState();
const fn=aws('lambda','get-function',['--function-name',helper],'ResourceNotFoundException');
const role=aws('iam','get-role',['--role-name',helper],'NoSuchEntity')?.Role;
if(fn)check(fn.Configuration.Role===helperRole&&fn.Tags?.ManagedBy===managedBy,'Helper Lambda identity mismatch');
if(role){
  check(role.Arn===helperRole&&role.Tags?.some(t=>t.Key==='ManagedBy'&&t.Value===managedBy),'Bootstrap role identity mismatch');
  const attached=aws('iam','list-attached-role-policies',['--role-name',helper]);
  const profiles=aws('iam','list-instance-profiles-for-role',['--role-name',helper]);
  check(attached.AttachedPolicies.length===0&&profiles.InstanceProfiles.length===0,'Bootstrap role has another attachment');
  const names=aws('iam','list-role-policies',['--role-name',helper]).PolicyNames;
  check(names.length<=1&&names.every(n=>n===policy),'Unexpected inline policies');
  if(names.length){
    const document=aws('iam','get-role-policy',['--role-name',helper,'--policy-name',policy]).PolicyDocument;
    const statements=scalar(document.Statement);
    check(statements.length===1&&statements[0].Effect==='Allow'&&
      JSON.stringify(scalar(statements[0].Action))===JSON.stringify(['sts:AssumeRole'])&&
      JSON.stringify(scalar(statements[0].Resource))===JSON.stringify(['arn:aws:iam::689324611808:role/OrganizationAccountAccessRole'])&&
      !statements[0].NotAction&&!statements[0].NotResource&&!statements[0].Principal,'Bootstrap policy scope mismatch');
  }
}
check(!fn||role,'Helper Lambda unexpectedly points to missing role');
const receipt={observedAt:new Date().toISOString(),account,region,mode,removalTargets:{functionName:helper,roleArn:helperRole,inlinePolicy:policy},
  independentProof:{alpha,beta,operatorRunId:acceptance.runId,operatorPassed:true},before,mutationsPerformed:false};
if(execute){
  if(fn)aws('lambda','delete-function',['--function-name',helper]);
  if(role){
    const names=aws('iam','list-role-policies',['--role-name',helper]).PolicyNames;
    if(names.includes(policy))aws('iam','delete-role-policy',['--role-name',helper,'--policy-name',policy]);
    aws('iam','delete-role',['--role-name',helper]);
  }
  check(!aws('lambda','get-function',['--function-name',helper],'ResourceNotFoundException'),'Helper function still exists');
  check(!aws('iam','get-role',['--role-name',helper],'NoSuchEntity'),'Helper role still exists');
  receipt.mutationsPerformed=Boolean(fn||role);
  receipt.functionAbsent=true;receipt.roleAbsent=true;
  receipt.after=runtimeState();
  check(receipt.after.codeSha256===before.codeSha256,'Runtime code changed during bootstrap removal');
  const temporary=mkdtempSync(join(tmpdir(),'uniqassess-cleanup-health-'));
  try{
    const response=join(temporary,'health.json');
    const invoked=aws('lambda','invoke',['--function-name',runtime,'--cli-binary-format','raw-in-base64-out','--payload',JSON.stringify({operation:'health'}),response]);
    const health=JSON.parse(readFileSync(response,'utf8'));
    check(!invoked.FunctionError&&health.statusCode===200&&health.body?.ready&&health.body?.enabled&&health.body?.provider==='aws','Runtime health failed after bootstrap removal');
    receipt.runtimeHealth=health.body;
  }finally{
    check(resolve(temporary).startsWith(resolve(tmpdir())+'\\uniqassess-cleanup-health-'),'Unexpected temporary path');
    rmSync(temporary,{recursive:true,force:true});
  }
  receipt.completedAt=new Date().toISOString();
  writeFileSync(join(root,'infra/aws-labs/bootstrap-cleanup-evidence.json'),JSON.stringify(receipt,null,2)+'\n');
}
console.log(JSON.stringify({mode,mutationsPerformed:receipt.mutationsPerformed,functionAbsent:receipt.functionAbsent,roleAbsent:receipt.roleAbsent,runtimeReady:receipt.runtimeHealth?.ready,
  poolEmpty:before.poolEmpty,completedAt:receipt.completedAt}));
