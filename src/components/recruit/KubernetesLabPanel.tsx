"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LAB_COMMAND_MAX_CHARS, LAB_MAX_COMMANDS } from "@/lib/recruit/kubernetes-lab-config";

interface LabCommand {
  id: string;
  command: string;
  status: "queued" | "running" | "completed" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  createdAt: string;
  finishedAt: string | null;
}

interface LabState {
  available: boolean;
  session: {
    id: string;
    status: "starting" | "ready" | "failed" | "stopped" | "expired";
    expiresAt: string;
  } | null;
  commands: LabCommand[];
  error?: string;
}

const buttonClass = "rounded-md border border-uq-strong px-3 py-1.5 text-xs font-medium text-uq-2 transition-colors hover:border-uq-accent hover:bg-uq-elev2 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]";

/** Candidate commands go directly to the lab API and are retained as evidence. */
export default function KubernetesLabPanel({
  token, taskNumber, title, instructions, disabled,
}: {
  token: string;
  taskNumber: number;
  title: string;
  instructions: string;
  disabled: boolean;
}) {
  const [state, setState] = useState<LabState | null>(null);
  const [command, setCommand] = useState("");
  const [pending, setPending] = useState<"load" | "start" | "command" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [accessLocked, setAccessLocked] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);
  const pendingMutation = useRef(false);
  // A retry after a lost response must not execute the same command twice.
  const commandAttempt = useRef<{ command: string; requestId: string } | null>(null);

  const request = useCallback(async (action?: "start" | "command", submittedCommand?: string) => {
    if (pendingMutation.current) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const sequence = ++requestNumber.current;
    pendingMutation.current = Boolean(action);
    setPending(action ?? "load");
    setError(null);

    if (action === "command" && commandAttempt.current?.command !== submittedCommand) {
      commandAttempt.current = { command: submittedCommand ?? "", requestId: crypto.randomUUID() };
    }

    try {
      const query = new URLSearchParams({ token, taskNumber: String(taskNumber) });
      const response = await fetch(action ? "/api/assess/lab" : `/api/assess/lab?${query}`, {
        method: action ? "POST" : "GET",
        cache: "no-store",
        signal: abort.signal,
        ...(action ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, taskNumber, action, ...(action === "command" ? {
            command: submittedCommand,
            requestId: commandAttempt.current?.requestId,
          } : {}) }),
        } : {}),
      });
      const body = await response.json();
      if (sequence !== requestNumber.current || abort.signal.aborted) return;
      if (typeof body.available === "boolean" && Array.isArray(body.commands)) {
        setState(body as LabState);
      }
      if (response.status === 503) {
        setState((previous) => ({ available: false, session: previous?.session ?? null, commands: previous?.commands ?? [] }));
      }
      if (response.status === 403) setAccessLocked(true);
      if (!response.ok) {
        const fallback = response.status === 409
          ? "The lab is preparing or a command is still running. Refresh its status before trying again."
          : response.status === 503
            ? "The practical lab is temporarily unavailable. Contact your assessment organiser and continue with the task brief."
            : response.status === 403
              ? "This assessment is no longer active or your access has expired. Your recorded commands are retained."
              : "The lab could not be reached. Refresh its status before trying again.";
        setError(typeof body.error === "string" ? body.error : fallback);
        return;
      }
      if (action === "command") {
        commandAttempt.current = null;
        setCommand((value) => value === submittedCommand ? "" : value);
      }
      if (body.error) setError(body.error);
    } catch (caught) {
      if (abort.signal.aborted || sequence !== requestNumber.current) return;
      setError(caught instanceof SyntaxError
        ? "The lab returned an unreadable response. Refresh its status before trying again."
        : "The connection to the lab was interrupted. Refresh to check whether your command was recorded; retrying the same command will not run it twice.");
    } finally {
      if (sequence === requestNumber.current) {
        pendingMutation.current = false;
        if (!abort.signal.aborted) setPending(null);
      }
    }
  }, [token, taskNumber]);

  useEffect(() => {
    void request();
    return () => {
      controller.current?.abort();
      requestNumber.current += 1;
      pendingMutation.current = false;
    };
  }, [request]);

  const session = state?.session;
  const commands = state?.commands ?? [];
  const commandRunning = commands.some((entry) => entry.status === "queued" || entry.status === "running");
  const expiresAt = session ? new Date(session.expiresAt).getTime() : null;
  const expired = session?.status === "expired" || (expiresAt !== null && expiresAt <= now);
  const closed = disabled || accessLocked || expired || session?.status === "stopped";
  const shouldPoll = state?.available && !closed && (session?.status === "starting" || commandRunning);

  useEffect(() => {
    if (!shouldPoll || pending) return;
    const timer = setTimeout(() => { void request(); }, 3000);
    return () => clearTimeout(timer);
  }, [shouldPoll, pending, request]);

  useEffect(() => {
    if (!session || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session, expired]);

  const canRun = state?.available && session?.status === "ready" && !closed && !commandRunning && !pending && commands.length < LAB_MAX_COMMANDS;
  const statusLabel = expired ? "Expired" : !state ? "Checking lab" : !state.available ? "Unavailable" : !session ? "Not started" : {
    starting: "Preparing lab", ready: "Ready", failed: "Lab failed", stopped: "Closed", expired: "Expired",
  }[session.status];

  return (
    <section aria-label="Kubernetes practical lab" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-uq-elev1">
      <div className="space-y-3 border-b border-uq-faint px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Practical lab · Task {taskNumber}</div>
            <h2 className="mt-1 text-sm font-semibold text-uq">{title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <span role="status" className="rounded-full bg-uq-elev2 px-2.5 py-1 text-xs text-uq-2">{statusLabel}</span>
            <button type="button" onClick={() => void request()} disabled={Boolean(pending)} className={buttonClass}>{pending === "load" ? "Refreshing…" : "Refresh"}</button>
          </div>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-uq-2">{instructions}</p>
        <p className="text-xs leading-relaxed text-uq-3">Your commands, output and exit status are recorded for assessment. The environment expires automatically{session ? ` at ${new Date(session.expiresAt).toLocaleTimeString()}` : " when its allotted time ends"}. Include your diagnosis and verification in your written deliverable.</p>
        {error && <div role="alert" className="rounded-md border border-[color:var(--uq-danger-line)] bg-[color:var(--uq-danger-soft)] px-3 py-2 text-sm text-[color:var(--uq-danger-text)]">{error}</div>}
        {!state && !pending && <p className="text-sm text-uq-2">Refresh to check whether the lab is available. Your work in the written deliverable is saved separately.</p>}
        {state && !state.available && <p className="text-sm text-uq-2">The practical lab is unavailable. Contact your assessment organiser and continue with the task brief. Previously recorded commands remain visible below.</p>}
        {closed && <p className="text-sm text-uq-2">{expired ? "This environment has expired." : "Lab commands are locked because this assessment or environment has closed."} Your recorded work remains available.</p>}
        {session?.status === "failed" && <p className="text-sm text-uq-2">The environment could not be prepared. Contact your assessment organiser. Your recorded work is retained.</p>}
        {session?.status === "starting" && !closed && <p role="status" className="text-sm text-uq-2">Preparing your Kubernetes environment. Its status will update automatically.</p>}
        {state?.available && !session && !closed && <button type="button" onClick={() => void request("start")} disabled={Boolean(pending)} className={buttonClass}>{pending === "start" ? "Starting lab…" : "Start Kubernetes lab"}</button>}
      </div>

      {session && (
        <div className="space-y-3 border-b border-uq-faint px-4 py-4">
          <label htmlFor={`lab-command-${taskNumber}`} className="block text-sm font-medium text-uq">Command</label>
          <p id={`lab-help-${taskNumber}`} className="text-xs leading-relaxed text-uq-3">Run non-interactive shell commands with kubectl. Each run starts in <code>/workspace</code> and has a 20-second limit. A command that times out closes the lab; use short checks such as <code>kubectl rollout status deployment/checkout --timeout=10s</code>. Files and cluster changes persist between runs; the shell directory and variables do not. Use a single run for commands that need to share variables.</p>
          <textarea
            id={`lab-command-${taskNumber}`}
            aria-describedby={`lab-help-${taskNumber}`}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            disabled={closed || session.status === "failed"}
            maxLength={LAB_COMMAND_MAX_CHARS}
            rows={4}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="kubectl get pods"
            className="block w-full resize-y rounded-lg border border-uq-strong bg-uq-bg2 px-3 py-2 font-mono text-xs leading-relaxed text-uq placeholder:text-uq-3 focus:border-uq-accent focus:outline-none disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-uq-3">{command.length.toLocaleString()} / {LAB_COMMAND_MAX_CHARS.toLocaleString()} characters · {commands.length} / {LAB_MAX_COMMANDS} runs</span>
            <button type="button" onClick={() => { if (canRun && command.trim()) void request("command", command); }} disabled={!canRun || !command.trim()} className={`${buttonClass} bg-uq-accent text-[color:var(--uq-text-on-accent)] hover:bg-uq-accent-hover`}>
              {pending === "command" ? "Sending command…" : commandRunning ? "Command running…" : "Run command"}
            </button>
          </div>
          {commands.length >= LAB_MAX_COMMANDS && <p className="text-xs text-uq-2">You have reached the limit of {LAB_MAX_COMMANDS} commands. You can review your recorded output and finish your written deliverable.</p>}
        </div>
      )}

      <div className="space-y-3 px-4 py-4">
        <h3 className="text-sm font-semibold text-uq">Recorded commands</h3>
        {!commands.length && <p className="text-xs text-uq-3">Commands and their output will appear here after you run them.</p>}
        {commands.map((entry) => (
          <article key={entry.id} className="overflow-hidden rounded-lg border border-uq-strong bg-uq-bg2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-uq-faint px-3 py-2 text-xs text-uq-3">
              <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleTimeString()}</time>
              <span>{entry.status}{entry.exitCode !== null && entry.exitCode !== undefined ? ` · exit ${entry.exitCode}` : ""}</span>
            </div>
            <pre className="whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-relaxed text-uq">$ {entry.command}</pre>
            {entry.stdout && <div className="border-t border-uq-faint px-3 py-2"><span className="text-[10px] uppercase text-uq-3">Output</span><pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-uq-2">{entry.stdout}</pre></div>}
            {entry.stderr && <div className="border-t border-uq-faint px-3 py-2"><span className="text-[10px] uppercase text-uq-3">Standard error</span><pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[color:var(--uq-danger-text)]">{entry.stderr}</pre></div>}
            {(entry.status === "queued" || entry.status === "running") && <p className="border-t border-uq-faint px-3 py-2 text-xs text-uq-3">Waiting for the command result…</p>}
            {entry.truncated && <p className="border-t border-uq-faint px-3 py-2 text-xs text-uq-3">Output reached the recording limit and was truncated. Use a more specific command to inspect the relevant result.</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
