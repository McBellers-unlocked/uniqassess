/**
 * Destructive ONLY to two new, uniquely named synthetic AWS assessment leases.
 * No database, real candidate, browser session or existing lab is touched.
 * Run --check without AWS; --execute requires an operator-chosen 16-hex run ID.
 * Root must confirm the runtime and independent absence helper are installed first.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, 'aws-lab/exercises/aws-service-release-v1');
const MANAGEMENT = '891612540396';
const SANDBOX = '689324611808';
const REGION = 'eu-west-1';
const RUNNER = 'arn:aws:lambda:eu-west-1:891612540396:function:uniqassess-aws-lab-runner';
const HELPER = 'uniqassess-aws-lab-account-bootstrap';
const TEMPLATE = 'aws-service-release-v1';
const mode = process.argv[2] ?? '--check';
const runId = process.env.AWS_LAB_VERIFY_RUN_ID;
if (!['--check', '--execute'].includes(mode) || process.argv.length > 3) throw new Error('Use --check or --execute.');
if (mode === '--execute' && !/^[a-f0-9]{16}$/.test(runId ?? '')) throw new Error('Set AWS_LAB_VERIFY_RUN_ID to a new 16-character lowercase hexadecimal ID.');
const python = (body) => `python - <<'PY'\n${body}\nPY`;
const sleep = (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 30_000)));
const safe = (text) => String(text).replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_ACCESS_KEY]');
const sessionPreamble = `import json, subprocess, pathlib, time, base64\ns = json.loads(pathlib.Path('session.json').read_text())\ndef aws(*args):\n    p = subprocess.run(['aws', *args, '--region', s['region'], '--output', 'json', '--no-cli-pager'], capture_output=True, text=True)\n    if p.returncode: raise RuntimeError('AWS call failed: ' + ' '.join(args[:2]) + ': ' + p.stderr[:600])\n    return json.loads(p.stdout) if p.stdout.strip() else {}\ndef invoke(version, payload, filename):\n    metadata = aws('lambda','invoke','--function-name',s['function_name'],'--qualifier',version,'--cli-binary-format','raw-in-base64-out','--payload',json.dumps(payload),'--log-type','Tail',filename)\n    result = json.loads(pathlib.Path(filename).read_text())\n    logs = base64.b64decode(metadata.get('LogResult','')).decode('utf-8','replace')\n    return metadata, result, logs\n`;

const app = await readFile(join(FIXTURE, 'candidate/app.py'), 'utf8');
const tf = await readFile(join(FIXTURE, 'candidate/main.tf'), 'utf8');
const solution = await readFile(join(FIXTURE, 'assessor/build_solution.py'), 'utf8');
const pipeline = await readFile(join(FIXTURE, 'assessor/pipeline.sh'), 'utf8');
const alarm = /ALARM = '''([\s\S]*?)'''/.exec(solution)?.[1];
if (!alarm || app.split('for read_number in range(3):').length !== 2 || !tf.includes('/archive/*')) throw new Error('Fixture reference contract changed; review the verification script.');
const fixed = {
  'app.py': app.replace('for read_number in range(3):', 'for read_number in range(1):'),
  'main.tf': tf.replace('/archive/*', '/orders/*') + alarm,
  'pipeline.sh': pipeline,
};
const repair = python(`import base64,gzip,json,pathlib\nfiles=json.loads(gzip.decompress(base64.b64decode('${gzipSync(Buffer.from(JSON.stringify(fixed))).toString('base64')}')))\nfor name,text in files.items():\n    assert name in ('app.py','main.tf','pipeline.sh')\n    pathlib.Path(name).write_text(text)\npathlib.Path('pipeline.sh').chmod(0o755)\nprint('Reference repair installed for synthetic operator acceptance')`);
const commands = {
  initial: python(sessionPreamble + `identity=aws('sts','get-caller-identity')\nassert identity['Account']=='${SANDBOX}'\nmetadata,result,logs=invoke('$LATEST',{'order_id':'order-1042'},'initial-response.json')\nassert result['statusCode']==503, result\nassert 'AccessDenied' in logs, logs\nprint(json.dumps({'account':identity['Account'],'function':s['function_name'],'baselineStatus':result['statusCode'],'accessDeniedObserved':True}))\nprint(logs)\nsubprocess.run(['python','-m','unittest','discover','-s','tests','-v'],check=True)`),
  idempotency: python(`from pathlib import Path\np=Path('acceptance-counter.txt')\nn=int(p.read_text()) if p.exists() else 0\np.write_text(str(n+1))\nprint('acceptance-counter='+str(n+1))`),
  counter: python(`from pathlib import Path\nassert Path('acceptance-counter.txt').read_text()=='1'\nprint('Exactly one execution retained across duplicate request')`),
  boundary: python(sessionPreamble + `checks=[['iam','list-users'],['sts','assume-role','--role-arn','arn:aws:iam::${MANAGEMENT}:role/OrganizationAccountAccessRole','--role-session-name','uniqassess-denial-probe'],['lambda','update-function-configuration','--function-name',s['function_name'],'--memory-size','256']]\nfor args in checks:\n    p=subprocess.run(['aws',*args,'--region',s['region'],'--output','json'],capture_output=True,text=True)\n    assert p.returncode!=0, 'Unexpected forbidden success; output suppressed'\n    assert 'AccessDenied' in p.stderr or 'not authorized' in p.stderr, p.stderr[:500]\n    print('Denied: '+' '.join(args[:2]))\nassert aws('sts','get-caller-identity')['Account']=='${SANDBOX}'`),
  performanceBaseline: python(sessionPreamble + `path=pathlib.Path('main.tf')\ntext=path.read_text()\nassert text.count('/archive/*')==1\npath.write_text(text.replace('/archive/*','/orders/*'))\npathlib.Path('build').mkdir(exist_ok=True)\nfor args in [['terraform','init','-input=false'],['terraform','plan','-input=false','-out=build/permission.tfplan']]: subprocess.run(args,check=True)\nplan=json.loads(subprocess.run(['terraform','show','-json','build/permission.tfplan'],capture_output=True,text=True,check=True).stdout)\nassert all('delete' not in r['change']['actions'] and r['address'] in ('aws_iam_role_policy.app_runtime','aws_lambda_alias.live') for r in plan.get('resource_changes',[]))\nsubprocess.run(['terraform','apply','-input=false','build/permission.tfplan'],check=True)\nfrom zipfile import ZipFile, ZIP_DEFLATED\nfrom hashlib import sha256\nsource=pathlib.Path('app.py').read_bytes()\nsource_digest=sha256(source).hexdigest()\nbefore_digest=aws('lambda','get-function-configuration','--function-name',s['function_name'])['CodeSha256']\nwith ZipFile('build/permission-refresh.zip','w',ZIP_DEFLATED) as archive:\n    archive.writestr('app.py',source)\nupdated=aws('lambda','update-function-code','--function-name',s['function_name'],'--zip-file','fileb://build/permission-refresh.zip')\nassert updated['CodeSha256']==base64.b64encode(sha256(pathlib.Path('build/permission-refresh.zip').read_bytes()).digest()).decode()\nassert source_digest==sha256(pathlib.Path('app.py').read_bytes()).hexdigest()\nprint(json.dumps({'unchangedSourceSha256':source_digest,'beforeArchiveSha256':before_digest,'refreshedArchiveSha256':updated['CodeSha256'],'sourceChanged':False}))\nsubprocess.run(['aws','lambda','wait','function-updated','--function-name',s['function_name'],'--region',s['region']],check=True)\nprint('One explicit code refresh after IAM change; baseline still reads the object three times')\nfor attempt in range(10):\n    _,probe,probe_logs=invoke('$LATEST',{'order_id':'order-1042'},'permission-propagation.json')\n    print(json.dumps({'permissionPropagationAttempt':attempt+1,'status':probe.get('statusCode')}))\n    if probe.get('statusCode')==200: break\n    if attempt==9: raise AssertionError({'response':probe,'logs':probe_logs})\n    time.sleep(5)\nsamples=[]\nfor i in range(5):\n    _,result,logs=invoke('$LATEST',{'order_id':'order-1042'},'baseline-performance-response.json')\n    assert result['statusCode']==200, result\n    records=[json.loads(line) for line in logs.splitlines() if line.startswith('{')]\n    spans=[r for r in records if r.get('event')=='dependency_span']\n    summary=[r for r in records if r.get('event')=='request_summary'][-1]\n    assert len(spans)==3, logs\n    samples.append({'requestId':summary['request_id'],'durationMs':summary['DurationMs'],'dependencyReads':len(spans)})\npathlib.Path('baseline-performance.json').write_text(json.dumps(samples))\nprint(json.dumps({'baselineSamples':samples,'note':'Five actual request durations; not a p95 estimate or production benchmark'}))`),
  repair,
  failedGate: python(sessionPreamble + `before=aws('lambda','get-function-configuration','--function-name',s['function_name'])['CodeSha256']\npath=pathlib.Path('tests/test_acceptance_forced_failure.py')\npath.write_text('import unittest\\nclass ForcedFailure(unittest.TestCase):\\n    def test_gate(self): self.fail("synthetic acceptance gate")\\n')\ntry:\n    p=subprocess.run(['bash','pipeline.sh'],capture_output=True,text=True)\n    assert p.returncode!=0, 'Failed test unexpectedly allowed pipeline success'\n    assert 'synthetic acceptance gate' in p.stdout+p.stderr, (p.stdout+p.stderr)[-1500:]\n    assert aws('lambda','get-function-configuration','--function-name',s['function_name'])['CodeSha256']==before\n    print('Failed-test gate stopped release; function code digest unchanged')\nfinally:\n    path.unlink(missing_ok=True)`),
  release: 'bash pipeline.sh release',
  functional: python(sessionPreamble + `samples=[]\nfor i in range(5):\n    metadata,result,logs=invoke('live',{'order_id':'order-1042'},'fixed-response.json')\n    assert result['statusCode']==200, result\n    assert json.loads(result['body'])=={'order_id':'order-1042','status':'confirmed'}\n    records=[json.loads(line) for line in logs.splitlines() if line.startswith('{')]\n    spans=[r for r in records if r.get('event')=='dependency_span']\n    summary=[r for r in records if r.get('event')=='request_summary'][-1]\n    assert len(spans)==1, logs\n    samples.append({'requestId':summary['request_id'],'durationMs':summary['DurationMs'],'dependencyReads':1})\n_,missing,_=invoke('live',{'order_id':'order-9999'},'missing-response.json')\nassert missing['statusCode']==404, missing\np=subprocess.run(['aws','s3api','get-object','--bucket',s['data_bucket'],'--key','private/operator-only.json','outside-object.txt','--region',s['region']],capture_output=True,text=True)\nassert p.returncode!=0 and ('AccessDenied' in p.stderr or 'Forbidden' in p.stderr), 'Out-of-scope S3 request was not denied'\nprint(json.dumps({'status':200,'missingStatus':404,'outOfScopeDenied':True,'executedVersion':metadata.get('ExecutedVersion'),'baselineSamples':json.loads(pathlib.Path('baseline-performance.json').read_text()),'repairedSamples':samples,'note':'Five samples per version; report cold/warm/sample limits, not p95 or a guaranteed speedup'}))`),
  alarmBreach: python(sessionPreamble + `_,result,_=invoke('live',{'order_id':'order-1042','exercise_fault':'dependency_unavailable'},'alarm-fault.json')\nassert result['statusCode']==503\nfor attempt in range(10):\n    alarm=aws('cloudwatch','describe-alarms','--alarm-names',s['alarm_name'])['MetricAlarms']\n    if alarm and alarm[0]['StateValue']=='ALARM':\n        print(json.dumps({'alarm':s['alarm_name'],'state':'ALARM','reason':alarm[0]['StateReason'],'syntheticFaultInjected':True})); break\n    time.sleep(20)\nelse: raise RuntimeError('Metric-driven alarm breach was not observed within 200 seconds')`),
  alarmRecovery: python(sessionPreamble + `_,result,_=invoke('live',{'order_id':'order-1042'},'alarm-recovery.json')\nassert result['statusCode']==200\nfor attempt in range(10):\n    alarm=aws('cloudwatch','describe-alarms','--alarm-names',s['alarm_name'])['MetricAlarms'][0]\n    if alarm['StateValue']=='OK':\n        print(json.dumps({'alarm':s['alarm_name'],'state':'OK','reason':alarm['StateReason'],'healthyInvocationObserved':True})); break\n    time.sleep(20)\nelse: raise RuntimeError('Alarm recovery was not observed within 200 seconds')`),
  rollback: 'bash pipeline.sh rollback',
  final: python(sessionPreamble + `alias=aws('lambda','get-alias','--function-name',s['function_name'],'--name','live')\nassert alias['FunctionVersion']==str(s['known_good_version'])\n_,result,logs=invoke('live',{'order_id':'order-1042'},'rollback-final-response.json')\nassert result['statusCode']==200\nprint(json.dumps({'alias':alias['Name'],'version':alias['FunctionVersion'],'knownGoodVerified':True,'response':result}))`),
  expiryMarker: python(`from pathlib import Path\nPath('expiry-evidence.txt').write_text('synthetic expiry acceptance')\nprint('expiry-marker-retained')`),
};
for (const [name, command] of Object.entries(commands)) if (command.length > 8000) throw new Error(`${name} exceeds the 8000-character command limit.`);
if (mode === '--check') {
  console.log(JSON.stringify({ executable: true, cloudCallsMade: false, commands: Object.fromEntries(Object.entries(commands).map(([key, value]) => [key, value.length])), candidateDirectory: 'aws-lab/exercises/aws-service-release-v1/candidate', assessorDirectoryExcluded: true }, null, 2));
  process.exit(0);
}

const directory = resolve(ROOT, '.deployment', `aws-lab-acceptance-${runId}`);
await mkdir(directory, { recursive: true });
const reportPath = join(directory, 'acceptance.json');
try { await readFile(reportPath); throw new Error('This run ID already has a report. Use a new ID; previous evidence is never overwritten.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const normal = `cawsverify${runId}`;
const other = `cawsverifyother${runId}`;
const expiry = `cawsverifyexp${runId}`;
const report = { runId, startedAt: new Date().toISOString(), passed: false, managementAccount: MANAGEMENT, sandboxAccount: SANDBOX, templateId: TEMPLATE, checks: [], commands: [], leases: [] };
const created = new Set();
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const env = { ...process.env, AWS_PROFILE: 'default', AWS_DEFAULT_REGION: REGION, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
delete env.AWS_ACCESS_KEY_ID; delete env.AWS_SECRET_ACCESS_KEY; delete env.AWS_SESSION_TOKEN;
async function cli(service, operation, args = []) {
  try {
    const { stdout } = await run('aws', [service, operation, ...args, '--region', REGION, '--output', 'json', '--no-cli-pager'], { env, windowsHide: true, timeout: 130_000, maxBuffer: 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) { throw new Error(`${service}.${operation}: ${/\(([^)]+)\) when calling/.exec(String(error.stderr ?? ''))?.[1] ?? 'AwsCliFailure'}`); }
}
let invocationIndex = 0;
async function invoke(functionName, event) {
  const output = join(directory, `invoke-${++invocationIndex}.json`);
  const metadata = await cli('lambda', 'invoke', ['--function-name', functionName, '--cli-binary-format', 'raw-in-base64-out', '--payload', JSON.stringify(event), output]);
  const result = JSON.parse(await readFile(output, 'utf8'));
  if (metadata.FunctionError) throw new Error(`Operator function failed (${functionName === RUNNER ? 'runner' : 'absence helper'}); inspect the saved response.`);
  return result;
}
async function api(path, method = 'GET', body, allowed = [200]) {
  const response = await invoke(RUNNER, { path, method, ...(body === undefined ? {} : { body }) });
  if (!Number.isInteger(response.statusCode) || !response.body || typeof response.body !== 'object' || Array.isArray(response.body)) throw new Error('Invalid runner response envelope.');
  if (!allowed.includes(response.statusCode)) throw new Error(`Runner ${method} returned ${response.statusCode}: ${safe(response.body.error ?? 'unexpected response')}`);
  return response;
}
async function record(name, details = {}) {
  report.checks.push({ name, passed: true, observedAt: new Date().toISOString(), ...details });
  await save();
  console.log(JSON.stringify({ check: name, passed: true, ...details }));
}
async function poll(name, call, done, timeoutMs = 10 * 60_000) {
  const started = Date.now();
  let announced = 0;
  while (Date.now() - started < timeoutMs) {
    const value = await call();
    if (done(value)) return value;
    if (Date.now() - announced > 45_000) { console.log(JSON.stringify({ waitingFor: name, elapsedSeconds: Math.round((Date.now() - started) / 1000) })); announced = Date.now(); }
    await sleep(10_000);
  }
  throw new Error(`Timed out waiting for ${name}.`);
}
function commandId(name) {
  const bytes = createHash('sha256').update(runId + ':' + name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
async function command(labId, name, text = commands[name]) {
  const id = commandId(name);
  await api(`${labId}/commands`, 'POST', { id, command: text });
  const result = await poll(name, async () => (await api(`${labId}/commands/${id}`)).body, (value) => ['completed', 'failed'].includes(value.status), 8 * 60_000);
  report.commands.push({ name, labId, ...result, stdout: safe(result.stdout), stderr: safe(result.stderr) });
  await save();
  if (result.status !== 'completed' || result.exitCode !== 0 || result.truncated) throw new Error(`${name} failed or lost output: status=${result.status}, exit=${result.exitCode}, truncated=${result.truncated}. Inspect the retained command evidence.`);
  await record(name, { commandId: id, exitCode: result.exitCode });
  return result;
}
async function start(labId, durationMinutes) {
  const expiresAt = new Date(Date.now() + durationMinutes * 60_000).toISOString();
  // Track the intended unique lease before dispatch: a timed-out response may
  // still have provisioned it, and DELETE-before-create is a safe tombstone.
  created.add(labId);
  report.leases.push({ labId, expiresAt, dispatchedAt: new Date().toISOString() }); await save();
  await api(labId, 'PUT', { templateId: TEMPLATE, expiresAt });
  const ready = await poll('lab ready', async () => (await api(labId)).body, (value) => ['ready', 'failed', 'stopped', 'expired'].includes(value.status));
  if (ready.status !== 'ready') throw new Error(`Synthetic lab failed to become ready (${ready.status}).`);
  await record(`${labId} ready`);
  return expiresAt;
}
async function absence(labId) {
  const result = await invoke(HELPER, { operation: 'verify-lab-absence', labId });
  if (result.accountId !== SANDBOX || result.labId !== labId || typeof result.allAbsent !== 'boolean') throw new Error('Independent absence helper response is invalid.');
  return result;
}
async function stopped(labId, close = true) {
  if (close) await api(labId, 'DELETE');
  const receipt = await poll('cleanup receipt', async () => (await api(labId)).body, (value) => value.cleanupComplete === true);
  const observed = await absence(labId);
  if (!observed.allAbsent) throw new Error('Cleanup receipt conflicts with independent resource inventory.');
  if (!receipt.snapshot?.capturedAt || !receipt.snapshot?.content || receipt.snapshot.truncated) throw new Error('Final independent snapshot is missing or truncated.');
  report.leases.find((value) => value.labId === labId).cleanup = { receipt, observed };
  await record(`${labId} cleanup and independent absence`);
}

try {
  const identity = await cli('sts', 'get-caller-identity');
  if (identity.Account !== MANAGEMENT) throw new Error('Wrong management account; no lab operation attempted.');
  const health = await invoke(RUNNER, { operation: 'health' });
  if (health.statusCode !== 200 || health.body?.ready !== true || health.body?.enabled !== true || health.body?.templateId !== TEMPLATE) throw new Error('Installed AWS runtime is not enabled and ready.');
  // Verify the independent helper contract before spending/provisioning resources.
  if (!(await absence(normal)).allAbsent) throw new Error('The chosen synthetic ID already has cloud resources.');
  await record('controller and independent helper ready');
  await start(normal, 60);
  const capacity = await api(other, 'PUT', { templateId: TEMPLATE, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }, [429]);
  await record('second simultaneous account lease denied', { statusCode: capacity.statusCode });
  await command(normal, 'initial');
  await command(normal, 'performanceBaseline');
  const original = await command(normal, 'idempotency');
  const duplicate = (await api(`${normal}/commands`, 'POST', { id: commandId('idempotency'), command: commands.idempotency })).body;
  if (duplicate.id !== original.id || duplicate.stdout !== original.stdout || duplicate.finishedAt !== original.finishedAt) throw new Error('Duplicate command did not preserve original evidence.');
  await api(`${normal}/commands`, 'POST', { id: commandId('idempotency'), command: 'echo changed' }, [409]);
  await record('duplicate request reused; changed payload denied');
  await command(normal, 'counter');
  await command(normal, 'boundary');
  await command(normal, 'repair');
  await command(normal, 'failedGate');
  for (const name of ['release', 'functional']) await command(normal, name);
  // Establish a healthy alarm state before injecting the fault, so an old
  // bootstrap error cannot be mistaken for this test's metric-driven breach.
  await command(normal, 'alarmPrimed', commands.alarmRecovery);
  for (const name of ['alarmBreach', 'alarmRecovery', 'rollback', 'final']) await command(normal, name);
  await stopped(normal);
  const afterClose = await api(`${normal}/commands`, 'POST', { id: commandId('closed'), command: 'echo must-not-run' }, [409]);
  await record('closed lease denies new work', { statusCode: afterClose.statusCode });
  const expiresAt = await start(expiry, 6);
  await command(expiry, 'expiryMarker');
  report.expiryObservationClosedAt = new Date().toISOString(); await save();
  // No controller GET/DELETE/reconcile occurs during the deadline window.
  while (Date.now() < Date.parse(expiresAt) + 90_000) {
    console.log(JSON.stringify({ waitingFor: 'independent deadline cleanup', deadline: expiresAt }));
    await sleep(Math.min(30_000, Date.parse(expiresAt) + 90_000 - Date.now()));
  }
  const independent = await poll('automatic expiry resource absence', () => absence(expiry), (value) => value.allAbsent, 4 * 60_000);
  report.expiryIndependentBeforeControllerRead = independent; await save();
  await record('automatic expiry independent of browser/controller reads');
  await stopped(expiry, false);
  report.passed = true;
} catch (error) {
  report.failure = safe(error.message);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  for (const labId of created) {
    const entry = report.leases.find((value) => value.labId === labId);
    if (entry?.cleanup) continue;
    try { await stopped(labId); }
    catch (error) { report.cleanupFailure ??= []; report.cleanupFailure.push({ labId, error: safe(error.message) }); report.passed = false; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ passed: report.passed, report: reportPath, checks: report.checks.length, cleanupFailures: report.cleanupFailure?.length ?? 0 }));
}
