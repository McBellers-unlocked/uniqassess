export interface LabCommandEvidence {
  id: string;
  command: string;
  status: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LabSessionEvidence {
  id: string;
  taskNumber: number;
  templateId: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  snapshot?: { capturedAt: string; content: string; truncated: boolean } | null;
  cleanupCompletedAt?: string | null;
  commands: LabCommandEvidence[];
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/** Terminal evidence is always rendered as text, never as HTML or Markdown. */
export default function LabEvidence({
  sessions,
  taskNumber,
}: {
  sessions: LabSessionEvidence[];
  taskNumber: number;
}) {
  const taskSessions = sessions
    .filter((session) => session.taskNumber === taskNumber)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <section className="space-y-4 rounded-xl border border-uq bg-uq-elev1 p-5 shadow-uq-glass">
      <div>
        <h2 className="text-base font-semibold text-uq">Kubernetes lab evidence · Task {taskNumber}</h2>
        <p className="mt-1 text-xs leading-relaxed text-uq-3">Recorded candidate commands and observed runtime output. Review these alongside the written response and rubric; this panel does not assign scores.</p>
      </div>
      {taskSessions.length === 0 ? (
        <p className="text-sm italic text-uq-3">No lab session was started for this task.</p>
      ) : taskSessions.map((session, sessionIndex) => (
        <section key={session.id} className="space-y-3 border-t border-uq-faint pt-4">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-uq">Session {sessionIndex + 1}</h3>
              <span className="rounded-full border border-uq px-2 py-0.5 text-xs capitalize text-uq-2">{statusLabel(session.status)}</span>
            </div>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-uq-3 sm:grid-cols-2">
              <div><dt className="inline font-medium">Template: </dt><dd className="inline break-all">{session.templateId}</dd></div>
              <div><dt className="inline font-medium">Created: </dt><dd className="inline"><time dateTime={session.createdAt}>{timestamp(session.createdAt)}</time></dd></div>
              <div><dt className="inline font-medium">Expiry: </dt><dd className="inline"><time dateTime={session.expiresAt}>{timestamp(session.expiresAt)}</time></dd></div>
              <div><dt className="inline font-medium">Last updated: </dt><dd className="inline"><time dateTime={session.updatedAt}>{timestamp(session.updatedAt)}</time></dd></div>
            </dl>
            {session.error && <p className="mt-2 text-sm text-[color:var(--uq-danger-text)]">{session.error}</p>}
            {session.status.toLowerCase() === "expired" && <p className="mt-2 text-xs text-uq-3">The lab expired. The retained record is shown below.</p>}
            {session.snapshot && <div className="mt-3 space-y-2"><p className="text-xs text-uq-3">Final resource state captured by the lab service at {timestamp(session.snapshot.capturedAt)}. This is observed state, not an automatic score.</p><Output label="Final Kubernetes state" value={session.snapshot.content || "The final resource state was unavailable."} />{session.snapshot.truncated && <p className="text-xs text-uq-3">The resource snapshot reached its retention limit and was truncated.</p>}</div>}
            {!session.snapshot && ["stopped", "expired", "failed"].includes(session.status) && <p className="mt-2 text-xs text-uq-3">Final resource state has not yet been collected. Refresh after cleanup completes.</p>}
            {session.cleanupCompletedAt && <p className="mt-2 text-xs text-uq-3">Environment removal confirmed at {timestamp(session.cleanupCompletedAt)}.</p>}
          </div>
          {session.commands.length === 0 ? (
            <p className="text-sm italic text-uq-3">No commands were recorded in this session.</p>
          ) : (
            <ol className="space-y-3">
              {session.commands.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((command, commandIndex) => (
                <li key={command.id} className="overflow-hidden rounded-lg border border-uq bg-uq-elev2">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-uq-faint px-3 py-2 text-xs text-uq-3">
                    <span>Command {commandIndex + 1} · <span className="capitalize">{statusLabel(command.status)}</span>{command.exitCode !== null ? ` · Exit code ${command.exitCode}` : " · No exit code recorded"}</span>
                    <time dateTime={command.createdAt}>{timestamp(command.createdAt)}</time>
                  </div>
                  <div className="space-y-3 p-3">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-uq"><code>{command.command}</code></pre>
                    {(command.startedAt || command.finishedAt) && (
                      <p className="text-[11px] text-uq-3">{command.startedAt ? `Started ${timestamp(command.startedAt)}` : "Start time unavailable"}{command.finishedAt ? ` · Finished ${timestamp(command.finishedAt)}` : " · No finish time recorded"}</p>
                    )}
                    {command.stdout && <Output label="Standard output" value={command.stdout} />}
                    {command.stderr && <Output label="Standard error" value={command.stderr} />}
                    {!command.stdout && !command.stderr && <p className="text-xs italic text-uq-3">No output was recorded.</p>}
                    {command.truncated && <p className="text-xs text-[color:var(--uq-warning-text)]">Output exceeded the retention limit and was truncated.</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </section>
  );
}

function Output({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-uq-3">{label}</h4>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-uq-faint bg-uq-bg2 p-3 font-mono text-xs leading-relaxed text-uq-2"><code>{value}</code></pre>
    </div>
  );
}
