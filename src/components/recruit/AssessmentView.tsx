"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import LiveEventsOverlay from "./LiveEventsOverlay";
import { AssessmentModeBadge } from "./AssessmentModeBadge";
import KnowledgeEvidenceCard from "./KnowledgeEvidenceCard";
import CandidateEvidenceBoard, { type EvidenceBoardItem } from "./CandidateEvidenceBoard";
import ToolUseDeclaration, { type ToolDeclarationValue } from "./ToolUseDeclaration";
import KubernetesLabPanel from "./KubernetesLabPanel";
import type { KnowledgeSystemResponse } from "@/lib/recruit/knowledge-response-schema";

interface TaskCfg {
  taskId: string | null;
  number: number;
  title: string;
  briefMarkdown: string;
  exhibitTitle: string;
  exhibitHtml: string;
  exhibitSourceId: string;
  totalMarks: number;
  codeExecutionEnabled: boolean;
  kubernetesLab?: { templateId: string; title: string; instructions: string } | null;
  deliverableLabel: string;
  deliverablePlaceholder: string;
}

interface Interaction {
  id: string;
  sequenceNum: number;
  taskNumber: number;
  timestamp: string;
  actor: string;
  content: string;
  structuredPayload?: KnowledgeSystemResponse | null;
  schemaVersion?: string | null;
  metadata?: {
    codeExecutionEnabled?: boolean;
    codeExecutionUsed?: boolean;
    codeExecutionStatus?: "queued" | "running" | "completed" | "failed";
    codeExecutionError?: string;
    responseStatus?: "queued" | "running" | "completed" | "failed";
    responseKind?: "knowledge" | "code_execution";
    responseError?: string;
    requestInteractionId?: string;
  } | null;
}

interface ResponseRow {
  taskNumber: number;
  content: string;
  wordCount: number;
  updatedAt: string | null;
  sentAt?: string | null;
}

export interface AssessmentInitial {
  stage: string;
  assessment: { id: string; title: string; totalMinutes: number; closeDate: string; assessmentMode: "EVIDENCE" | "COPILOT" | "OPEN_AGENT"; defenceEnabled: boolean; defenceMinutes: number };
  scenario: {
    title: string; organisation: string; positionTitle: string; taskCount: number;
    tasks: TaskCfg[];
    // In-assessment AI branding; null/absent → IDSC defaults (existing scenarios).
    assistantName?: string | null;
    assistantShortName?: string | null;
    assessmentMode?: "EVIDENCE" | "COPILOT" | "OPEN_AGENT";
  };
  candidate: { anonymousId: string; startedAt: string; deadline: string; submittedAt: string | null; workLockedAt?: string | null };
  responses: ResponseRow[];
  interactions: Interaction[];
  evidenceBoard: EvidenceBoardItem[];
}

const SAVE_DEBOUNCE_MS = 1500;
const FORCE_SAVE_INTERVAL_MS = 30_000;
// Mirrors the server-side limit in src/app/api/assess/chat/route.ts so the
// textarea refuses extra input rather than letting candidates hit a 400.
const CHAT_MAX_CHARS = 4000;

function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (typeof window === "undefined") return html.replace(/<[^>]*>/g, " ");
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent || "";
}

function wordCount(content: string): number {
  const text = htmlToPlainText(content).trim();
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

// The task brief is an in-world email — its markdown opens with
// **From:** / **To:** / **Subject:** lines. Parse those into a structured
// header so we can render a real email message view; fall back gracefully
// (whole markdown as body) when a brief doesn't follow the convention.
const BRIEF_STOPWORDS = new Set(["of", "and", "the", "for", "to", "a", "an", "in", "on", "you"]);
function initialsFrom(name: string): string {
  const words = name.split(/\s+/).filter((w) => /[a-z]/i.test(w[0] ?? "") && !BRIEF_STOPWORDS.has(w.toLowerCase()));
  if (words.length === 0) return name.replace(/[^a-z]/gi, "").slice(0, 2).toUpperCase() || "··";
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}
function parseBriefEmail(md: string): { from: string | null; to: string | null; cc: string | null; subject: string | null; sent: string | null; body: string } {
  const out: { from: string | null; to: string | null; cc: string | null; subject: string | null; sent: string | null; body: string } = {
    from: null, to: null, cc: null, subject: null, sent: null, body: md,
  };
  const lines = md.split(/\r?\n/);
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") {
      consumed = i + 1;
      if (out.from || out.to || out.cc || out.subject || out.sent) break; // blank line ends the header block
      continue;
    }
    const m = line.match(/^\*\*\s*(From|To|Cc|Subject|Sent|Date)\s*:\*\*\s*(.*)$/i);
    if (!m) break; // first non-meta, non-blank line — body starts here
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "from") out.from = val;
    else if (key === "to") out.to = val;
    else if (key === "cc") out.cc = val;
    else if (key === "subject") out.subject = val;
    else out.sent = val; // "Sent" or "Date"
    consumed = i + 1;
  }
  if (out.from || out.to || out.subject) out.body = lines.slice(consumed).join("\n").trim();
  return out;
}

