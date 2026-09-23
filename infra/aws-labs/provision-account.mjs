import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit operator action: this creates one Organizations member account and
// moves only that account into the lab OU. It never issues candidate access.
const run = promisify(execFile);
const EXPECTED_MANAGEMENT_ACCOUNT = '891612540396';
const ACCOUNT_NAME = 'UNIQassess Assessment Sandbox';
const OU_NAME = 'UNIQassessAssessmentLabs';
const ROLE_NAME = 'OrganizationAccountAccessRole';
const receiptPath = fileURLToPath(new URL('./account-provisioning-evidence.json', import.meta.url));
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 3 || arguments_[0] !== '--apply' || arguments_[1] !== '--email') {
  throw new Error('Usage: node infra/aws-labs/provision-account.mjs --apply --email <owner-controlled unique email>');
}
const email = arguments_[2].trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 64) throw new Error('A valid owner-controlled account email is required.');
let receipt = { checkedAt: new Date().toISOString(), managementAccountId: EXPECTED_MANAGEMENT_ACCOUNT,
  accountName: ACCOUNT_NAME, region: 'eu-west-1', candidateAccessEnabled: false, resourcesProvisioned: false, events: [] };
try {
  const prior = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (prior.managementAccountId !== EXPECTED_MANAGEMENT_ACCOUNT || prior.accountName !== ACCOUNT_NAME) throw new Error('Existing receipt target mismatch.');
  receipt = { ...prior, checkedAt: new Date().toISOString() };
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
async function save() {
  await writeFile(`${receiptPath}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await rename(`${receiptPath}.tmp`, receiptPath);
}
async function record(type, details = {}) {
  const event = { at: new Date().toISOString(), type, ...details };
  receipt.events.push(event);
  await save();
  console.log(JSON.stringify(event));
}
async function aws(service, operation, arguments_ = [], credentials) {
  const env = { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_DEFAULT_REGION: 'eu-west-1' };
  if (credentials) {
    delete env.AWS_PROFILE;
    delete env.AWS_DEFAULT_PROFILE;
    Object.assign(env, { AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken });
  } else {
    // Do not accidentally target another configured profile or ambient key.
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    env.AWS_PROFILE = 'default';
  }
  try {
    const { stdout } = await run('aws', [service, operation, ...arguments_, '--region', 'eu-west-1', '--output', 'json', '--no-cli-pager'],
      { env, windowsHide: true, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    const code = /\(([^)]+)\) when calling/.exec(String(error.stderr ?? ''))?.[1] ?? 'AwsCliFailure';
    const safe = new Error(`${service}.${operation} failed: ${code}`);
    safe.awsCode = code;
    throw safe;
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function zipSingleFile(name, content) {
  const filename = Buffer.from(name);
  const data = Buffer.from(content);
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
async function probeThroughTemporaryLambda(accountId) {
  const roleName = 'uniqassess-aws-lab-account-bootstrap';
  const functionName = 'uniqassess-aws-lab-account-bootstrap';
  const managedTag = { Key: 'ManagedBy', Value: 'uniqassess-aws-lab-account-provisioner' };
  let role;
  try {
    role = (await aws('iam', 'get-role', ['--role-name', roleName])).Role;
    if (!role.Tags?.some((tag) => tag.Key === managedTag.Key && tag.Value === managedTag.Value)) throw new Error('Bootstrap role name belongs to an unmanaged resource.');
  } catch (error) {
    if (error.awsCode !== 'NoSuchEntity') throw error;
    role = (await aws('iam', 'create-role', ['--role-name', roleName,
      '--assume-role-policy-document', JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }),
      '--tags', JSON.stringify([managedTag]), '--max-session-duration', '3600'])).Role;
  }
  await aws('iam', 'put-role-policy', ['--role-name', roleName, '--policy-name', 'AssumeOnlyDedicatedSandbox',
    '--policy-document', JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: `arn:aws:iam::${accountId}:role/${ROLE_NAME}` }] })]);
  const code = await readFile(new URL('./bootstrap-helper.py', import.meta.url), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'uniqassess-account-bootstrap-'));
  try {
    const archivePath = join(directory, 'bootstrap.zip');
    const responsePath = join(directory, 'response.json');
    await writeFile(archivePath, zipSingleFile('index.py', code));
    let existing;
    try { existing = await aws('lambda', 'get-function', ['--function-name', functionName]); }
    catch (error) { if (error.awsCode !== 'ResourceNotFoundException') throw error; }
    if (existing) {
      if (existing.Tags?.ManagedBy !== managedTag.Value || existing.Configuration.Role !== role.Arn) throw new Error('Bootstrap function name belongs to an unmanaged resource.');
      await aws('lambda', 'update-function-code', ['--function-name', functionName, '--zip-file', `fileb://${archivePath}`]);
    } else {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await aws('lambda', 'create-function', ['--function-name', functionName, '--runtime', 'python3.12', '--handler', 'index.handler',
            '--role', role.Arn, '--timeout', '30', '--memory-size', '128', '--zip-file', `fileb://${archivePath}`,
            '--tags', JSON.stringify({ ManagedBy: managedTag.Value })]);
          break;
        } catch (error) {
          if (error.awsCode !== 'InvalidParameterValueException' || attempt === 7) throw error;
          await delay(5000);
        }
      }
    }
    await aws('lambda', 'wait', ['function-active-v2', '--function-name', functionName]);
    await aws('lambda', 'wait', ['function-updated-v2', '--function-name', functionName]);
    await aws('lambda', 'put-function-concurrency', ['--function-name', functionName, '--reserved-concurrent-executions', '1']);
    receipt.bootstrapHelper = { functionName, roleName, temporary: true, cleanupRequired: true, permission: `sts:AssumeRole on arn:aws:iam::${accountId}:role/${ROLE_NAME}` };
    await record('temporary-bootstrap-helper-created', { functionName, sandboxAccountId: accountId });
    const invocation = await aws('lambda', 'invoke', ['--function-name', functionName, '--cli-binary-format', 'raw-in-base64-out',
      '--payload', JSON.stringify({ operation: 'probe' }), responsePath]);
    const response = JSON.parse(await readFile(responsePath, 'utf8'));
    if (invocation.FunctionError) throw new Error(`Bootstrap probe failed: ${response.errorType ?? 'LambdaError'}`);
    if (response.accountId !== accountId) throw new Error('Bootstrap probe returned an unexpected account.');
    return response;
  } finally {
    // Only remove the freshly created, fixed-prefix temporary directory.
    if (!directory.startsWith(join(tmpdir(), 'uniqassess-account-bootstrap-'))) throw new Error('Unexpected temporary directory.');
    await rm(directory, { recursive: true, force: true });
  }
}
try {
  const identity = await aws('sts', 'get-caller-identity');
  if (identity.Account !== EXPECTED_MANAGEMENT_ACCOUNT) throw new Error('Refusing unexpected management account.');
  receipt.operatorPrincipalType = identity.Arn.endsWith(':root') ? 'root' : 'iam-or-role';
  let organization;
  try { organization = (await aws('organizations', 'describe-organization')).Organization; }
  catch (error) {
    if (error.awsCode !== 'AWSOrganizationsNotInUseException') throw error;
    organization = (await aws('organizations', 'create-organization', ['--feature-set', 'ALL'])).Organization;
    await record('organization-created', { organizationId: organization.Id });
  }
  if (organization.MasterAccountId !== EXPECTED_MANAGEMENT_ACCOUNT || organization.FeatureSet !== 'ALL') {
    throw new Error('Organization management account or feature set mismatch; no account changes made.');
  }
  receipt.organizationId = organization.Id;
  receipt.featureSet = organization.FeatureSet;
  const accounts = (await aws('organizations', 'list-accounts')).Accounts ?? [];
  const matching = accounts.filter((account) => account.Email?.toLowerCase() === email.toLowerCase());
  if (matching.length > 1) throw new Error('Ambiguous account email match.');
  let account = matching[0];
  if (account && (account.Name !== ACCOUNT_NAME || account.Id === EXPECTED_MANAGEMENT_ACCOUNT)) {
    throw new Error('Email belongs to a different existing account; refusing to repurpose it.');
  }
  if (!account) {
    if (accounts.some((candidate) => candidate.Name === ACCOUNT_NAME)) throw new Error('Account name already exists with a different email; refusing duplicate creation.');
    let requestId = receipt.createAccountRequestId;
    if (!requestId) {
      const pending = (await aws('organizations', 'list-create-account-status', ['--states', 'IN_PROGRESS'])).CreateAccountStatuses
        ?.filter((request) => request.AccountName === ACCOUNT_NAME) ?? [];
      if (pending.length) throw new Error('An account creation is already in progress without this receipt; inspect it before retrying.');
      const response = await aws('organizations', 'create-account', ['--account-name', ACCOUNT_NAME, '--email', email,
        '--role-name', ROLE_NAME, '--iam-user-access-to-billing', 'DENY']);
      requestId = response.CreateAccountStatus.Id;
      receipt.createAccountRequestId = requestId;
      receipt.createdByThisProvisioner = true;
      await record('account-creation-requested', { requestId });
    }
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const status = (await aws('organizations', 'describe-create-account-status', ['--create-account-request-id', requestId])).CreateAccountStatus;
      if (status.AccountName !== ACCOUNT_NAME) throw new Error('Creation request targets a different account name.');
      if (status.State === 'FAILED') {
        receipt.status = 'blocked';
        receipt.failureReason = status.FailureReason;
        await record('account-creation-failed', { reason: status.FailureReason });
        throw new Error(`Account creation failed: ${status.FailureReason}. No alternative email will be attempted.`);
      }
      if (status.State === 'SUCCEEDED') {
        account = (await aws('organizations', 'describe-account', ['--account-id', status.AccountId])).Account;
        break;
      }
      if (attempt % 3 === 0) await record('account-creation-pending', { requestId, attempt: attempt + 1 });
      await delay(attempt < 3 ? 10_000 : 30_000);
    }
    if (!account) throw new Error('Account creation is still pending; rerun with the same receipt and email to resume.');
  }
  if (account.Id === EXPECTED_MANAGEMENT_ACCOUNT || account.Name !== ACCOUNT_NAME || account.Email?.toLowerCase() !== email.toLowerCase()) {
    throw new Error('Created/discovered account identity mismatch.');
  }
  if (!receipt.createdByThisProvisioner || (receipt.sandboxAccountId && receipt.sandboxAccountId !== account.Id)) {
    throw new Error('Refusing to move an account not created by this provisioner.');
  }
  if ((account.State ?? account.Status) !== 'ACTIVE') throw new Error('Sandbox account is not active yet.');
  receipt.sandboxAccountId = account.Id;
  receipt.provisioningRoleArn = `arn:aws:iam::${account.Id}:role/${ROLE_NAME}`;
  await record('account-active', { sandboxAccountId: account.Id });
  const roots = (await aws('organizations', 'list-roots')).Roots ?? [];
  if (roots.length !== 1) throw new Error('Expected exactly one organization root.');
  const rootId = roots[0].Id;
  const ous = (await aws('organizations', 'list-organizational-units-for-parent', ['--parent-id', rootId])).OrganizationalUnits ?? [];
  const existingOus = ous.filter((ou) => ou.Name === OU_NAME);
  if (existingOus.length > 1) throw new Error('Ambiguous lab organizational unit.');
  const ou = existingOus[0] ?? (await aws('organizations', 'create-organizational-unit', ['--parent-id', rootId, '--name', OU_NAME])).OrganizationalUnit;
  receipt.labOuId = ou.Id;
  const parents = (await aws('organizations', 'list-parents', ['--child-id', account.Id])).Parents ?? [];
  if (parents.length !== 1 || ![rootId, ou.Id].includes(parents[0].Id)) throw new Error('Account already belongs to another OU; refusing to move it.');
  if (parents[0].Id === rootId) {
    await aws('organizations', 'move-account', ['--account-id', account.Id, '--source-parent-id', rootId, '--destination-parent-id', ou.Id]);
    await record('sandbox-moved-to-lab-ou', { sandboxAccountId: account.Id, labOuId: ou.Id });
  }
  const checkedParents = (await aws('organizations', 'list-parents', ['--child-id', account.Id])).Parents ?? [];
  if (checkedParents.length !== 1 || checkedParents[0].Id !== ou.Id) throw new Error('Account OU verification failed.');
  if (receipt.operatorPrincipalType === 'root') {
    const response = await probeThroughTemporaryLambda(account.Id);
    receipt.assumeRoleVerified = true;
    receipt.lambdaQuota = response.lambdaQuota;
    receipt.codeBuildQuotas = response.codeBuildQuotas;
    receipt.status = 'account-provisioned-runtime-pending';
    delete receipt.failureReason;
    delete receipt.lastError;
    await record('sandbox-access-verified', { sandboxAccountId: account.Id, lambdaQuota: receipt.lambdaQuota, codeBuildQuotas: receipt.codeBuildQuotas });
    process.exit(0);
  }
  let assumed;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      assumed = await aws('sts', 'assume-role', ['--role-arn', receipt.provisioningRoleArn,
        '--role-session-name', 'uniqassess-account-preflight', '--duration-seconds', '900']);
      break;
    } catch (error) {
      if (error.awsCode !== 'AccessDenied' || attempt === 5) throw error;
      await delay(10_000);
    }
  }
  // Temporary credentials stay in memory and go only to the child CLI process.
  const sandboxIdentity = await aws('sts', 'get-caller-identity', [], assumed.Credentials);
  if (sandboxIdentity.Account !== account.Id) throw new Error('Assumed role returned an unexpected account.');
  const lambda = await aws('lambda', 'get-account-settings', [], assumed.Credentials);
  receipt.assumeRoleVerified = true;
  receipt.lambdaQuota = { concurrentExecutions: lambda.AccountLimit.ConcurrentExecutions,
    unreservedConcurrentExecutions: lambda.AccountLimit.UnreservedConcurrentExecutions,
    existingFunctionCount: lambda.AccountUsage.FunctionCount };
  const buildQuotas = await aws('service-quotas', 'list-service-quotas', ['--service-code', 'codebuild'], assumed.Credentials);
  receipt.codeBuildQuotas = (buildQuotas.Quotas ?? [])
    .filter((quota) => /concurrent/i.test(quota.QuotaName) && /(small|arm)/i.test(quota.QuotaName))
    .map((quota) => ({ name: quota.QuotaName, code: quota.QuotaCode, value: quota.Value, adjustable: quota.Adjustable }));
  assumed = undefined;
  receipt.status = 'account-provisioned-runtime-pending';
  delete receipt.failureReason;
  await record('sandbox-access-verified', { sandboxAccountId: account.Id, lambdaQuota: receipt.lambdaQuota,
    codeBuildQuotas: receipt.codeBuildQuotas });
} catch (error) {
  receipt.status ??= 'blocked';
  receipt.lastError = error.message;
  await save();
  console.error(error.message);
  process.exitCode = 1;
}
