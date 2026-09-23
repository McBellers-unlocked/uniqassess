"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import DOMPurify from "dompurify";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReuseResult } from "@/lib/recruit/textReuse";
import { AssessmentModeBadge } from "@/components/recruit/AssessmentModeBadge";
import WorkProvenanceTimeline from "@/components/recruit/WorkProvenanceTimeline";
import LabEvidence, { type LabSessionEvidence } from "@/components/recruit/LabEvidence";

interface Interaction { id: string; sequenceNum: number; taskNumber: number; timestamp: string; actor: string; content: string; structuredPayload?: unknown; schemaVersion?: string | null; }
interface ActivityEvent {
  id: string;
  occurredAt: string;
  eventType: string;               // paste | visibility_hidden | visibility_visible
  taskNumber: number | null;
  metadata: Record<string, unknown> | null;
}
interface ResponseRow {
  taskNumber: number; content: string; wordCount: number; sentAt: string | null;
  score: number | null; comments: string | null; issuesIdentified: string[] | null;
  criterionScores: Record<string, number> | null; markedAt: string | null;
}
interface CriterionMapping {
  criterionId: string; code: string; name: string; taskNumber: number;
  expectedCandidateEvidence: string; maxMarks: number;
}
interface RubricIssue { id: string; title: string; max_marks?: number; description?: string; expected?: string; }
interface RubricCategory { max: number; description?: string; embedded_issues?: RubricIssue[]; indicators?: string[]; rubric?: Record<string,string>; descriptors?: Record<string,string>; }
interface RubricTask { title: string; max_marks: number; categories: Record<string, RubricCategory>; }
// N-task shape (mirrors NormalizedRubric in src/lib/recruit/rubric.ts).
// tasks is keyed by task number, so a scenario can carry 1–5 tasks.
interface Rubric { tasks: Record<number, RubricTask>; total_marks: number; }

// Non-memo tasks surfaced for marker review (the dynamic streams).
interface ScenarioEmail {
  id: string; senderName: string; senderEmail: string; subject: string;
  bodyHtml: string; triggerOffsetSeconds: number; expectedAction: string; markerNotes: string | null;
}
interface ScenarioPersona {
  personaName: string; personaRole: string; openerMessage: string;
  maxTurns: number; expectedOutcomes: string | null;
}
interface ScenarioTask {
  number: number; kind: "memo_ai" | "email_inbox" | "chat"; title: string;
  emails?: ScenarioEmail[]; persona?: ScenarioPersona;
  labConfigured?: boolean;
}
interface EmailResponseRow {
  emailId: string; action: string; replyBody: string | null;
  deliveredAt: string; respondedAt: string; markerComment: string | null;
}
interface EvidenceRow { id: string; createdAt: string; updatedAt: string; taskNumber: number; claim: string; candidateDisposition: string; sourceTitle: string | null; }
interface DefenceRow { questions: Array<{ id: string; text: string }>; answers: Array<{ questionId: string; text: string; savedAt: string | null }>; personalised: boolean; startedAt: string; submittedAt: string | null; }

interface MarkData {
  candidate: { id: string; anonymousId: string; startedAt: string; submittedAt: string; timeTakenMin: number | null; totalScore: number | null; workLockedAt: string | null; toolDeclaration: { tools?: string[]; otherText?: string } | null; toolDeclarationSubmittedAt: string | null; };
  assessment: { id: string; title: string; scenarioId: string; assessmentMode: "EVIDENCE" | "COPILOT" | "OPEN_AGENT" };
  assistantName: string | null;
  assistantShortName: string | null;
  rubric: Rubric | null;
  criterionMappings: CriterionMapping[];
  scenarioTasks: ScenarioTask[];
  responses: ResponseRow[];
  interactions: Interaction[];
  labSessions: LabSessionEvidence[];
  emailResponses: EmailResponseRow[];
  activityEvents: ActivityEvent[];
  evidenceBoard: EvidenceRow[];
  defence: DefenceRow | null;
  // Per-task lexical text-reuse analysis (memo vs the AI output the candidate
  // saw). Keyed by task number; absent for non-memo tasks.
  reuseByTask: Record<number, ReuseResult>;
}

// The IPAC Knowledge System's brand mark (mirrors the candidate-facing AI orb
// in AssessmentView) — so the marker recognises the same speaker the candidate saw.
const ORB_GRADIENT = "linear-gradient(135deg, var(--uq-accent), var(--uq-persona))";
type ReviewView = "response" | "integrity" | "dialogue" | "defence" | "lab";

