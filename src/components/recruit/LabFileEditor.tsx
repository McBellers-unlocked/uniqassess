"use client";

import { useEffect, useRef, useState } from "react";
import { fileCommandPrefix, LAB_FILE_MAX_BYTES, parseLabFileResult, type LabFileRequest } from "@/lib/recruit/lab-files";

interface RecordedCommand { command: string; status: string; stdout: string; stderr: string; exitCode: number | null; truncated: boolean }
const button = "rounded-md border border-uq-strong px-3 py-1.5 text-xs text-uq-2 hover:bg-uq-elev2 disabled:opacity-50 disabled:cursor-not-allowed";

type OpenFile = { path: string; content: string; version: string | null };
type FileAttempt = { file: LabFileRequest; id: string; retry: boolean };

export default function LabFileEditor({ commands, canRun, closed, enqueue, sessionId }: {
  commands: RecordedCommand[];
  canRun: boolean;
  closed: boolean;
  sessionId: string;
  enqueue: (file: LabFileRequest, requestId: string) => Promise<"accepted" | "rejected" | "unknown">;
}) {
  const storageKey = `lab-editor:${sessionId}`;
  const [draft] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { opened: OpenFile | null; content: string; attempt: FileAttempt | null } | null; }
    catch { return null; }
  });
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState(draft?.opened?.path ?? "");
  const [opened, setOpened] = useState<OpenFile | null>(draft?.opened ?? null);
  const [content, setContent] = useState(draft?.content ?? "");
  const [message, setMessage] = useState(draft?.opened ? `Restored editor text for ${draft.opened.path}. Save any unsaved edits to the lab before using them.` : "List files or enter a project file path to open it.");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<FileAttempt | null>(draft?.attempt ? { ...draft.attempt, retry: true } : null);
  const handled = useRef<string | null>(null);
  const inFlight = useRef(false);
  const dirty = opened !== null && (opened.version === null || content !== opened.content);
  const byteLength = new TextEncoder().encode(content).length;

  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify({ opened, content, attempt })); }
    catch { setError("This browser could not keep a draft. Save your file before switching tasks or leaving this page."); }
  }, [storageKey, opened, content, attempt]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!attempt || handled.current === attempt.id) return;
    const result = commands.find((entry) => entry.command.startsWith(fileCommandPrefix(attempt.id)));
    if (!result || result.status === "queued" || result.status === "running") return;
    handled.current = attempt.id;
    setAttempt(null);
    try {
      if (result.truncated) throw new Error("The file output was truncated. Your editor text has been kept.");
      const file = parseLabFileResult(result.stdout);
      if (result.exitCode !== 0) throw new Error(result.stderr || "The file operation failed. Your editor text has been kept.");
      if (file.operation === "list") {
        setFiles(file.files);
        setMessage(file.truncated ? "The file list reached its search or size limit. You can also enter a path directly." : `${file.files.length} workspace files. Choose one to open.`);
      } else {
        setOpened({ path: file.path, content: file.content, version: file.version });
        setContent(file.content);
        setPath(file.path);
        setMessage(file.operation === "write" ? `Saved ${file.path} to the lab.` : `Opened ${file.path}.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file operation failed. Your editor text has been kept.");
    }
  }, [attempt, commands]);

  async function run(file: LabFileRequest, retryId?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = retryId ?? crypto.randomUUID();
    setError(null);
    setAttempt({ file, id, retry: false });
    setMessage(file.operation === "write" ? "Saving file… Wait for confirmation before running commands." : "Loading from the lab…");
    try {
      const outcome = await enqueue(file, id);
      if (outcome === "rejected") {
        setAttempt((current) => current?.id === id ? null : current);
        setError("The lab declined this operation. Check the message above. Your editor text has been kept.");
      } else if (outcome === "unknown") {
        setAttempt((current) => current?.id === id ? { ...current, retry: true } : current);
        setError("The request was not confirmed. Refresh the lab or retry this file operation. Your editor text has been kept.");
      }
    } finally { inFlight.current = false; }
  }

  function mayReplace() {
    return !dirty || window.confirm("Discard your unsaved file edits?");
  }

  return (
    <section aria-label="Lab file editor" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <p className="text-xs text-uq-3">Edit project files here, then save before running a command. Files stay in this lab until it closes. Listing, opening and saving each use one recorded run. UTF-8 text up to 16 KiB; some less compressible files may require the command console. Unsaved edits are kept in this browser tab.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={!canRun || Boolean(attempt)} onClick={() => void run({ operation: "list" })}>List files</button>
        <select aria-label="Workspace files" value="" disabled={!canRun || Boolean(attempt) || !files.length} onChange={(event) => { if (event.target.value && mayReplace()) void run({ operation: "read", path: event.target.value }); }} className="min-w-0 flex-1 rounded-md border border-uq-strong bg-uq-bg2 p-1.5 text-xs text-uq">
          <option value="">Choose a file…</option>
          {files.map((file) => <option key={file} value={file}>{file}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-uq-2">Workspace path
          <input aria-label="Workspace path" value={path} onChange={(event) => setPath(event.target.value)} disabled={Boolean(attempt)} placeholder="main.tf or manifests/checkout.yaml" spellCheck={false} className="mt-1 block w-full rounded-md border border-uq-strong bg-uq-bg2 px-2 py-1.5 font-mono text-xs text-uq" />
        </label>
        <button type="button" className={button} disabled={!canRun || Boolean(attempt) || !path.trim()} onClick={() => { if (mayReplace()) void run({ operation: "read", path: path.trim() }); }}>Open file</button>
        <button type="button" className={button} disabled={!canRun || Boolean(attempt) || !path.trim()} onClick={() => {
          if (!mayReplace()) return;
          setOpened({ path: path.trim(), content: "", version: null }); setContent(""); setError(null);
          setMessage("New file. Saving will create it only if that path does not already exist.");
        }}>New file</button>
      </div>
      {error && <p role="alert" className="text-xs text-[color:var(--uq-danger-text)]">{error}</p>}
      <div role="status" className="text-xs text-uq-3">{message}</div>
      {attempt?.retry && <button type="button" className={`${button} self-start`} disabled={!canRun} onClick={() => void run(attempt.file, attempt.id)}>Retry file operation</button>}
      {opened && <>
        <label htmlFor="lab-file-content" className="text-xs font-medium text-uq">{opened.path}{dirty ? " · Unsaved changes" : " · Saved"}</label>
        <textarea id="lab-file-content" aria-label={`Edit ${opened.path}`} value={content} onChange={(event) => setContent(event.target.value)} readOnly={closed || Boolean(attempt)} spellCheck={false} autoCapitalize="none" autoCorrect="off" wrap="off"
          className="min-h-40 flex-1 resize-none overflow-auto rounded-lg border border-uq-strong bg-uq-bg2 p-3 font-mono text-xs leading-relaxed text-uq focus:border-uq-accent focus:outline-none" />
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <span className={`text-xs ${byteLength > LAB_FILE_MAX_BYTES ? "text-[color:var(--uq-danger-text)]" : "text-uq-3"}`}>{byteLength.toLocaleString()} / {LAB_FILE_MAX_BYTES.toLocaleString()} bytes</span>
          <button type="button" className={`${button} bg-uq-accent text-[color:var(--uq-text-on-accent)]`} disabled={!canRun || Boolean(attempt) || !dirty || byteLength > LAB_FILE_MAX_BYTES} onClick={() => void run({ operation: "write", path: opened.path, content, version: opened.version })}>Save file</button>
        </div>
      </>}
    </section>
  );
}
