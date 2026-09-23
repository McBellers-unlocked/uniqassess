"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import AssessmentView from "@/components/recruit/AssessmentView";
import CandidateDefenceView from "@/components/recruit/CandidateDefenceView";
import { AssessmentModeDisclosure } from "@/components/recruit/AssessmentModeBadge";
import { getAssessmentModePolicy } from "@/lib/recruit/assessment-modes";

export default function AssessRouterPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-uq-3">Loading…</div>}>
      <AssessRouter />
    </Suspense>
  );
}

function AssessRouter() {
  const params = useParams<{ scenarioSlug: string }>();
  const search = useSearchParams();
  const token = search.get("token") || "";
  const [stateData, setStateData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    if (!token) {
      setError("Your assessment URL is missing a token. Check the link from your invitation email.");
      return;
    }
    try {
      const res = await fetch(`/api/assess/state/${encodeURIComponent(token)}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setStateData(body);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);

  useEffect(() => { void reload(); }, [reload]);

  const begin = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/assess/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-uq-danger-line bg-uq-elev3 shadow-uq-pop p-6">
          <div className="text-uq-danger-text font-semibold mb-2">Cannot start assessment</div>
          <div className="text-sm text-uq-2">{error}</div>
          <div className="text-xs text-uq-3 mt-4">Token: <code className="font-mono bg-uq-glass-subtle border border-uq-faint text-uq-cyan px-1 rounded">{token || "(missing)"}</code></div>
        </div>
      </div>
    );
  }
  if (!stateData) return <div className="min-h-screen flex items-center justify-center text-sm text-uq-3 font-mono uppercase tracking-[0.18em]">Loading assessment…</div>;

  // Pre-start: landing
  if (stateData.stage === "invited") {
    return (
      <Landing
        scenario={stateData.scenario}
        assessment={stateData.assessment}
        anonymousId={stateData.candidate.anonymousId}
        acknowledge={acknowledge}
        setAcknowledge={setAcknowledge}
        onBegin={() => void begin()}
        starting={starting}
      />
    );
  }

  // Submitted / expired
  if (stateData.stage === "submitted" || stateData.stage === "expired" || stateData.candidate?.submittedAt) {
    return <Submitted submittedAt={stateData.candidate?.submittedAt} anonymousId={stateData.candidate?.anonymousId} />;
  }

  if (stateData.stage === "defence" && stateData.defence) {
    return <CandidateDefenceView token={token} initial={stateData} onReload={reload} />;
  }

  // In progress
  return <AssessmentView token={token} initial={stateData} onReload={reload} />;
}

/* ------------------------------------------------------------------ */

function Landing({
  scenario, assessment, anonymousId, acknowledge, setAcknowledge, onBegin, starting,
}: {
  scenario: {
    title: string; organisation: string; positionTitle: string; taskCount: number;
    memoTaskCount?: number; hasLiveMessage?: boolean; practicalTaskCount?: number; source?: "code" | "db";
    assistantName?: string | null; assistantShortName?: string | null;
  };
  assessment: { title: string; totalMinutes: number; closeDate: string; assessmentMode: "EVIDENCE" | "COPILOT" | "OPEN_AGENT"; defenceEnabled: boolean; defenceMinutes: number };
  anonymousId: string;
  acknowledge: boolean;
  setAcknowledge: (v: boolean) => void;
  onBegin: () => void;
  starting: boolean;
}) {
  // Scenario-driven branding + structure. Falls back to the IDSC defaults so
  // the IDSC built-ins render exactly as before; a scenario in another org
  // (e.g. IPAC) carries its own brand, and only scenarios with a chat task
  // show the live-message guidance.
  const ksName = scenario.assistantName || "IDSC Knowledge System";
  const shortName = scenario.assistantShortName || "IDSC";
  const memoCount = scenario.memoTaskCount ?? scenario.taskCount;
  const practicalCount = scenario.practicalTaskCount ?? 0;
  const hasLabs = practicalCount > 0;
  const customScenario = scenario.source === "db";
  const hasIm = scenario.hasLiveMessage ?? false;
  const modePolicy = getAssessmentModePolicy(assessment.assessmentMode);
  const memoCountWord = memoCount === 1 ? "one" : memoCount === 2 ? "two" : memoCount === 3 ? "three" : String(memoCount);
  return (
    <div className="min-h-screen text-uq">
      <header className="bg-uq-glass-strong backdrop-blur-xl border-b border-uq shadow-[0_1px_0_0_var(--uq-inset-hi)_inset]">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <span className="bg-white rounded-md px-2 py-1 inline-flex items-center ring-1 ring-uq shadow-uq-glow-soft">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/logos/uniqassess-logo.png"
              alt="UNIQAssess"
              width={220}
              height={60}
              className="h-10 w-auto"
            />
          </span>
          <span className="font-mono text-xs text-uq-2">{anonymousId}</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <div className="rounded-2xl border border-uq bg-uq-elev1 shadow-uq-glass p-7">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-accent">Technical Assessment</div>
          <h1 className="text-2xl font-semibold tracking-[-0.01em] text-uq mt-1 mb-1">{scenario.positionTitle}</h1>
          <div className="text-sm text-uq-2">{scenario.organisation}</div>
          <div className="text-xs text-uq-3 italic mt-1">
            {hasLabs ? "The services and data in this practical assessment are fictional. Work only in your assigned lab environments."
              : customScenario ? `Use the ${scenario.organisation || "assessment"} context and materials provided in the task briefs.`
                : `${shortName} is a fictionalised entity modelled on a real UN-system centre. All names, figures, and internal details are invented for this assessment — cross-referencing the real-world organisation will not help.`}
          </div>

          <div className="mt-6 grid sm:grid-cols-3 gap-3 text-sm">
            <div className="bg-uq-glass-subtle border border-uq rounded-xl p-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-uq-3">Duration</div>
              <div className="text-lg font-semibold text-uq">{assessment.totalMinutes} minutes</div>
              <div className="text-xs text-uq-3 mt-0.5">Single continuous timer</div>
            </div>
            <div className="bg-uq-glass-subtle border border-uq rounded-xl p-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-uq-3">Tasks</div>
              <div className="text-lg font-semibold text-uq">{memoCount}</div>
              <div className="text-xs text-uq-3 mt-0.5">{hasIm ? "Switch freely · + a live message" : "Switch freely"}</div>
            </div>
            <div className="bg-uq-glass-subtle border border-uq rounded-xl p-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-uq-3">Closes</div>
              <div className="text-lg font-semibold text-uq">
                {new Date(assessment.closeDate).toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                })}
              </div>
              <div className="text-xs text-uq-3 mt-0.5">Window deadline</div>
            </div>
          </div>

          <div className="mt-5"><AssessmentModeDisclosure mode={assessment.assessmentMode} /></div>

          {assessment.defenceEnabled && (
            <div className="mt-4 rounded-xl border border-uq bg-uq-glass-subtle p-4 text-sm text-uq-2">
              After the {assessment.totalMinutes}-minute main assessment, your work will lock and a separate {assessment.defenceMinutes}-minute written reasoning defence will begin. It contains exactly two questions and is reviewed by a human.
            </div>
          )}

          <div className="mt-7 prose prose-sm max-w-none text-uq-2">
            <h2 className="text-base font-semibold text-uq">What to expect</h2>
            <p>
              This assessment has <strong>{memoCountWord} {hasLabs ? practicalCount === memoCount ? "practical" : "written and practical" : "written"} {memoCount === 1 ? "task" : "tasks"}{hasLabs ? " with written deliverables" : ""}</strong>. You have <strong>{assessment.totalMinutes} minutes total</strong>.
              You may switch between tasks at any time and divide the time as you see fit — time management is
              part of what is being assessed.
            </p>
            <p>For each {hasLabs ? "task" : "written task"} you will have:</p>
            <ul className="text-sm list-disc pl-5">
              <li>{hasLabs ? "A task brief and supporting technical materials describing the service, required work and evidence to retain." : customScenario ? "An exhibit document and supporting materials relevant to your task." : "An exhibit document — for example a contract, a financial statement, a report, or a briefing pack."}</li>
              {hasLabs && <li>Access to the assigned practical lab when required by the task. Your commands, results and final lab state are retained as assessment evidence.</li>}
              <li>{hasLabs ? `Optional support from the ${ksName}, an in-app AI assistant, within the ${modePolicy.label} policy above. It cannot operate your lab or replace your own practical evidence.` : `The ${ksName} — an in-app AI assistant holding the underlying data, text, and reference material. Ask it specific questions; it will not volunteer issues for you.`}</li>
              <li>A workspace for your written deliverable. It autosaves every few seconds — and you can <strong>Send</strong> {hasLabs ? "your deliverable" : "a memo"} when you are done with it to move on to the next.</li>
            </ul>
            {hasIm && (
              <p>
                <strong>A colleague may message you during the assessment.</strong> At some point a member of staff
                may contact you directly through an in-app chat (similar to MS Teams) — it will pop up while you
                work. Read it, decide whether and how to reply, and respond in the chat. How you handle the
                interruption — what you commit to, and how you balance it against your written work — is part of
                what is assessed.
              </p>
            )}
            <p>
              {hasLabs ? "An assessor reviews your written responses alongside your recorded practical evidence. Any Knowledge System interactions are recorded for contextual review."
                : "Your responses are evaluated holistically. There is no pass mark — your work will be ranked alongside other candidates. The way you investigate (the AI interaction) is recorded and reviewed alongside your written response."}
            </p>

            <h2 className="text-base font-semibold text-uq mt-5">Important</h2>
            <ul className="text-sm list-disc pl-5">
              <li>Once you click <strong>Begin</strong> the {assessment.totalMinutes}-minute timer starts and cannot be paused.</li>
              <li>You may close your browser and return — your work and timer continue server-side.</li>
              <li>This URL is single-use. If a different browser tries to use the same link, it will be locked out.</li>
              <li>{hasLabs ? `Using the ${ksName} is optional. You remain responsible for the lab work, evidence and written deliverables you submit.` : `You are expected to use the ${ksName} (the in-app AI assistant) as part of your work — your interaction trail forms part of the assessment.`}</li>
              {hasIm && (
                <li>A colleague may contact you by chat during the assessment. Treat it as a real interruption — read it, reply in the chat as you see fit, and return to your work. Your reply, and how you manage it alongside your written tasks, is recorded and reviewed.</li>
              )}
              <li>{modePolicy.externalAiPermitted ? "External AI tools are permitted under this assessment's declared instructions. The platform does not claim to identify every external tool you use; you will provide a brief declaration." : "External AI tools (for example ChatGPT, Claude, Gemini or Copilot) and online lookups are not permitted."} Workspace activity records paste character counts, focus changes and Knowledge System interactions for contextual human review; pasted content itself is not recorded.</li>
              {assessment.defenceEnabled && <li>Completing the main work locks it permanently before the separate defence clock begins.</li>}
              <li>When time expires, your responses are submitted automatically.</li>
            </ul>
          </div>

          <details className="mt-6 border border-uq rounded-xl bg-uq-glass-subtle">
            <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-uq select-none">
              Privacy and data use
            </summary>
            <div className="px-4 pb-4 pt-1 text-sm text-uq-2 space-y-2">
              <p>
                <strong>What we collect:</strong> your name and email (from the recruitment panel), your written
                responses, every message you exchange with the in-app AI assistant, and activity events during the
                assessment (tab-switches and the length of any pasted content — pasted text itself is not stored).
                {hasLabs && " Practical lab commands, outputs and final lab state are also retained for assessment review."}
              </p>
              <p>
                <strong>Where it goes:</strong> your prompts and the assistant&rsquo;s replies are processed via the
                Anthropic Claude API in order to generate responses. All candidate data is stored in our AWS RDS
                database (UK/EU region).
              </p>
              <p>
                <strong>Who sees it:</strong> the recruitment panel (examiners) and authorised UNIQAssess
                administrators. During marking, examiners see you only by an anonymous identifier
                (e.g. &ldquo;{anonymousId}&rdquo;); your name and email are hidden from them.
              </p>
              <p>
                <strong>How long we keep it:</strong> your written responses, AI interactions, and activity logs are
                retained for <strong>24 months after submission</strong>, then deleted. Anonymised, aggregate statistics
                (e.g. cohort benchmarks) may be retained beyond that point.
              </p>
              <p>
                <strong>Your rights:</strong> to request access to, correction of, or deletion of your personal data,
                email{" "}
                <a href="mailto:personnel@unicc.org" className="text-uq-accent underline">personnel@unicc.org</a>.
              </p>
            </div>
          </details>

          <label className="flex items-start gap-2 mt-6 text-sm text-uq-2">
            <input
              type="checkbox"
              checked={acknowledge}
              onChange={(e) => setAcknowledge(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-uq bg-uq-glass-subtle accent-[color:var(--uq-accent)] focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
            />
            <span>I have read the {modePolicy.label} policy, understand which tools are permitted, understand that workspace provenance is recorded for contextual human review, and accept responsibility for the work I submit.</span>
          </label>

          <div className="mt-6 flex items-center justify-end">
            <button
              onClick={onBegin}
              disabled={!acknowledge || starting}
              className="px-6 py-2.5 rounded-lg bg-uq-accent text-[color:var(--uq-text-on-accent)] text-sm font-medium shadow-uq-glow-soft transition-all duration-150 hover:bg-uq-accent-hover hover:shadow-uq-glow active:translate-y-px disabled:bg-uq-elev2 disabled:text-uq-3 disabled:shadow-none disabled:cursor-not-allowed focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
            >
              {starting ? "Starting…" : `Begin assessment (${assessment.totalMinutes} min)`}
            </button>
          </div>
        </div>

        <div className="text-xs text-uq-3 text-center mt-6">
          Powered by UNIQAssess · Your responses and AI interactions are recorded for assessment purposes.
        </div>
      </main>
    </div>
  );
}

function Submitted({ submittedAt, anonymousId }: { submittedAt?: string | null; anonymousId?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-xl rounded-2xl border border-uq bg-uq-elev1 shadow-uq-glass p-8 text-center">
        <div className="font-mono text-uq-accent text-[10px] uppercase tracking-[0.18em]">Assessment complete</div>
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-uq mt-2">Thank you</h1>
        <p className="text-sm text-uq-2 mt-3">
          Your assessment has been submitted. The selection panel will be in touch in due course.
        </p>
        {submittedAt && (
          <div className="mt-5 text-xs text-uq-3 font-mono">
            Submitted at {new Date(submittedAt).toLocaleString()}
          </div>
        )}
        {anonymousId && (
          <div className="font-mono text-xs text-uq-3 mt-1">Reference: {anonymousId}</div>
        )}
      </div>
    </div>
  );
}
