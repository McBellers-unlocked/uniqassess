/** Operator kill switch. Secret values remain in memory and are never logged. */
import { execFileSync } from 'node:child_process';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

async function main() {
  const operation = process.argv[2];
  if (!['enable', 'disable'].includes(operation)) throw new Error('Use enable or disable.');
  const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (identity.Account !== '891612540396') throw new Error('Unexpected AWS account.');
  const client = new SecretsManagerClient({ region: 'eu-west-1' });
  try {
    const SecretId = 'uniqassess/labs/pilot/runner';
    const data = await client.send(new GetSecretValueCommand({ SecretId }));
    const configuration = JSON.parse(data.SecretString);
    if (configuration.url !== 'https://lab-runner.uniqassess.org' || typeof configuration.key !== 'string' || configuration.key.length < 32) throw new Error('Unexpected pilot runner configuration.');
    await client.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify({ ...configuration, enabled: operation === 'enable' }) }));
    console.log(JSON.stringify({ candidateLabsEnabled: operation === 'enable', cacheRefreshWithinSeconds: 60, cleanupRemainsEnabled: true }));
  } finally { client.destroy(); }
}
main().catch(() => { console.error('Pilot switch failed; inspect operator access and configuration without logging secret values.'); process.exitCode = 1; });