export default function MarkCandidatePage() {
  const params = useParams<{ id: string; candidateId: string }>();
  const router = useRouter();
  const { status } = useSession();
  const [data, setData] = useState<MarkData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<number>(1);
  const [reviewView, setReviewView] = useState<ReviewView>("response");

  // Per-task marking state — keyed by task number, populated from the
  // server load. Empty until data arrives; all reads use a ?? fallback so
  // an unseeded task number never produces an uncontrolled input.
  const [scores, setScores] = useState<Record<number, string>>({});
  const [comments, setComments] = useState<Record<number, string>>({});
  const [issues, setIssues] = useState<Record<number, Set<string>>>({});
  const [criterionScores, setCriterionScores] = useState<Record<number, Record<string, string>>>({});
  const [savingTask, setSavingTask] = useState<Record<number, boolean>>({});
  const [savedAt, setSavedAt] = useState<Record<number, string | null>>({});
  const markingStateRef = useRef({ scores, comments, issues, criterionScores });

  useEffect(() => {
    markingStateRef.current = { scores, comments, issues, criterionScores };
  }, [scores, comments, issues, criterionScores]);

  useEffect(() => { if (status === "unauthenticated") router.push("/login"); }, [status, router]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/admin/recruitment/${params.id}/mark/${params.candidateId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: MarkData = await res.json();
        setData(body);
        const newScores: Record<number, string> = {};
        const newComments: Record<number, string> = {};
        const newIssues: Record<number, Set<string>> = {};
        const newCriterionScores: Record<number, Record<string, string>> = {};
        for (const r of body.responses) {
          newScores[r.taskNumber] = r.score != null ? String(r.score) : "";
          newComments[r.taskNumber] = r.comments ?? "";
          newIssues[r.taskNumber] = new Set(Array.isArray(r.issuesIdentified) ? r.issuesIdentified : []);
          newCriterionScores[r.taskNumber] = Object.fromEntries(
            Object.entries(r.criterionScores ?? {}).map(([criterionId, score]) => [criterionId, String(score)])
          );
        }
        setScores(newScores); setComments(newComments); setIssues(newIssues); setCriterionScores(newCriterionScores);
        // Default the active tab to the lowest task number present.
        const firstTask = Math.min(
          ...body.responses.map((r) => r.taskNumber),
          ...Object.keys(body.rubric?.tasks ?? {}).map(Number),
        );
        if (Number.isFinite(firstTask)) setActiveTask(firstTask);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [params.id, params.candidateId]);

  const saveTask = async (taskNumber: number) => {
    setSavingTask((s) => ({ ...s, [taskNumber]: true }));
    try {
      const latest = markingStateRef.current;
      const score = (latest.scores[taskNumber] ?? "") === "" ? null : Number(latest.scores[taskNumber]);
      const taskCriterionScores = Object.fromEntries(
        Object.entries(latest.criterionScores[taskNumber] ?? {})
          .filter(([, value]) => value !== "")
          .map(([criterionId, value]) => [criterionId, Number(value)])
      );
      const res = await fetch(`/api/admin/recruitment/${params.id}/mark/${params.candidateId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [`task${taskNumber}`]: {
            score,
            comments: latest.comments[taskNumber] || null,
            issuesIdentified: Array.from(latest.issues[taskNumber] ?? new Set<string>()),
            criterionScores: taskCriterionScores,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSavedAt((s) => ({ ...s, [taskNumber]: new Date().toISOString() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingTask((s) => ({ ...s, [taskNumber]: false }));
    }
  };

  // Debounced auto-save on score / comments / issues change
  const saveTimers = useRef<Record<number, ReturnType<typeof setTimeout> | null>>({});
  const triggerSave = (taskNumber: number) => {
    if (saveTimers.current[taskNumber]) clearTimeout(saveTimers.current[taskNumber] as any);
    saveTimers.current[taskNumber] = setTimeout(() => void saveTask(taskNumber), 1000);
  };

  if (error) return <Box error={error} />;
  if (!data) return <Box loading />;

  // Task numbers to mark = union of submitted responses and rubric tasks,
  // sorted ascending. Robust to a response with no rubric (failed-soft
  // rubric) or a rubric task with no response yet.
  const taskNums = Array.from(
    new Set<number>([
      ...data.responses.map((r) => r.taskNumber),
      ...Object.keys(data.rubric?.tasks ?? {}).map(Number),
      ...(data.scenarioTasks ?? []).map((t) => t.number),
    ]),
  ).sort((a, b) => a - b);

  const activeScenarioTask = (data.scenarioTasks ?? []).find((t) => t.number === activeTask);
  const activeKind = activeScenarioTask?.kind ?? "memo_ai";
  const assistantShort = data.assistantShortName || "IDSC";
  const responseForActive = data.responses.find((r) => r.taskNumber === activeTask);
  const rubricTask = data.rubric?.tasks[activeTask];
  const trailForActive = data.interactions.filter((i) => i.taskNumber === activeTask);
  const labSessionsForActive = (data.labSessions ?? []).filter((session) => session.taskNumber === activeTask);
  const hasLabForActive = activeScenarioTask?.labConfigured || labSessionsForActive.length > 0;
  const candidateMsgCount = trailForActive.filter((i) => i.actor === "candidate").length;
  const aiMsgCount = trailForActive.length - candidateMsgCount;
  const activityForActive = (data.activityEvents ?? []).filter(
    (e) => e.taskNumber === activeTask || e.taskNumber === null,
  );
  const reuseForActive = data.reuseByTask?.[activeTask] ?? null;
  // Opener delivery time for a chat task — the opener is config-level (not an
  // interaction), but a "chat_opened" activity event records when it was shown,
  // letting us measure the candidate's first response time.
  const chatOpenedForActive =
    (data.activityEvents ?? []).find(
      (e) => e.eventType === "chat_opened" && e.taskNumber === activeTask,
    )?.occurredAt ?? null;
  const issuesForTask: RubricIssue[] = rubricTask
    ? Object.values(rubricTask.categories).flatMap((c) => c.embedded_issues ?? [])
    : [];
  const criteriaForTask = (data.criterionMappings ?? []).filter(
    (mapping) => mapping.taskNumber === activeTask && mapping.maxMarks > 0
  );
  const criterionScoreTotal = criteriaForTask.reduce(
    (sum, mapping) => sum + (Number(criterionScores[activeTask]?.[mapping.criterionId]) || 0),
    0
  );

  const totalScore = taskNums.reduce(
    (sum, n) => sum + (Number(scores[n]) || 0),
    0,
  );

  return (
    <div className="h-[calc(100vh-4rem)] overflow-hidden text-uq flex flex-col">
      {/* Header */}
      <header className="bg-uq-glass-strong backdrop-blur-xl border-b border-uq shadow-[0_1px_0_0_var(--uq-inset-hi)_inset] flex-shrink-0 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs">
              <Link href={`/admin/recruitment/${params.id}/mark`} className="font-mono text-[11px] tracking-[0.04em] text-uq-accent hover:text-uq-accent-hover hover:underline underline-offset-2 focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)] focus-visible:rounded-md">← Marking list</Link>
            </div>
            <h1 className="text-xl font-semibold tracking-[-0.01em] text-uq mt-1">Marking · <span className="font-mono text-base text-uq-accent">{data.candidate.anonymousId}</span></h1>
            <div className="mt-1"><AssessmentModeBadge mode={data.assessment.assessmentMode} /></div>
            <div className="text-xs text-uq-3 mt-0.5">
              Time taken: {data.candidate.timeTakenMin ?? "—"} min · Submitted {data.candidate.submittedAt ? new Date(data.candidate.submittedAt).toLocaleString() : "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Total score</div>
            <div className="text-2xl font-semibold font-mono tabular-nums text-uq">
              {totalScore.toFixed(0)} <span className="text-base font-normal text-uq-3">/ {data.rubric?.total_marks ?? 100}</span>
            </div>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-6 pb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex gap-1 rounded-lg bg-uq-elev2 p-1">
            {taskNums.map((n) => (
              <button
                key={n}
                onClick={() => { setActiveTask(n); setReviewView("response"); }}
                className={[
                  "px-3 py-1.5 text-xs font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]",
                  activeTask === n
                    ? "bg-uq-elev1 text-uq shadow-uq-e1"
                    : "text-uq-2 hover:text-uq",
                ].join(" ")}
              >
                Task {n}
                {scores[n] && <span className="ml-2 font-mono tabular-nums text-uq-accent">{scores[n]}/{data.rubric?.tasks[n]?.max_marks ?? 50}</span>}
              </button>
            ))}
          </div>
          {activeKind === "memo_ai" && (
            <nav className="inline-flex items-center gap-1 rounded-lg border border-uq-faint bg-uq-elev1 p-1" aria-label="Review material">
              <ReviewTab active={reviewView === "response"} onClick={() => setReviewView("response")} label="Response" />
              <ReviewTab active={reviewView === "integrity"} onClick={() => setReviewView("integrity")} label="Evidence & integrity" />
              <ReviewTab active={reviewView === "dialogue"} onClick={() => setReviewView("dialogue")} label={`AI dialogue · ${candidateMsgCount}`} />
              {hasLabForActive && <ReviewTab active={reviewView === "lab"} onClick={() => setReviewView("lab")} label="Lab evidence" />}
              {data.defence && <ReviewTab active={reviewView === "defence"} onClick={() => setReviewView("defence")} label="Defence" />}
            </nav>
          )}
        </div>
      </header>

      {/* Body — 2 cols: candidate work + marking panel */}
      <div className="flex-1 min-h-0 grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] grid-cols-1">
        {/* Candidate work */}
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {activeKind === "email_inbox" ? (
            <InTraySection
              task={activeScenarioTask!}
              responses={data.emailResponses ?? []}
            />
          ) : activeKind === "chat" ? (
            <ChatTranscriptSection
              task={activeScenarioTask!}
              trail={trailForActive}
              openedAt={chatOpenedForActive}
            />
          ) : (
            <>
              {reviewView === "response" && (
                <section className="mx-auto w-full max-w-4xl rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-6">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Candidate response · Task {activeTask}</div>
                  <div className="text-lg font-semibold tracking-[-0.005em] text-uq mb-4">{rubricTask?.title ?? activeScenarioTask?.title}</div>
                  {responseForActive && responseForActive.content ? (
                    <div
                      className="memo-rendered"
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(responseForActive.content) }}
                    />
                  ) : (
                    <div className="text-sm text-uq-3 italic">No memo submitted for this task.</div>
                  )}
                  <div className="mt-5 border-t border-uq-faint pt-3 font-mono text-xs tabular-nums text-uq-3 flex items-center gap-2">
                    <span>{responseForActive?.wordCount ?? 0} words</span>
                    {responseForActive?.sentAt && (
                      <span className="text-[color:var(--uq-success-text)]">· sent {new Date(responseForActive.sentAt).toLocaleTimeString()}</span>
                    )}
                  </div>
                </section>
              )}

              {reviewView === "integrity" && (
                <>
                  <ActivitySection events={activityForActive} activeTask={activeTask} reuse={reuseForActive} />
                  <WorkProvenanceTimeline events={data.activityEvents} interactions={data.interactions} evidence={data.evidenceBoard} taskNumber={activeTask} />
                </>
              )}

              {reviewView === "lab" && <LabEvidence sessions={labSessionsForActive} taskNumber={activeTask} />}

              {reviewView === "defence" && (
                data.defence ? (
                  <DefenceSection defence={data.defence} declaration={data.candidate.toolDeclaration} declarationAt={data.candidate.toolDeclarationSubmittedAt} />
                ) : (
                  <section className="rounded-xl border border-uq bg-uq-elev1 p-5 text-sm italic text-uq-3">No defence was configured for this assessment.</section>
                )
              )}

              {reviewView === "dialogue" && <section className="rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-4">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Knowledge System interaction · Task {activeTask}</div>
                <div className="flex items-baseline justify-between gap-3 mb-3">
                  <div className="text-base font-semibold tracking-[-0.005em] text-uq">
                    {trailForActive.length} message{trailForActive.length === 1 ? "" : "s"}
                  </div>
                  {/* Speaker legend — pre-teaches the two-actor code before the marker reads. */}
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-uq-3 flex items-center gap-2">
                    <span className="text-uq-accent tabular-nums">
                      {candidateMsgCount} question{candidateMsgCount === 1 ? "" : "s"}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="flex items-center gap-1.5 text-[color:var(--uq-persona)]">
                      <span className="w-2.5 h-2.5 rounded-full shadow-uq-e1" style={{ backgroundImage: ORB_GRADIENT }} aria-hidden />
                      <span className="tabular-nums">{aiMsgCount}</span> {assistantShort} repl{aiMsgCount === 1 ? "y" : "ies"}
                    </span>
                  </div>
                </div>
                {trailForActive.length === 0 && (
                  <div className="text-sm text-uq-3 italic">No interactions for this task.</div>
                )}
                {/* Candidate questions (numbered indigo avatar + left rail) vs the IPAC
                    system's answers (gradient orb + violet label). Any non-candidate
                    actor renders as the system — today the only two are candidate/ai. */}
                <div className="space-y-2.5">
                  {(() => {
                    let q = 0;
                    return trailForActive.map((i) => {
                      const isCandidate = i.actor === "candidate";
                      const qNum = isCandidate ? ++q : null;
                      const time = new Date(i.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                      return (
                        <div key={i.id} className="flex gap-3 items-start">
                          {isCandidate ? (
                            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-uq-accent text-[color:var(--uq-text-on-accent)] flex items-center justify-center font-mono text-[11px] font-semibold tabular-nums shadow-uq-e1">
                              Q{qNum}
                            </span>
                          ) : (
                            <span
                              className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center shadow-uq-e1"
                              style={{ backgroundImage: ORB_GRADIENT }}
                              aria-hidden
                            >
                              <span className="w-2.5 h-2.5 rounded-full bg-white/90" />
                            </span>
                          )}
                          <div
                            className={
                              isCandidate
                                ? "flex-1 min-w-0 rounded-xl rounded-br-md border-l-[3px] border-[color:var(--uq-accent-line)] bg-[color:var(--uq-accent-soft)] px-3 py-2"
                                : "flex-1 min-w-0 rounded-xl rounded-bl-md border border-uq bg-uq-elev2 px-3 py-2"
                            }
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span
                                className={
                                  "font-mono text-[10px] uppercase tracking-[0.18em] " +
                                  (isCandidate ? "text-uq-accent" : "text-[color:var(--uq-persona)]")
                                }
                              >
                                {isCandidate ? "Candidate" : `${assistantShort} system`} · #{i.sequenceNum}
                              </span>
                              <span className="flex-shrink-0 font-mono text-[10px] tabular-nums tracking-[0.04em] text-uq-3">
                                {time}
                              </span>
                            </div>
                            {isCandidate ? (
                              <div className="text-sm leading-relaxed text-uq whitespace-pre-wrap mt-1">
                                {i.content}
                              </div>
                            ) : (
                              <div className="markdown-rendered text-uq mt-1">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{i.content}</ReactMarkdown>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </section>}
            </>
          )}

          {(activeKind === "email_inbox" || activeKind === "chat") && (
            <ActivitySection events={activityForActive} activeTask={activeTask} reuse={reuseForActive} />
          )}
        </div>

        {/* Marking panel */}
        <div className="border-l border-uq bg-uq-bg2 overflow-y-auto">
          <div className="p-5 space-y-5">
            <section className="rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-4">
              <h2 className="text-base font-semibold tracking-[-0.005em] text-uq mb-3">
                {rubricTask ? `Score · Task ${activeTask}` : `Notes · Task ${activeTask}`}
              </h2>
              {rubricTask ? (
                <label className="block text-xs">
                  <span className="text-uq-2">Score (out of {rubricTask?.max_marks ?? 50})</span>
                  <input
                    type="number"
                    min={0}
                    max={rubricTask?.max_marks ?? 50}
                    step="0.5"
                    value={scores[activeTask] ?? ""}
                    onChange={(e) => {
                      setScores((prev) => ({ ...prev, [activeTask]: e.target.value }));
                      triggerSave(activeTask);
                    }}
                    className="mt-1 block w-32 rounded-md border border-uq bg-uq-glass-subtle px-3 py-1.5 text-base font-mono tabular-nums text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1"
                  />
                </label>
              ) : (
                <p className="text-xs leading-relaxed text-uq-2">
                  Observational task - not scored. Record what the candidate did (what they protected, deferred, delegated or handled) in the notes below; score judgement, not speed or volume.
                </p>
              )}
              {criteriaForTask.length > 0 && (
                <div className="mt-4 rounded-lg border border-uq-faint bg-uq-elev2 p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium text-uq">Criterion scores</div>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-uq-3">
                        Human-entered component scores for descriptive pilot distributions. Keep their total aligned with the task score.
                      </p>
                    </div>
                    <span className="flex-shrink-0 font-mono text-xs tabular-nums text-uq-accent">
                      {criterionScoreTotal}/{criteriaForTask.reduce((sum, mapping) => sum + mapping.maxMarks, 0)}
                    </span>
                  </div>
                  <div className="mt-3 space-y-3">
                    {criteriaForTask.map((mapping) => (
                      <label key={mapping.criterionId} className="grid grid-cols-[1fr_5.5rem] items-start gap-3 text-xs">
                        <span>
                          <span className="block font-medium text-uq">{mapping.code} · {mapping.name}</span>
                          <span className="mt-0.5 block leading-relaxed text-uq-3">{mapping.expectedCandidateEvidence}</span>
                        </span>
                        <span>
                          <span className="sr-only">Score for {mapping.name}, out of {mapping.maxMarks}</span>
                          <span className="flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              max={mapping.maxMarks}
                              step="0.5"
                              value={criterionScores[activeTask]?.[mapping.criterionId] ?? ""}
                              onChange={(event) => {
                                setCriterionScores((previous) => ({
                                  ...previous,
                                  [activeTask]: {
                                    ...(previous[activeTask] ?? {}),
                                    [mapping.criterionId]: event.target.value,
                                  },
                                }));
                                triggerSave(activeTask);
                              }}
                              className="block w-16 rounded-md border border-uq bg-uq-glass-subtle px-2 py-1.5 font-mono tabular-nums text-uq focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)]"
                            />
                            <span className="font-mono text-[11px] text-uq-3">/{mapping.maxMarks}</span>
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <label className="block text-xs mt-3">
                <span className="text-uq-2">Comments / notes</span>
                <textarea
                  value={comments[activeTask] ?? ""}
                  onChange={(e) => {
                    setComments((prev) => ({ ...prev, [activeTask]: e.target.value }));
                    triggerSave(activeTask);
                  }}
                  rows={6}
                  className="mt-1 block w-full rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1"
                />
              </label>
              <div className={`mt-2 font-mono text-[11px] tracking-[0.04em] ${savingTask[activeTask] ? "text-uq-accent animate-uq-pulse-glow" : savedAt[activeTask] ? "text-[color:var(--uq-success-text)]" : "text-uq-3"}`}>
                {savingTask[activeTask] ? "Saving…" : savedAt[activeTask] ? `Saved ${new Date(savedAt[activeTask]!).toLocaleTimeString()}` : "Auto-saves on change"}
              </div>
            </section>

            {issuesForTask.length > 0 && (
              <section className="rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-4">
                <h2 className="text-base font-semibold tracking-[-0.005em] text-uq">Embedded issues identified</h2>
                <p className="text-xs leading-relaxed text-uq-2 mt-1 mb-3">
                  Tick the issues this candidate identified. Used for cohort analytics — does not affect the score.
                </p>
                <div className="space-y-2">
                  {issuesForTask.map((iss) => (
                    <label key={iss.id} className="flex items-start gap-2 text-sm text-uq cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(issues[activeTask] ?? new Set<string>()).has(iss.id)}
                        onChange={(e) => {
                          setIssues((prev) => {
                            const next = new Set(prev[activeTask] ?? []);
                            if (e.target.checked) next.add(iss.id); else next.delete(iss.id);
                            return { ...prev, [activeTask]: next };
                          });
                          triggerSave(activeTask);
                        }}
                        className="mt-0.5 h-4 w-4 rounded border-uq bg-uq-glass-subtle text-uq-accent accent-[color:var(--uq-accent)] focus:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
                      />
                      <span>
                        <span className="font-medium text-uq">{iss.title}</span>
                        {iss.max_marks != null && <span className="font-mono text-xs tabular-nums text-uq-3 ml-1">({iss.max_marks}m)</span>}
                        {iss.description && <span className="block text-xs text-uq-2">{iss.description}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            {rubricTask && (
              <section className="rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-4">
                <h2 className="text-base font-semibold tracking-[-0.005em] text-uq">Rubric reference</h2>
                <div className="mt-3 space-y-3 text-xs">
                  {Object.entries(rubricTask.categories).map(([key, cat]) => (
                    <details key={key} className="border border-uq rounded-lg overflow-hidden">
                      <summary className="cursor-pointer px-3 py-1.5 bg-uq-elev2 text-uq-2 font-medium flex items-center justify-between hover:text-uq hover:bg-uq-bg2 transition-colors">
                        <span>{key.replace(/_/g, " ")}</span>
                        <span className="font-mono tabular-nums text-uq-accent">{cat.max}m</span>
                      </summary>
                      <div className="p-3 space-y-2">
                        {cat.description && <div className="text-uq-2">{cat.description}</div>}
                        {cat.embedded_issues && cat.embedded_issues.length > 0 && (
                          <div className="space-y-2">
                            {cat.embedded_issues.map((iss) => (
                              <div key={iss.id} className="border-l-2 border-uq-faint pl-2">
                                <div className="font-medium text-uq">
                                  {iss.title}
                                  {iss.max_marks != null && <span className="font-mono tabular-nums text-uq-3 font-normal ml-1">({iss.max_marks}m)</span>}
                                </div>
                                {iss.expected && (
                                  <div className="text-uq-2 mt-0.5">
                                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-uq-3">Model answer: </span>{iss.expected}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {cat.descriptors && Object.entries(cat.descriptors).map(([range, text]) => (
                          <div key={range} className="text-uq-2"><span className="font-mono tabular-nums text-uq-accent">{range}:</span> {text}</div>
                        ))}
                        {cat.rubric && Object.entries(cat.rubric).map(([range, text]) => (
                          <div key={range} className="text-uq-2"><span className="font-mono tabular-nums text-uq-accent">{range}:</span> {text}</div>
                        ))}
                        {cat.indicators && (
                          <ul className="list-disc pl-4 text-uq-2 marker:text-uq-accent">
                            {cat.indicators.map((ind, i) => <li key={i}>{ind}</li>)}
                          </ul>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Box({ loading, error }: { loading?: boolean; error?: string }) {
  return (
    <div className="max-w-3xl mx-auto p-8">
      {loading && <div className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-uq-3 animate-uq-pulse-glow">Loading…</div>}
      {error && <div className="rounded-lg border border-[color:var(--uq-danger-line)] bg-[color:var(--uq-danger-soft)] text-[color:var(--uq-danger-text)] text-sm px-3 py-2 animate-uq-rise">{error}</div>}
    </div>
  );
}

function ReviewTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)] ${
        active ? "bg-uq-elev2 text-uq shadow-uq-e1" : "text-uq-2 hover:bg-uq-elev2 hover:text-uq"
      }`}
    >
      {label}
    </button>
  );
}

function DefenceSection({ defence, declaration, declarationAt }: { defence: DefenceRow; declaration: MarkData["candidate"]["toolDeclaration"]; declarationAt: string | null }) {
  const answers = new Map(defence.answers.map((answer) => [answer.questionId, answer]));
  return (
    <section className="rounded-xl border border-uq bg-uq-elev1 p-4 shadow-uq-glass">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Human-reviewed reasoning</div>
      <div className="text-base font-semibold text-uq">Written defence</div>
      <p className="mt-1 text-xs text-uq-3">{defence.personalised ? "Personalised questions" : "Published fallback questions"} · not auto-scored</p>
      <div className="mt-4 space-y-4">
        {defence.questions.map((question, index) => {
          const answer = answers.get(question.id);
          return (
            <article key={question.id} className="rounded-xl border border-uq-faint bg-uq-elev2 p-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-uq-3">Question {index + 1}</div>
              <p className="mt-1 font-medium leading-relaxed text-uq">{question.text}</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-uq-2">{answer?.text || "No answer submitted."}</p>
              {answer?.savedAt && <time className="mt-2 block font-mono text-[10px] text-uq-3">Saved {new Date(answer.savedAt).toLocaleString()}</time>}
            </article>
          );
        })}
      </div>
      {declaration && (
        <div className="mt-4 rounded-xl border border-uq-faint bg-uq-elev2 p-3 text-xs text-uq-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-uq-3">Self-declared tool use{declarationAt ? ` · ${new Date(declarationAt).toLocaleString()}` : ""}</div>
          <p className="mt-1">{declaration.tools?.length ? declaration.tools.join(", ").replace(/([a-z])([A-Z])/g, "$1 $2") : "No tools selected."}</p>
          {declaration.otherText && <p className="mt-1 whitespace-pre-wrap">{declaration.otherText}</p>}
        </div>
      )}
    </section>
  );
}

function ActivitySection({ events, activeTask, reuse }: { events: ActivityEvent[]; activeTask: number; reuse: ReuseResult | null }) {
  // The reuse box / breakdown self-hide for non-memo tasks (email_inbox/chat
  // have no memo response, so no reuse entry) and for empty memos.
  const showReuse = reuse != null && reuse.numSentences > 0;
  const pasteCount = events.filter((e) => e.eventType === "paste").length;
  const pasteChars = events
    .filter((e) => e.eventType === "paste")
    .reduce((sum, e) => sum + (typeof e.metadata?.charCount === "number" ? (e.metadata.charCount as number) : 0), 0);
  const hiddenCount = events.filter((e) => e.eventType === "visibility_hidden").length;
  const hiddenTotalMs = events
    .filter((e) => e.eventType === "visibility_visible")
    .reduce((sum, e) => sum + (typeof e.metadata?.hiddenMs === "number" ? (e.metadata.hiddenMs as number) : 0), 0);

  return (
    <section className="rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Workspace record · Task {activeTask}</div>
      <div className="text-base font-semibold tracking-[-0.005em] text-uq">Work provenance</div>
      <p className="mb-3 mt-1 text-xs leading-relaxed text-uq-3">Contextual evidence only. Focus changes and paste activity may have legitimate explanations; pasted content is not recorded.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs">
        <div className="bg-uq-elev2 border border-uq-faint rounded-lg px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Paste activity</div>
          <div className="text-base font-semibold font-mono tabular-nums text-uq">
            {pasteCount}
            {pasteCount > 0 && <span className="text-xs font-normal text-uq-3"> · {pasteChars.toLocaleString()} chars</span>}
          </div>
        </div>
        <div className="bg-uq-elev2 border border-uq-faint rounded-lg px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Focus changes</div>
          <div className="text-base font-semibold font-mono tabular-nums text-uq">{hiddenCount}</div>
        </div>
        <div className="bg-uq-elev2 border border-uq-faint rounded-lg px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Time out of focus</div>
          <div className="text-base font-semibold font-mono tabular-nums text-uq">{formatDuration(hiddenTotalMs)}</div>
        </div>
        {showReuse && (
          <div className="bg-uq-elev2 border border-uq-faint rounded-lg px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Visible output overlap</div>
            <div className="text-base font-semibold font-mono tabular-nums text-uq">
              {Math.round(reuse!.reuseRatio * 100)}%
              <span className="text-xs font-normal text-uq-3"> · {reuse!.numReusedSentences}/{reuse!.numSentences} sent</span>
            </div>
          </div>
        )}
      </div>

      {events.length === 0 ? (
        <div className="text-sm text-uq-3 italic">No activity events recorded.</div>
      ) : (
        <details>
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.12em] text-uq-2 hover:text-uq select-none transition-colors">Show event log ({events.length})</summary>
          <ol className="mt-2 space-y-1 text-xs text-uq-2 font-mono max-h-64 overflow-y-auto">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="text-uq-3">{new Date(e.occurredAt).toLocaleTimeString()}</span>
                <span>{formatActivityEvent(e)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {showReuse && (
        <details className="mt-2">
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.12em] text-uq-2 hover:text-uq select-none transition-colors">
            Visible Knowledge System output overlap · sentence detail
          </summary>
          <ol className="mt-2 space-y-2 text-xs max-h-80 overflow-y-auto">
            {[...reuse!.sentences]
              .sort((a, b) => Number(b.isReused) - Number(a.isReused) || b.similarity - a.similarity)
              .map((s, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-uq-faint bg-uq-elev2 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-uq">{s.memoSentence}</span>
                    <span className="flex-shrink-0 font-mono tabular-nums text-uq-3">
                      {Math.round(s.similarity * 100)}%
                    </span>
                  </div>
                  {s.isReused && s.bestAiSentence && (
                    <div className="mt-1 border-l-2 border-uq-faint pl-2 text-uq-2">
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-uq-3">Matched AI: </span>
                      {s.bestAiSentence}
                    </div>
                  )}
                </li>
              ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function formatActivityEvent(e: ActivityEvent): string {
  const meta = e.metadata ?? {};
  if (e.eventType === "paste") {
    const target = typeof meta.target === "string" ? meta.target : "unknown";
    const chars = typeof meta.charCount === "number" ? meta.charCount : 0;
    return `paste into ${target} (${chars.toLocaleString()} chars)`;
  }
  if (e.eventType === "visibility_hidden") return "tab hidden";
  if (e.eventType === "visibility_visible") {
    const ms = typeof meta.hiddenMs === "number" ? meta.hiddenMs : 0;
    return `tab visible (after ${formatDuration(ms)})`;
  }
  return e.eventType;
}

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

function actionChip(action: string): { label: string; cls: string } {
  if (action === "replied") {
    return { label: "Replied", cls: "bg-[color:var(--uq-success-soft)] border-[color:var(--uq-success-line)] text-[color:var(--uq-success-text)]" };
  }
  if (action === "flagged") {
    return { label: "Flagged", cls: "bg-[color:var(--uq-warn-soft)] border-[color:var(--uq-warn-line)] text-[color:var(--uq-warn-text)]" };
  }
  return { label: "Ignored", cls: "bg-uq-elev2 border-uq text-uq-3" };
}

// The candidate's in-tray triage: every scripted email, what the candidate
// did with it (replied / flagged / ignored / no action), and the marker's
// expected handling. Observational — informs the marker, never auto-scored.
function InTraySection({ task, responses }: { task: ScenarioTask; responses: EmailResponseRow[] }) {
  const emails = task.emails ?? [];
  const byId = new Map(responses.map((r) => [r.emailId, r]));
  const handled = emails.filter((e) => byId.has(e.id)).length;
  return (
    <section className="rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">In-tray · Task {task.number}</div>
      <div className="text-base font-semibold tracking-[-0.005em] text-uq mb-3">
        {handled} of {emails.length} item{emails.length === 1 ? "" : "s"} actioned
      </div>
      <div className="space-y-3">
        {emails.map((e) => {
          const r = byId.get(e.id);
          const chip = r ? actionChip(r.action) : { label: "No action", cls: "bg-uq-elev2 border-uq text-uq-3" };
          return (
            <div key={e.id} className="rounded-lg border border-uq bg-uq-bg2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-uq">{e.subject}</div>
                  <div className="text-xs text-uq-3">From {e.senderName} &lt;{e.senderEmail}&gt;</div>
                </div>
                <span className={`flex-shrink-0 px-2 py-0.5 rounded-full border font-mono text-[10px] ${chip.cls}`}>{chip.label}</span>
              </div>
              {r?.action === "replied" && r.replyBody && (
                <div className="mt-2 rounded-md border border-uq-faint bg-uq-elev1 p-2 text-sm text-uq whitespace-pre-wrap">{r.replyBody}</div>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-uq-3 hover:text-uq">
                  Marker reference · expected: {e.expectedAction}
                </summary>
                <div className="mt-1 text-xs text-uq-2 whitespace-pre-wrap">{e.markerNotes ?? "—"}</div>
              </details>
            </div>
          );
        })}
        {emails.length === 0 && <div className="text-sm text-uq-3 italic">No in-tray items in this scenario.</div>}
      </div>
    </section>
  );
}

// The live persona conversation (e.g. the Staff Council president). The opener
// is config-level (not stored as an interaction), so we render it first, then
// the stored back-and-forth, then the marker's "what to look for".
function ChatTranscriptSection({ task, trail, openedAt }: { task: ScenarioTask; trail: Interaction[]; openedAt: string | null }) {
  const persona = task.persona;

  // Per-message timing: the gap from the previous message (or the opener, for
  // the first message) to this one. The gap before a candidate message is the
  // candidate's response time; before a persona message it's the reply latency.
  // Timestamps are server-recorded, so gaps include network/model latency.
  const openedMs = openedAt ? new Date(openedAt).getTime() : null;
  let prevMs: number | null = openedMs;
  const timed = trail.map((i) => {
    const thisMs = new Date(i.timestamp).getTime();
    let gapMs: number | null = prevMs != null ? thisMs - prevMs : null;
    if (gapMs != null && gapMs < 0) gapMs = null; // guard against clock skew
    prevMs = thisMs;
    return {
      i,
      gapMs,
      time: new Date(i.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
  });

  const candidateGaps = timed
    .filter((t) => t.i.actor === "candidate" && t.gapMs != null)
    .map((t) => t.gapMs as number);
  const firstCandidateGap = timed.find((t) => t.i.actor === "candidate")?.gapMs ?? null;
  const avgCandidateGap = candidateGaps.length
    ? Math.round(candidateGaps.reduce((s, g) => s + g, 0) / candidateGaps.length)
    : null;
  const openerTime =
    openedMs != null ? new Date(openedMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <section className="rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Live chat · Task {task.number}</div>
      <div className="text-base font-semibold tracking-[-0.005em] text-uq">{persona?.personaName}</div>
      <div className={`font-mono text-[11px] text-uq-3 ${avgCandidateGap != null ? "" : "mb-3"}`}>{persona?.personaRole}</div>
      {avgCandidateGap != null && (
        <div
          className="font-mono text-[10px] uppercase tracking-[0.16em] text-uq-3 mt-1 mb-3 flex items-center gap-2 flex-wrap"
          title="Candidate response time — server-recorded, so it includes network/processing time"
        >
          <span className="text-uq-accent">Candidate response</span>
          {firstCandidateGap != null && <span>· first {formatDuration(firstCandidateGap)}</span>}
          <span>· avg {formatDuration(avgCandidateGap)}</span>
        </div>
      )}
      <div className="space-y-2">
        {persona?.openerMessage && (
          <div className="border-l-4 border-uq-faint pl-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3 flex items-baseline justify-between gap-2">
              <span>{persona.personaName} · opener</span>
              {openerTime && <span className="normal-case tracking-normal tabular-nums">{openerTime}</span>}
            </div>
            <div className="text-sm text-uq mt-0.5 whitespace-pre-wrap">{persona.openerMessage}</div>
          </div>
        )}
        {timed.map(({ i, gapMs, time }) => {
          const isCandidate = i.actor === "candidate";
          return (
            <div key={i.id} className={isCandidate ? "border-l-4 border-uq-accent pl-3" : "border-l-4 border-uq-faint pl-3"}>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3 flex items-baseline justify-between gap-2">
                <span>{isCandidate ? "Candidate" : persona?.personaName ?? "Persona"} · #{i.sequenceNum}</span>
                <span className="flex items-baseline gap-2 normal-case tracking-normal tabular-nums">
                  {gapMs != null &&
                    (isCandidate ? (
                      <span className="text-uq-accent" title="Time the candidate took to respond (server-recorded)">responded in {formatDuration(gapMs)}</span>
                    ) : (
                      <span className="text-uq-3" title="Time until this reply (includes network/model latency)">+{formatDuration(gapMs)}</span>
                    ))}
                  <span className="text-uq-3">{time}</span>
                </span>
              </div>
              <div className="text-sm text-uq mt-0.5 whitespace-pre-wrap">{i.content}</div>
            </div>
          );
        })}
        {trail.length === 0 && <div className="text-sm text-uq-3 italic">The candidate did not reply in the chat.</div>}
      </div>
      {persona?.expectedOutcomes && (
        <details className="mt-3">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-uq-3 hover:text-uq">Marker reference — what to look for</summary>
          <div className="mt-1 text-xs text-uq-2 whitespace-pre-wrap">{persona.expectedOutcomes}</div>
        </details>
      )}
    </section>
  );
}
