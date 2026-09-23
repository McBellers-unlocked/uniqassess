/** Add labelled, sample-level timing to a finished synthetic acceptance report. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const path = resolve(process.argv[2] ?? '');
const base = resolve('.deployment') + sep;
if (process.argv.length !== 3 || !path.startsWith(base) || !path.endsWith(`${sep}acceptance.json`)) throw new Error('Provide an acceptance.json inside this workspace .deployment directory.');
const report = JSON.parse(await readFile(path, 'utf8'));
if (!report.finishedAt || !/^[a-f0-9]{16}$/.test(report.runId) || report.sandboxAccount !== '689324611808') throw new Error('Expected a finished synthetic AWS acceptance report.');
const elapsed = (start, end) => Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end))
  ? Math.round((Date.parse(end) - Date.parse(start)) / 1000 * 1000) / 1000 : null;
const timing = {
  interpretation: 'Individual operator observations only. Ready includes provisioning, CodeBuild bootstrap and polling; job wall time runs from the controller dispatch timestamp to the observed terminal result and includes container/tool startup and polling. It is not the shell-only runtime or a percentile/SLO.',
  sampleRuns: 1,
  totalObservedSeconds: elapsed(report.startedAt, report.finishedAt),
  leases: report.leases.map((lease) => {
    const minutes = lease.labId.startsWith('cawsverifyexp') ? 6 : 60;
    const dispatchedAt = lease.dispatchedAt ?? new Date(Date.parse(lease.expiresAt) - minutes * 60_000).toISOString();
    const readyAt = report.checks.find((check) => check.name === `${lease.labId} ready`)?.observedAt;
    return { labId: lease.labId, dispatchedAt, dispatchTimeSource: lease.dispatchedAt ? 'recorded' : `derived from fixed ${minutes}-minute requested lease deadline`,
      readyObservedAt: readyAt ?? null, readySeconds: readyAt ? elapsed(dispatchedAt, readyAt) : null,
      deadline: lease.expiresAt, independentCleanupObservedAt: lease.cleanup?.observed?.observedAt ?? null };
  }),
  jobs: report.commands.map((command) => ({ name: command.name, labId: command.labId, commandId: command.id,
    startedAt: command.startedAt ?? null, finishedAt: command.finishedAt ?? null,
    wallSeconds: elapsed(command.startedAt, command.finishedAt), status: command.status, exitCode: command.exitCode,
  })),
};
report.timing = timing;
await writeFile(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, report: path, timing }, null, 2));