export default function AssessmentView({
  token, initial, onReload,
}: {
  token: string;
  initial: AssessmentInitial;
  onReload: () => Promise<void> | void;
}) {
  const tasks = initial.scenario.tasks;
  const [activeTask, setActiveTask] = useState<number>(1);
  const activeTaskCfg = tasks.find((t) => t.number === activeTask) ?? tasks[0];
  const [workViews, setWorkViews] = useState<Record<number, "deliverable" | "lab">>({});
  const labOpen = Boolean(activeTaskCfg.kubernetesLab) && workViews[activeTask] === "lab";

  // In-assessment AI branding. Falls back to the IDSC defaults so the
  // existing built-ins (FAM/CSO/APLO) render exactly as before; scenarios set
  // in a different organisation (e.g. IPAC) carry their own brand.
  const assistantName = initial.scenario.assistantName || "IDSC Knowledge System";
  const assistantShort = initial.scenario.assistantShortName || "IDSC";

  // Per-task chat input + memo (drafts in client state, autosaved to server)
  const [chatInputs, setChatInputs] = useState<Record<number, string>>({ 1: "", 2: "" });
  const [memos, setMemos] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = { 1: "", 2: "" };
    for (const r of initial.responses) m[r.taskNumber] = r.content;
    return m;
  });
  const [savedAt, setSavedAt] = useState<Record<number, string | null>>(() => {
    const s: Record<number, string | null> = { 1: null, 2: null };
    for (const r of initial.responses) s[r.taskNumber] = r.updatedAt;
    return s;
  });
  const [memoSaving, setMemoSaving] = useState<Record<number, boolean>>({ 1: false, 2: false });
  // Per-memo "sent" timestamps — the candidate's explicit finalise + advance.
  const [memoSentAt, setMemoSentAt] = useState<Record<number, string | null>>(() => {
    const s: Record<number, string | null> = {};
    for (const r of initial.responses) s[r.taskNumber] = r.sentAt ?? null;
    return s;
  });
  const [sendingMemo, setSendingMemo] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>(initial.interactions);
  const [evidenceBoard, setEvidenceBoard] = useState<EvidenceBoardItem[]>(initial.evidenceBoard ?? []);
  const [toolDeclaration, setToolDeclaration] = useState<ToolDeclarationValue>({
    tools: [],
    otherText: "",
  });

  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exhibitFullscreen, setExhibitFullscreen] = useState(false);
  const submittedRef = useRef(false);
  const chatScroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatScroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [interactions, sending, activeTask]);

  /* ------ document-first workspace ------ */
  // The memo is the permanent centre of the workspace. Sources and the AI are
  // supporting drawers: on ordinary laptop screens opening one closes the
  // other, while very wide screens can pin both. Layout preferences persist.
  const [sourceOpen, setSourceOpen] = useState(true);
  const [sourceTab, setSourceTab] = useState<"brief" | "exhibit" | "evidence">("exhibit");
  const [aiOpen, setAiOpen] = useState(false);
  const [wideWorkspace, setWideWorkspace] = useState(false);
  const [sourceWidth, setSourceWidth] = useState(410);
  const [layoutReady, setLayoutReady] = useState(false);
  const [hasUnreadAI, setHasUnreadAI] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  /* ------ work-provenance activity logger ------ */
  // Buffers paste + visibility-change events and flushes them to
  // /api/assess/activity in small batches. Content of pastes is NOT captured;
  // only character count. Surfaced to examiners during marking.
  const activityBuffer = useRef<
    Array<{ type: string; taskNumber: number | null; metadata: unknown; occurredAt: string }>
  >([]);
  const activityFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTaskRef = useRef(activeTask);
  useEffect(() => { activeTaskRef.current = activeTask; }, [activeTask]);

  const flushActivity = useCallback(async () => {
    if (activityBuffer.current.length === 0) return;
    const events = activityBuffer.current.splice(0);
    try {
      await fetch("/api/assess/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, events }),
        keepalive: true,
      });
    } catch {
      // Provenance logging is best-effort — never block the candidate.
    }
  }, [token]);

  const logActivity = useCallback((type: string, metadata?: unknown) => {
    activityBuffer.current.push({
      type,
      taskNumber: activeTaskRef.current,
      metadata: metadata ?? null,
      occurredAt: new Date().toISOString(),
    });
    if (activityFlushTimerRef.current) clearTimeout(activityFlushTimerRef.current);
    activityFlushTimerRef.current = setTimeout(() => { void flushActivity(); }, 1500);
  }, [flushActivity]);

  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        logActivity("visibility_hidden");
      } else if (hiddenAt) {
        const hiddenMs = Date.now() - hiddenAt;
        hiddenAt = 0;
        logActivity("visibility_visible", { hiddenMs });
      }
    };
    const onPageHide = () => { void flushActivity(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [logActivity, flushActivity]);

  // Hydrate and persist the document-first layout. A separate key means old
  // Exhibit/Split/Memo preferences cannot force the new workspace into a
  // cramped initial state.
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1680px)");
    const updateWide = () => setWideWorkspace(media.matches);
    updateWide();
    media.addEventListener("change", updateWide);
    let nextSourceOpen = true;
    let nextAiOpen = false;
    let nextSourceTab: "brief" | "exhibit" | "evidence" = "exhibit";
    let nextSourceWidth = 410;
    try {
      const raw = localStorage.getItem("fam-layout-v4");
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.sourceOpen === "boolean") nextSourceOpen = p.sourceOpen;
        if (p.sourceTab === "brief" || p.sourceTab === "exhibit" || p.sourceTab === "evidence") nextSourceTab = p.sourceTab;
        if (typeof p.aiOpen === "boolean") nextAiOpen = p.aiOpen;
        if (typeof p.sourceWidth === "number") nextSourceWidth = Math.max(320, Math.min(520, p.sourceWidth));
      }
    } catch { /* ignore */ }
    if (!media.matches && nextSourceOpen && nextAiOpen) nextSourceOpen = false;
    if (window.innerWidth < 1280) {
      nextSourceOpen = false;
      nextAiOpen = false;
    }
    setSourceOpen(nextSourceOpen);
    setAiOpen(nextAiOpen);
    setSourceTab(nextSourceTab);
    setSourceWidth(nextSourceWidth);
    setLayoutReady(true);
    return () => media.removeEventListener("change", updateWide);
  }, []);
  useEffect(() => {
    if (!layoutReady) return;
    try {
      localStorage.setItem("fam-layout-v4", JSON.stringify({ sourceOpen, sourceTab, aiOpen, sourceWidth }));
    } catch { /* ignore */ }
  }, [layoutReady, sourceOpen, sourceTab, aiOpen, sourceWidth]);
  useEffect(() => {
    if (!wideWorkspace && sourceOpen && aiOpen) setSourceOpen(false);
  }, [wideWorkspace, sourceOpen, aiOpen]);

  const toggleSources = useCallback(() => {
    setSourceOpen((open) => {
      const next = !open;
      if (next && !wideWorkspace) setAiOpen(false);
      return next;
    });
  }, [wideWorkspace]);

  // Expanding AI clears the unread badge and gives the question box focus.
  const toggleAi = useCallback(() => {
    setAiOpen((open) => {
      const next = !open;
      if (next && !wideWorkspace) setSourceOpen(false);
      return next;
    });
  }, [wideWorkspace]);

  const beginSourceResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const startX = event.clientX;
    const startWidth = sourceWidth;
    const onMove = (move: PointerEvent) => {
      setSourceWidth(Math.max(320, Math.min(520, startWidth + move.clientX - startX)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
  }, [sourceWidth]);

  useEffect(() => {
    if (aiOpen) {
      setHasUnreadAI(false);
      const id = window.setTimeout(() => chatInputRef.current?.focus(), 140);
      return () => window.clearTimeout(id);
    }
  }, [aiOpen]);

  // Cmd/Ctrl+J toggles the sidebar — same shortcut as the previous drawer
  // and the VSCode terminal convention.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "j") {
        ev.preventDefault();
        toggleAi();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAi]);

  // Flash the rail when an AI reply arrives while the sidebar is collapsed.
  const prevAiCountRef = useRef(initial.interactions.filter((i) => i.actor === "ai").length);
  useEffect(() => {
    const aiCount = interactions.filter((i) => i.actor === "ai").length;
    if (aiCount > prevAiCountRef.current && !aiOpen) {
      setHasUnreadAI(true);
    }
    prevAiCountRef.current = aiCount;
  }, [interactions, aiOpen]);

  /* ------ chat ------ */
  const sendMessage = useCallback(async () => {
    const message = (chatInputs[activeTask] || "").trim();
    if (!message || sending) return;
    setSending(true); setChatError(null);
    const optimistic: Interaction = {
      id: `opt-${Date.now()}`,
      sequenceNum: (interactions[interactions.length - 1]?.sequenceNum ?? 0) + 1,
      taskNumber: activeTask,
      timestamp: new Date().toISOString(),
      actor: "candidate",
      content: message,
    };
    setInteractions((prev) => [...prev, optimistic]);
    setChatInputs((prev) => ({ ...prev, [activeTask]: "" }));
    try {
      const res = await fetch("/api/assess/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, taskNumber: activeTask, message }),
      });
      const rawBody = await res.text();
      type ChatResponseBody = {
        error?: string;
        trail?: Interaction[];
        pending?: boolean;
        requestInteractionId?: string;
      };
      let body: ChatResponseBody | null = null;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody) as ChatResponseBody;
        } catch {
          body = null;
        }
      }
      if (!res.ok) {
        const interrupted = !rawBody || res.status === 502 || res.status === 503 || res.status === 504;
        throw new Error(
          body?.error ||
          (interrupted
            ? "The AI response was interrupted before it finished. Please try the request again."
            : `The AI request failed (HTTP ${res.status}).`)
        );
      }
      if (!body || !Array.isArray(body.trail)) {
        throw new Error("The AI response was incomplete. Please try the request again.");
      }
      const serverTrail = body.trail;
      // Replace this task's interactions with server view; keep other task's intact
      setInteractions((prev) => [
        ...prev.filter((p) => p.taskNumber !== activeTask),
        ...serverTrail,
      ]);
      if (body.pending && body.requestInteractionId) {
        const requestInteractionId = body.requestInteractionId;
        let completed = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          const poll = await fetch(`/api/assess/state/${encodeURIComponent(token)}`, {
            cache: "no-store",
          });
          const pollBody = await poll.json().catch(() => null) as {
            error?: string;
            interactions?: Interaction[];
          } | null;
          if (!poll.ok || !pollBody || !Array.isArray(pollBody.interactions)) {
            if (poll.status === 403 || poll.status === 404) {
              throw new Error(pollBody?.error || "The assessment session could not be refreshed.");
            }
            continue;
          }
          const nextTrail = pollBody.interactions;
          setInteractions(nextTrail);
          const reply = nextTrail.find(
            (entry) =>
              entry.actor === "ai" &&
              entry.metadata?.requestInteractionId === requestInteractionId
          );
          if (reply) {
            completed = true;
            break;
          }
          const requestEntry = nextTrail.find((entry) => entry.id === requestInteractionId);
          if (
            requestEntry?.metadata?.responseStatus === "failed" ||
            requestEntry?.metadata?.codeExecutionStatus === "failed"
          ) {
            throw new Error(
              requestEntry.metadata.responseError ||
              requestEntry.metadata.codeExecutionError ||
              "The AI response could not be completed. Please try the request again."
            );
          }
        }
        if (!completed) {
          throw new Error(
            "The AI response is still taking longer than expected. Your request is saved; please wait a moment and reopen the AI panel."
          );
        }
      }
    } catch (e) {
      setChatError((e as Error).message);
      setInteractions((prev) => prev.filter((p) => p.id !== optimistic.id));
      setChatInputs((prev) => ({ ...prev, [activeTask]: message }));
    } finally {
      setSending(false);
    }
  }, [chatInputs, activeTask, sending, interactions, token]);

  const saveEvidence = useCallback(async (interaction: Interaction, evidenceCardId: string) => {
    const res = await fetch("/api/assess/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, interactionId: interaction.id, evidenceCardId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setChatError(body.error || "Could not save evidence.");
      return;
    }
    setEvidenceBoard((items) => [...items.filter((item) => item.id !== body.evidence.id), body.evidence]);
  }, [token]);

  const updateEvidenceDisposition = useCallback(async (id: string, disposition: EvidenceBoardItem["candidateDisposition"]) => {
    const res = await fetch("/api/assess/evidence", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, id, disposition }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) setEvidenceBoard((items) => items.map((item) => item.id === id ? body.evidence : item));
  }, [token]);

  const removeEvidence = useCallback(async (id: string) => {
    const res = await fetch("/api/assess/evidence", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, id }),
    });
    if (res.ok) setEvidenceBoard((items) => items.filter((item) => item.id !== id));
  }, [token]);

  const openEvidenceSource = useCallback(async (taskNumber: number, sourceId: string | null, evidenceCardId?: string) => {
    setActiveTask(taskNumber);
    setSourceTab("exhibit");
    setSourceOpen(true);
    if (!wideWorkspace) setAiOpen(false);
    await fetch("/api/assess/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action: "source_opened", taskNumber, sourceId, evidenceCardId }),
    });
  }, [token, wideWorkspace]);

  /* ------ memo autosave (debounced + 30s force) ------ */
  const saveMemo = useCallback(async (taskNumber: number, content: string) => {
    setMemoSaving((s) => ({ ...s, [taskNumber]: true }));
    try {
      const res = await fetch("/api/assess/memo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, taskNumber, content }),
      });
      if (res.ok) {
        const body = await res.json();
        setSavedAt((s) => ({ ...s, [taskNumber]: body.updatedAt }));
      }
    } finally {
      setMemoSaving((s) => ({ ...s, [taskNumber]: false }));
    }
  }, [token]);

  /* ------ per-memo "Send" + advance to the next memo ------ */
  const sendMemo = useCallback(async (taskNumber: number) => {
    setSendingMemo(taskNumber);
    setSendError(null);
    try {
      // Persist the latest draft before finalising it.
      await saveMemo(taskNumber, memos[taskNumber] || "");
      const res = await fetch("/api/assess/memo/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, taskNumber }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setMemoSentAt((s) => ({ ...s, [taskNumber]: body.sentAt }));
      // Move on to the next memo ("next email"), if there is one.
      const next = tasks.find((t) => t.number > taskNumber);
      if (next) setActiveTask(next.number);
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSendingMemo(null);
    }
  }, [token, memos, tasks, saveMemo]);

  // Debounce per task
  const memoTimers = useRef<Record<number, ReturnType<typeof setTimeout> | null>>({ 1: null, 2: null });
  useEffect(() => {
    const t = activeTask;
    if (memoTimers.current[t]) clearTimeout(memoTimers.current[t] as any);
    const timer = setTimeout(() => void saveMemo(t, memos[t] || ""), SAVE_DEBOUNCE_MS);
    memoTimers.current[t] = timer;
    return () => {
      clearTimeout(timer);
    };
  }, [memos, activeTask, saveMemo]);

  // Force-save every 30s for both tasks
  useEffect(() => {
    const id = setInterval(() => {
      void saveMemo(1, memos[1] || "");
      void saveMemo(2, memos[2] || "");
    }, FORCE_SAVE_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memos[1], memos[2]]);

  /* ------ submit ------ */
  const submit = useCallback(async (automatic = false) => {
    if (submitting || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    try {
      // Final flush of both memos
      await Promise.all([saveMemo(1, memos[1] || ""), saveMemo(2, memos[2] || "")]);
      const res = await fetch("/api/assess/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          automatic,
          ...(initial.assessment.assessmentMode === "OPEN_AGENT" ? { toolDeclaration } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await onReload(); // parent flips to Submitted view
    } catch (e) {
      setChatError(`Submit failed: ${(e as Error).message}`);
      submittedRef.current = false;
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  }, [submitting, memos, token, saveMemo, onReload, initial.assessment.assessmentMode, toolDeclaration]);

  /* ------ timer ------ */
  const timer = useTimer(initial.candidate.deadline, initial.assessment.totalMinutes);
  // Auto-submit on expiry
  useEffect(() => {
    if (timer.expired && !submittedRef.current) {
      void submit(true);
    }
  }, [timer.expired, submit]);

  const wordCounts = useMemo(() => {
    const wc: Record<number, number> = {};
    for (const t of tasks) wc[t.number] = wordCount(memos[t.number] || "");
    return wc;
  }, [memos, tasks]);

  const trailForActive = interactions.filter((i) => i.taskNumber === activeTask);

  return (
    <div className="min-h-screen text-uq font-sans flex flex-col">
      {/* Header */}
      <header className="bg-uq-glass-strong backdrop-blur-xl border-b border-uq-faint shadow-uq-e1 flex-shrink-0">
        <div className="px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="inline-flex items-center flex-shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/logos/uniqassess-logo.png"
                alt="UNIQAssess"
                width={140}
                height={38}
                className="h-7 w-auto"
              />
            </span>
            <span className="text-uq-3 hidden sm:inline">|</span>
            <div className="text-sm min-w-0">
              <div className="font-semibold tracking-[-0.005em] text-uq truncate">
                {initial.scenario.positionTitle}
              </div>
              <div className="font-mono text-[11px] tracking-[0.04em] text-uq-2 truncate">
                {initial.scenario.organisation} · {initial.candidate.anonymousId}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <TaskTabs
              tasks={tasks}
              active={activeTask}
              onSwitch={setActiveTask}
              wordCounts={wordCounts}
            />
            <AssessmentModeBadge mode={initial.assessment.assessmentMode} className="hidden xl:inline-flex" />
            <TimerPill timer={timer} />
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-uq-accent text-[color:var(--uq-text-on-accent)] text-sm font-medium tracking-[-0.005em] shadow-uq-glow-soft transition-all duration-150 hover:bg-uq-accent-hover hover:shadow-uq-glow active:translate-y-px disabled:bg-uq-elev2 disabled:text-uq-3 disabled:shadow-none disabled:cursor-not-allowed"
            >
              {submitting ? "Submitting…" : "Submit assessment"}
            </button>
          </div>
        </div>
      </header>

      {/* Sources and AI support the central deliverable or practical lab.
          The memo stays mounted when switching views so draft work is retained. */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative bg-uq-bg2">
        {(sourceOpen || aiOpen) && (
          <button
            type="button"
            className="absolute inset-0 z-20 bg-[#16181D]/25 backdrop-blur-[1px] xl:hidden"
            onClick={() => { setSourceOpen(false); setAiOpen(false); }}
            aria-label="Close supporting panel"
          />
        )}

        {sourceOpen && (
          <aside
            className="absolute inset-y-0 left-0 z-30 flex w-[92vw] max-w-[460px] flex-col border-r border-uq bg-uq-elev1 shadow-uq-pop xl:relative xl:z-auto xl:max-w-none xl:w-[var(--source-width)] xl:flex-shrink-0 xl:shadow-none"
            style={{ "--source-width": `${sourceWidth}px` } as React.CSSProperties}
            aria-label="Assessment sources"
          >
            <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-uq-faint bg-uq-glass-subtle px-3 py-2">
              <div className="inline-flex min-w-0 items-center gap-1 rounded-lg bg-uq-elev2 p-1">
                <ViewTab active={sourceTab === "brief"} onClick={() => setSourceTab("brief")} label="Brief" />
                <ViewTab active={sourceTab === "exhibit"} onClick={() => setSourceTab("exhibit")} label="Exhibit" />
                <ViewTab
                  active={sourceTab === "evidence"}
                  onClick={() => setSourceTab("evidence")}
                  label={`Evidence ${evidenceBoard.filter((item) => item.taskNumber === activeTask).length}`}
                />
              </div>
              <button
                type="button"
                onClick={toggleSources}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-xl text-uq-3 transition-colors hover:bg-uq-elev2 hover:text-uq focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
                aria-label="Close sources"
                title="Close sources"
              >
                ×
              </button>
            </div>

            {sourceTab === "brief" && (() => {
              const brief = parseBriefEmail(activeTaskCfg.briefMarkdown);
              return (
                <div className="flex-1 overflow-y-auto p-5 uq-fade-rise">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Task brief · Task {activeTask}</div>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.01em] text-uq">{brief.subject ?? activeTaskCfg.title}</h2>
                  <div className="mt-4 space-y-1 border-y border-uq-faint py-3 text-xs">
                    {brief.from && <div className="grid grid-cols-[3rem_1fr] gap-2"><span className="text-uq-3">From</span><span className="text-uq-2">{brief.from}</span></div>}
                    {brief.to && <div className="grid grid-cols-[3rem_1fr] gap-2"><span className="text-uq-3">To</span><span className="text-uq-2">{brief.to}</span></div>}
                    {brief.cc && <div className="grid grid-cols-[3rem_1fr] gap-2"><span className="text-uq-3">Cc</span><span className="text-uq-2">{brief.cc}</span></div>}
                    {brief.sent && <div className="grid grid-cols-[3rem_1fr] gap-2"><span className="text-uq-3">Sent</span><span className="text-uq-2">{brief.sent}</span></div>}
                  </div>
                  <div className="mt-4 text-sm leading-relaxed text-uq-2"><MarkdownView>{brief.body}</MarkdownView></div>
                </div>
              );
            })()}

            {sourceTab === "exhibit" && (
              <div className="flex flex-1 min-h-0 flex-col uq-fade-rise">
                <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-uq-faint px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Exhibit · Task {activeTask}</div>
                    <div className="truncate text-sm font-semibold text-uq">{activeTaskCfg.exhibitTitle}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExhibitFullscreen(true)}
                    className="flex-shrink-0 rounded-md border border-uq-strong px-2.5 py-1.5 text-xs font-medium text-uq-2 transition-colors hover:border-uq-accent hover:bg-uq-elev2 hover:text-uq focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
                  >
                    ⤢ Expand
                  </button>
                </div>
                <iframe srcDoc={activeTaskCfg.exhibitHtml} sandbox="" className="flex-1 w-full border-0 bg-white" title={activeTaskCfg.exhibitTitle} />
              </div>
            )}

            {sourceTab === "evidence" && (
              <div className="flex-1 overflow-y-auto uq-fade-rise">
                <CandidateEvidenceBoard
                  embedded
                  items={evidenceBoard.filter((item) => item.taskNumber === activeTask)}
                  onDisposition={(id, disposition) => void updateEvidenceDisposition(id, disposition)}
                  onRemove={(id) => void removeEvidence(id)}
                  onOpenSource={(item) => void openEvidenceSource(item.taskNumber, item.sourceId, item.evidenceCardId)}
                />
              </div>
            )}

            <button
              type="button"
              onPointerDown={beginSourceResize}
              className="absolute -right-1 top-0 hidden h-full w-2 cursor-col-resize touch-none xl:block"
              aria-label="Resize sources panel"
              title="Drag to resize sources"
            />
          </aside>
        )}

        <main className="flex flex-1 min-w-0 flex-col min-h-0 overflow-hidden bg-uq-elev1">
          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-uq-faint bg-uq-bg2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={toggleSources}
                aria-pressed={sourceOpen}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)] ${sourceOpen ? "border-uq-accent bg-uq-accent-soft text-uq" : "border-uq-strong bg-uq-elev1 text-uq-2 hover:border-uq-accent hover:text-uq"}`}
              >
                Sources
              </button>
              <button
                type="button"
                onClick={toggleAi}
                aria-pressed={aiOpen}
                className={`relative rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)] ${aiOpen ? "border-uq-accent bg-uq-accent-soft text-uq" : "border-uq-strong bg-uq-elev1 text-uq-2 hover:border-uq-accent hover:text-uq"}`}
                title={`${assistantShort} AI assistant · Ctrl/Cmd+J`}
              >
                Ask AI <span className="font-mono text-uq-3">{trailForActive.length}</span>
                {hasUnreadAI && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-uq-accent" aria-label="New AI reply" />}
              </button>
              {(sourceOpen || aiOpen) && (
                <button
                  type="button"
                  onClick={() => { setSourceOpen(false); setAiOpen(false); setWorkViews((previous) => ({ ...previous, [activeTask]: "deliverable" })); }}
                  className="hidden rounded-lg px-3 py-1.5 text-xs font-medium text-uq-3 transition-colors hover:bg-uq-elev2 hover:text-uq sm:inline-flex focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
                >
                  Focus writing
                </button>
              )}
            </div>
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-uq-3 lg:inline">{activeTaskCfg.kubernetesLab ? "Your work is recorded" : "Memo always stays open"}</span>
          </div>

          {(() => {
            const brief = parseBriefEmail(activeTaskCfg.briefMarkdown);
            return (
              <button
                type="button"
                onClick={() => {
                  setSourceTab("brief");
                  setSourceOpen(true);
                  if (!wideWorkspace) setAiOpen(false);
                }}
                className="flex w-full flex-shrink-0 items-center gap-3 border-b border-uq-faint bg-uq-glass-subtle px-4 py-2 text-left transition-colors hover:bg-uq-elev2 focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
              >
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-uq-accent">Brief</span>
                <span className="min-w-0 flex-1 truncate text-xs text-uq-2"><strong className="font-semibold text-uq">{brief.from ?? "Task brief"}</strong> · {brief.subject ?? activeTaskCfg.title}</span>
                <span className="flex-shrink-0 text-xs font-medium text-uq-accent">View →</span>
              </button>
            );
          })()}

          {activeTaskCfg.kubernetesLab && (
            <div className="flex flex-shrink-0 gap-2 border-b border-uq-faint px-4 py-2" aria-label="Work area">
              <ViewTab active={!labOpen} onClick={() => setWorkViews((previous) => ({ ...previous, [activeTask]: "deliverable" }))} label="Written deliverable" />
              <ViewTab active={labOpen} onClick={() => setWorkViews((previous) => ({ ...previous, [activeTask]: "lab" }))} label="Kubernetes lab" />
            </div>
          )}

          {activeTaskCfg.kubernetesLab && (
            <div className={`${labOpen ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
              <KubernetesLabPanel
                key={`${token}:${activeTask}`}
                token={token}
                taskNumber={activeTask}
                title={activeTaskCfg.kubernetesLab.title}
                instructions={activeTaskCfg.kubernetesLab.instructions}
                disabled={submitting || submittedRef.current || Boolean(initial.candidate.submittedAt) || Boolean(initial.candidate.workLockedAt) || timer.expired}
              />
            </div>
          )}

          <section className={`${labOpen ? "hidden" : "flex"} flex-1 min-h-0 flex-col overflow-hidden bg-uq-elev1`}>
            <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-uq-faint bg-uq-glass-subtle px-4 py-2.5">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Your deliverable · Task {activeTask}</div>
                <div className="truncate text-sm font-semibold tracking-[-0.005em] text-uq">{activeTaskCfg.deliverableLabel}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSourceTab("exhibit");
                  setSourceOpen(true);
                  if (!wideWorkspace) setAiOpen(false);
                }}
                className="flex-shrink-0 rounded-md border border-uq-strong px-3 py-1.5 text-xs font-medium text-uq-2 transition-colors hover:border-uq-accent hover:bg-uq-elev2 hover:text-uq focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
              >
                View exhibit
              </button>
            </div>

            <MemoEditor
              key={activeTask}
              initialContent={memos[activeTask] || ""}
              placeholder={activeTaskCfg.deliverablePlaceholder}
              onChange={(html) => setMemos((prev) => ({ ...prev, [activeTask]: html }))}
              onPasteCapture={(charCount) => logActivity("paste", { target: "memo", charCount })}
            />

            <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-uq-faint bg-uq-glass-subtle px-4 py-2 text-xs text-uq-3">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <span className="font-mono tabular-nums text-uq-2">{wordCounts[activeTask]} words</span>
                <span className="font-mono tabular-nums">{memoSaving[activeTask] ? "Saving…" : savedAt[activeTask] ? `Saved ${new Date(savedAt[activeTask]!).toLocaleTimeString()}` : "Not yet saved"}</span>
                {memoSentAt[activeTask] && <span className="whitespace-nowrap font-mono text-[color:var(--uq-success-text)]">✓ Sent {new Date(memoSentAt[activeTask]!).toLocaleTimeString()}</span>}
              </div>
              {(() => {
                const hasNext = !!tasks.find((t) => t.number > activeTask);
                const sent = !!memoSentAt[activeTask];
                return (
                  <button
                    type="button"
                    onClick={() => void sendMemo(activeTask)}
                    disabled={sendingMemo === activeTask || (wordCounts[activeTask] ?? 0) === 0}
                    className="flex-shrink-0 rounded-md bg-uq-accent px-3 py-1.5 text-xs font-medium text-[color:var(--uq-text-on-accent)] shadow-uq-glow-soft transition-all duration-150 hover:bg-uq-accent-hover hover:shadow-uq-glow active:translate-y-px disabled:cursor-not-allowed disabled:bg-uq-elev2 disabled:text-uq-3 disabled:shadow-none focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
                  >
                    {sendingMemo === activeTask ? "Sending…" : sent ? (hasNext ? "Re-send & next →" : "Re-send") : (hasNext ? "Send & next →" : "Send memo")}
                  </button>
                );
              })()}
            </div>
            {sendError && <div className="flex-shrink-0 border-t border-uq-danger-line bg-uq-danger-soft px-4 py-1.5 text-xs text-uq-danger-text">{sendError}</div>}
          </section>
        </main>

        {aiOpen && (
          <aside
            className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-uq bg-uq-glass-strong shadow-uq-pop sm:w-[420px] xl:relative xl:z-auto xl:w-[400px] xl:flex-shrink-0 xl:shadow-none"
            aria-label={`${assistantShort} AI assistant chat`}
          >
            <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-uq-faint bg-uq-glass-subtle px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full shadow-uq-e1" style={{ backgroundImage: "linear-gradient(135deg, var(--uq-accent), var(--uq-persona))" }} aria-hidden><span className="h-2.5 w-2.5 rounded-full bg-white/90" /></span>
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">AI Assistant · Task {activeTask}</div>
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-sm font-semibold text-uq">{assistantName}</div>
                    {activeTaskCfg.codeExecutionEnabled && <span className="flex-shrink-0 rounded-full border border-uq-accent bg-uq-accent-soft px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-uq-accent">Python enabled</span>}
                  </div>
                </div>
              </div>
              <button type="button" onClick={toggleAi} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-xl text-uq-3 transition-colors hover:bg-uq-elev2 hover:text-uq focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]" aria-label={`Close ${assistantShort} AI assistant`} title="Close AI assistant · Ctrl/Cmd+J">×</button>
            </div>

            <div ref={chatScroller} className="flex-1 min-h-0 space-y-3 overflow-y-auto px-4 py-3">
              {trailForActive.length === 0 && <div className="text-xs italic text-uq-3">{activeTaskCfg.codeExecutionEnabled ? `Ask the ${assistantShort} AI to write and run Python against the supplied exercise data. The code and output will be recorded.` : `Ask the ${assistantShort} AI anything. Be specific — request source documents, underlying data, or detail on a particular item. Every question forms part of the assessment.`}</div>}
              {trailForActive.map((i) => (
                <ChatBubble
                  key={i.id}
                  entry={i}
                  savedCardIds={new Set(evidenceBoard.filter((item) => item.interactionId === i.id).map((item) => item.evidenceCardId))}
                  onSaveCard={(cardId) => void saveEvidence(i, cardId)}
                  onOpenSource={(sourceId) => void openEvidenceSource(i.taskNumber, sourceId)}
                />
              ))}
              {sending && <div className="flex items-center gap-2 text-xs"><span className="h-5 w-5 flex-shrink-0 rounded-full shadow-uq-e1" style={{ backgroundImage: "linear-gradient(135deg, var(--uq-accent), var(--uq-persona))" }} aria-hidden /><span className="uq-shimmer-text font-medium">{assistantShort} is thinking…</span></div>}
            </div>

            {chatError && <div className="border-t border-uq-danger-line bg-uq-danger-soft px-4 py-2 text-xs text-uq-danger-text">{chatError}</div>}

            <div className="flex-shrink-0 border-t border-uq-faint p-3">
              <p className="mb-2 text-[11px] leading-relaxed text-uq-3">{activeTaskCfg.codeExecutionEnabled ? "Managed Python sandbox · Code and output are retained with the assessment record." : "AI-powered · Check important conclusions against the source exhibits."}</p>
              <textarea
                ref={chatInputRef}
                value={chatInputs[activeTask] || ""}
                onChange={(e) => setChatInputs((prev) => ({ ...prev, [activeTask]: e.target.value }))}
                onPaste={(e) => { const txt = e.clipboardData.getData("text") ?? ""; if (txt.length > 0) logActivity("paste", { target: "chat", charCount: txt.length }); }}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendMessage(); } }}
                placeholder={`Ask the ${assistantName}… (Ctrl/Cmd ⏎ to send)`}
                className="h-20 w-full resize-none rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:border-uq-accent focus:bg-uq-elev1 focus:outline-none focus:shadow-[var(--uq-glow-soft)]"
                maxLength={CHAT_MAX_CHARS}
                disabled={sending}
              />
              {(() => {
                const len = (chatInputs[activeTask] || "").length;
                const atLimit = len >= CHAT_MAX_CHARS;
                const nearLimit = len >= CHAT_MAX_CHARS * 0.9;
                return (
                  <div className="mt-1.5 flex items-center justify-between text-xs">
                    <span className={`font-mono tabular-nums ${atLimit ? "font-medium text-uq-danger-text" : nearLimit ? "font-medium text-uq-warn-text" : "text-uq-3"}`}>{len.toLocaleString()} / {CHAT_MAX_CHARS.toLocaleString()}</span>
                    <button onClick={() => void sendMessage()} disabled={!(chatInputs[activeTask] || "").trim() || sending} className="rounded-lg bg-uq-accent px-3 py-1.5 text-xs font-medium text-[color:var(--uq-text-on-accent)] shadow-uq-glow-soft transition-all hover:bg-uq-accent-hover disabled:cursor-not-allowed disabled:bg-uq-elev2 disabled:text-uq-3 disabled:shadow-none">{sending ? "Sending…" : "Send"}</button>
                  </div>
                );
              })()}
            </div>
          </aside>
        )}
      </div>

      {/* Fullscreen exhibit modal */}
      {exhibitFullscreen && (
        <div
          className="fixed inset-0 z-50 bg-[#16181D]/40 backdrop-blur-sm flex flex-col p-3"
          onClick={() => setExhibitFullscreen(false)}
        >
          <div
            className="bg-uq-elev3 rounded-2xl border border-uq-strong shadow-uq-pop animate-uq-rise flex flex-col h-full w-full max-w-6xl mx-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-uq-faint bg-uq-glass-subtle flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">
                  Exhibit · Task {activeTask}
                </div>
                <div className="text-base font-semibold tracking-[-0.005em] text-uq">{activeTaskCfg.exhibitTitle}</div>
              </div>
              <button
                onClick={() => setExhibitFullscreen(false)}
                className="text-uq-3 hover:text-uq text-2xl w-9 h-9 rounded-full hover:bg-uq-elev2 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <iframe
              srcDoc={activeTaskCfg.exhibitHtml}
              sandbox=""
              className="flex-1 w-full border-0 rounded-b-2xl bg-white"
              title={activeTaskCfg.exhibitTitle}
            />
          </div>
        </div>
      )}

      {/* Submit modal */}
      {confirmOpen && (() => {
        const memoTaskNums = tasks.map((t) => t.number);
        const interactionCounts: Record<number, number> = {};
        for (const n of memoTaskNums) {
          interactionCounts[n] = interactions.filter((i) => i.taskNumber === n && i.actor === "candidate").length;
        }
        const flags: { task: number; kind: "empty-memo" | "short-memo" | "no-ai" | "not-sent"; label: string }[] = [];
        memoTaskNums.forEach((t) => {
          if ((wordCounts[t] ?? 0) === 0) {
            flags.push({ task: t, kind: "empty-memo", label: `Task ${t} memo is empty` });
          } else if ((wordCounts[t] ?? 0) < 50) {
            flags.push({ task: t, kind: "short-memo", label: `Task ${t} memo is very short (${wordCounts[t]} words)` });
          } else if (!memoSentAt[t]) {
            flags.push({ task: t, kind: "not-sent", label: `Task ${t} memo hasn't been sent` });
          }
          if ((interactionCounts[t] ?? 0) === 0) {
            flags.push({ task: t, kind: "no-ai", label: `You have not used the AI system on Task ${t}` });
          }
        });
        const hasCritical = flags.some((f) => f.kind === "empty-memo" || f.kind === "no-ai");
        return (
          <div
            className="fixed inset-0 z-50 bg-[#16181D]/40 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setConfirmOpen(false)}
          >
            <div className="rounded-2xl border border-uq-strong bg-uq-elev3 shadow-uq-pop animate-uq-rise max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold tracking-[-0.005em] text-uq">{initial.assessment.defenceEnabled ? "Complete work and continue to defence?" : "Submit assessment?"}</h3>
              <p className="text-sm text-uq-2 mt-2 leading-relaxed">
                This assessment has <strong>{memoTaskNums.length === 2 ? "two" : memoTaskNums.length} {memoTaskNums.length === 1 ? "task" : "tasks"}</strong>. You will not be able to return
                to this workspace or modify your responses after completion.
                {initial.assessment.defenceEnabled && <> Your work will lock before a separate <strong>{initial.assessment.defenceMinutes}-minute, two-question reasoning defence</strong> begins.</>}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                {memoTaskNums.map((t) => (
                  <div
                    key={t}
                    className={`rounded-xl p-3 ${
                      (wordCounts[t] ?? 0) === 0 || (interactionCounts[t] ?? 0) === 0
                        ? "border border-uq-danger-line bg-uq-danger-soft"
                        : "border border-uq bg-uq-glass-subtle"
                    }`}
                  >
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-uq-3">Task {t}</div>
                    <div className="font-semibold font-mono text-uq">
                      {wordCounts[t] ?? 0} words
                      <span className="text-xs font-normal text-uq-3 ml-1">memo</span>
                    </div>
                    <div className="font-mono text-xs text-uq-2 tabular-nums mt-1">
                      {interactionCounts[t] ?? 0} AI {interactionCounts[t] === 1 ? "question" : "questions"}
                    </div>
                    <div className="font-mono text-[10px] tabular-nums mt-1">
                      {memoSentAt[t]
                        ? <span className="text-[color:var(--uq-success-text)]">✓ sent</span>
                        : <span className="text-uq-3">not sent</span>}
                    </div>
                  </div>
                ))}
              </div>
              {flags.length > 0 && (
                <div
                  className={`mt-3 text-xs rounded-xl p-3 border ${
                    hasCritical
                      ? "text-uq-danger-text bg-uq-danger-soft border-uq-danger-line"
                      : "text-uq-warn-text bg-uq-warn-soft border-uq-warn-line"
                  }`}
                >
                  <div className="font-semibold mb-1">
                    {hasCritical ? "Please review before submitting:" : "Heads up:"}
                  </div>
                  <ul className="space-y-1">
                    {flags.map((f, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTask(f.task);
                            setConfirmOpen(false);
                          }}
                          className="w-full text-left flex items-start gap-2 px-2 py-1 rounded-md hover:bg-uq-elev2 transition-colors group focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
                        >
                          <span className="opacity-60 mt-0.5 leading-tight">•</span>
                          <span className="flex-1">{f.label}</span>
                          <span className="font-medium underline text-uq-accent opacity-90 group-hover:opacity-100 whitespace-nowrap">
                            Take me to Task {f.task} →
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {initial.assessment.assessmentMode === "OPEN_AGENT" && (
                <ToolUseDeclaration value={toolDeclaration} onChange={setToolDeclaration} />
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmOpen(false)}
                  className="px-4 py-2 rounded-lg border border-uq-strong bg-uq-glass-subtle text-uq text-sm font-medium transition-colors hover:border-uq-accent hover:bg-uq-accent-soft hover:text-uq focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void submit(false)}
                  disabled={submitting}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 active:translate-y-px disabled:bg-uq-elev2 disabled:text-uq-3 disabled:shadow-none disabled:cursor-not-allowed focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)] ${
                    hasCritical
                      ? "border border-uq-danger-line bg-uq-danger-soft text-uq-danger-text hover:border-uq-danger"
                      : "bg-uq-accent text-[color:var(--uq-text-on-accent)] shadow-uq-glow-soft hover:bg-uq-accent-hover hover:shadow-uq-glow"
                  }`}
                >
                  {submitting ? "Locking work…" : initial.assessment.defenceEnabled ? "Lock work and begin defence" : hasCritical ? "Submit anyway" : "Submit"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/*
        Scripted-events overlay — renders an inbox drawer + persona chat
        popup for scenarios that include email_inbox / chat tasks. Polls
        /api/assess/events on a ~7s cadence. Legacy memo-only scenarios
        (fam-p4-2026) produce no events, so the overlay is inert there.
      */}
      <LiveEventsOverlay token={token} active={!initial.candidate.submittedAt} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ChatBubble({
  entry,
  savedCardIds,
  onSaveCard,
  onOpenSource,
}: {
  entry: Interaction;
  savedCardIds: Set<string>;
  onSaveCard: (cardId: string) => void;
  onOpenSource: (sourceId: string | null) => void;
}) {
  const isUser = entry.actor === "candidate";
  const structured = !isUser && entry.structuredPayload ? entry.structuredPayload : null;
  const codeExecuted = !isUser && entry.metadata?.codeExecutionUsed === true;
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? "rounded-2xl rounded-br-md bg-uq-accent text-[color:var(--uq-text-on-accent)] whitespace-pre-wrap"
            : "rounded-2xl rounded-bl-md bg-uq-elev2 border border-uq text-uq"
        }`}
      >
        {codeExecuted && <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[color:var(--uq-success-line)] bg-[color:var(--uq-success-soft)] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-[color:var(--uq-success-text)]"><span aria-hidden>✓</span> Python executed</div>}
        {isUser ? entry.content : structured ? (
          <div className="space-y-3">
            <MarkdownView>{structured.analysisSummary}</MarkdownView>
            {structured.evidenceCards.map((card) => (
              <KnowledgeEvidenceCard
                key={card.id}
                card={card}
                saved={savedCardIds.has(card.id)}
                onSave={() => onSaveCard(card.id)}
                onOpenSource={() => onOpenSource(card.sourceId)}
              />
            ))}
            {structured.uncertainties.length > 0 && (
              <div><div className="font-semibold">Things to check</div><ul className="mt-1 list-disc space-y-1 pl-4 text-uq-2">{structured.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul></div>
            )}
            {structured.questionsToResolve.length > 0 && (
              <div><div className="font-semibold">You could explore</div><ul className="mt-1 list-disc space-y-1 pl-4 text-uq-2">{structured.questionsToResolve.map((item) => <li key={item}>{item}</li>)}</ul></div>
            )}
            {structured.workingDraft && (
              <div className="rounded-xl border border-uq-strong bg-uq-elev1 p-3"><div className="font-mono text-[9px] uppercase tracking-[0.1em] text-uq-3">{structured.workingDraft.label} · AI-generated working material</div><div className="mt-2 whitespace-pre-wrap text-uq-2">{structured.workingDraft.content}</div></div>
            )}
          </div>
        ) : <MarkdownView>{entry.content}</MarkdownView>}
      </div>
    </div>
  );
}

// Lightweight markdown renderer for AI output and memo preview.
// Uses remark-gfm so tables, strikethrough, task lists, and autolinks work.
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="markdown-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="text-base font-bold mt-3 mb-1.5">{p.children}</h1>,
          h2: (p) => <h2 className="text-sm font-bold mt-3 mb-1.5">{p.children}</h2>,
          h3: (p) => <h3 className="text-sm font-semibold mt-2.5 mb-1">{p.children}</h3>,
          h4: (p) => <h4 className="text-xs font-semibold uppercase tracking-wider text-uq-2 mt-2 mb-1">{p.children}</h4>,
          p: (p) => <p className="mb-2 last:mb-0 leading-relaxed">{p.children}</p>,
          ul: (p) => <ul className="list-disc pl-5 mb-2 space-y-0.5 last:mb-0">{p.children}</ul>,
          ol: (p) => <ol className="list-decimal pl-5 mb-2 space-y-0.5 last:mb-0">{p.children}</ol>,
          li: (p) => <li className="leading-relaxed">{p.children}</li>,
          strong: (p) => <strong className="font-semibold">{p.children}</strong>,
          em: (p) => <em className="italic">{p.children}</em>,
          hr: () => <hr className="my-3 border-uq" />,
          blockquote: (p) => (
            <blockquote className="border-l-4 border-uq-accent pl-3 italic my-2 text-uq-2">
              {p.children}
            </blockquote>
          ),
          code: ({ className, children, ...rest }: any) => {
            const isBlock = /language-/.test(className || "");
            return isBlock ? (
              <code className={`${className} block`} {...rest}>
                {children}
              </code>
            ) : (
              <code className="bg-uq-glass-subtle border border-uq-faint text-uq-cyan px-1 py-0.5 rounded text-[0.85em] font-mono" {...rest}>
                {children}
              </code>
            );
          },
          pre: (p) => (
            <pre className="bg-uq-elev2 border border-uq text-uq text-xs rounded-lg p-2.5 overflow-x-auto my-2 font-mono">
              {p.children}
            </pre>
          ),
          table: (p) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full border-collapse text-xs">{p.children}</table>
            </div>
          ),
          thead: (p) => <thead className="bg-uq-glass-subtle">{p.children}</thead>,
          th: (p) => (
            <th className="border border-uq px-2 py-1 text-left font-semibold">
              {p.children}
            </th>
          ),
          td: (p) => <td className="border border-uq px-2 py-1 align-top">{p.children}</td>,
          a: (p) => (
            <a className="text-uq-accent underline hover:no-underline" target="_blank" rel="noreferrer" {...(p as any)}>
              {p.children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function TaskTabs({
  tasks, active, onSwitch, wordCounts,
}: {
  tasks: TaskCfg[];
  active: number;
  onSwitch: (n: number) => void;
  wordCounts: Record<number, number>;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-uq-elev2 p-1">
      {tasks.map((t) => {
        const isActive = active === t.number;
        const shortTitle = t.title.split("&")[0].trim();
        const empty = (wordCounts[t.number] ?? 0) === 0;
        return (
          <button
            key={t.number}
            onClick={() => onSwitch(t.number)}
            aria-pressed={isActive}
            className={[
              "px-3 py-1.5 rounded-md text-xs transition-all duration-150 flex items-center gap-1.5 focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]",
              isActive
                ? "bg-uq-elev1 text-uq shadow-uq-e1"
                : "text-uq-2 hover:text-uq",
            ].join(" ")}
            title={`Task ${t.number} of ${tasks.length}: ${t.title}`}
          >
            <span className="font-semibold">
              Task {t.number}
              <span className="opacity-50 font-normal">/{tasks.length}</span>
            </span>
            <span className="hidden lg:inline opacity-70 truncate max-w-[120px] font-medium">
              {shortTitle}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-uq-3">{wordCounts[t.number]}w</span>
            {!isActive && empty && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-uq-danger flex-shrink-0"
                title="No memo content yet"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function ViewTab({
  active, onClick, label, sublabel, warn,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sublabel?: string;
  warn?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={sublabel}
      className={[
        "px-3.5 py-1.5 rounded-md text-sm font-medium inline-flex items-center gap-1.5 transition-all duration-150 focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]",
        active
          ? "bg-uq-elev1 text-uq shadow-uq-e1"
          : "text-uq-2 hover:text-uq",
      ].join(" ")}
    >
      {label}
      {warn && (
        <span
          className="w-1.5 h-1.5 rounded-full bg-uq-danger flex-shrink-0"
          aria-label="empty"
          title="Empty"
        />
      )}
    </button>
  );
}

interface TimerInfo { mm: string; ss: string; warning: boolean; critical: boolean; expired: boolean; fraction: number; }

function useTimer(deadlineIso: string, totalMinutes: number): TimerInfo {
  const deadline = new Date(deadlineIso).getTime();
  const totalMs = Math.max(1, totalMinutes * 60_000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, deadline - now);
  const totalSec = Math.floor(remaining / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return {
    mm: String(m).padStart(2, "0"),
    ss: String(s).padStart(2, "0"),
    warning: remaining < 10 * 60_000,
    critical: remaining < 60_000,
    expired: remaining === 0,
    // Fraction of time REMAINING (1 → full, 0 → expired) for the ambient ring.
    fraction: Math.max(0, Math.min(1, remaining / totalMs)),
  };
}

/**
 * WYSIWYG memo editor. Stores content as HTML (TipTap's native format).
 * Remounts when the active task changes (via key={activeTask} on the parent
 * caller) so each task gets its own undo history and cursor state.
 */
function MemoEditor({
  initialContent,
  placeholder,
  onChange,
  onPasteCapture,
}: {
  initialContent: string;
  placeholder: string;
  onChange: (html: string) => void;
  onPasteCapture?: (charCount: number) => void;
}) {
  const onPasteCaptureRef = useRef(onPasteCapture);
  useEffect(() => { onPasteCaptureRef.current = onPasteCapture; }, [onPasteCapture]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
    ],
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "memo-editor flex-1 min-h-0 overflow-y-auto px-6 py-4",
      },
      handlePaste: (_view, event) => {
        const txt = event.clipboardData?.getData("text") ?? "";
        if (txt.length > 0) onPasteCaptureRef.current?.(txt.length);
        return false; // let Tiptap handle insertion as normal
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML());
    },
  });

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <MemoToolbar editor={editor} />
      <EditorContent editor={editor} className="flex-1 min-h-0 overflow-hidden flex flex-col" />
    </div>
  );
}

function MemoToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) {
    return (
      <div className="border-b border-uq-faint px-2 py-1.5 bg-uq-glass-subtle text-xs flex-shrink-0 h-9" />
    );
  }
  const isActive = (name: string, attrs?: Record<string, unknown>) => editor.isActive(name, attrs);
  return (
    <div className="border-b border-uq-faint px-2 py-1.5 flex items-center gap-0.5 bg-uq-glass-subtle text-xs flex-shrink-0 flex-wrap">
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={isActive("bold")}
        title="Bold (Ctrl+B)"
      >
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={isActive("italic")}
        title="Italic (Ctrl+I)"
      >
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={isActive("strike")}
        title="Strikethrough"
      >
        <span className="line-through">S</span>
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={isActive("heading", { level: 2 })}
        title="Heading"
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={isActive("heading", { level: 3 })}
        title="Sub-heading"
      >
        H3
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={isActive("bulletList")}
        title="Bullet list"
      >
        •&nbsp;List
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={isActive("orderedList")}
        title="Numbered list"
      >
        1.&nbsp;List
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={isActive("blockquote")}
        title="Quote"
      >
        &ldquo;&rdquo;
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Horizontal rule"
      >
        —
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton
        onClick={() => editor.chain().focus().undo().run()}
        title="Undo (Ctrl+Z)"
      >
        ↶
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().redo().run()}
        title="Redo (Ctrl+Shift+Z)"
      >
        ↷
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => {
        // Preserve editor selection when clicking the toolbar
        e.preventDefault();
      }}
      onClick={onClick}
      title={title}
      type="button"
      className={`px-2 py-1 rounded-md transition-colors text-xs min-w-[26px] ${
        active
          ? "bg-uq-accent-soft text-uq border border-uq-accent"
          : "text-uq-2 hover:bg-uq-elev2 hover:text-uq"
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-4 bg-uq-border mx-0.5" />;
}

/**
 * Ambient timer: a slim progress ring that depletes and shifts hue as time
 * runs out (calm indigo → amber under 10 min → red under 2), with the numeric
 * time shown smaller alongside. Visual only — drives off the existing timer.
 */
function TimerPill({ timer }: { timer: TimerInfo }) {
  const ring = timer.critical
    ? "var(--uq-danger)"
    : timer.warning
    ? "var(--uq-warn)"
    : "var(--uq-accent)";
  const textCls = timer.critical
    ? "text-[color:var(--uq-danger-text)]"
    : timer.warning
    ? "text-[color:var(--uq-warn-text)]"
    : "text-uq-2";
  const R = 9;
  const C = 2 * Math.PI * R;
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full bg-uq-elev1 border border-uq shadow-uq-e1 pl-1.5 pr-3 py-1"
      title={`${timer.mm}:${timer.ss} remaining`}
    >
      <span className="relative inline-flex items-center justify-center" style={{ width: 22, height: 22 }}>
        <svg width="22" height="22" viewBox="0 0 22 22" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="11" cy="11" r={R} fill="none" stroke="var(--uq-border)" strokeWidth="2.5" />
          <circle
            cx="11" cy="11" r={R} fill="none" stroke={ring} strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - timer.fraction)}
            style={{ transition: "stroke-dashoffset 1s linear, stroke 400ms ease" }}
          />
        </svg>
      </span>
      <span className={`text-sm font-mono tabular-nums font-medium ${textCls}`}>
        {timer.mm}:{timer.ss}
      </span>
    </div>
  );
}
