"use client";

import { useEffect, useState } from "react";
import type { EditorScenario, EditorTask } from "./scenarioEditorTypes";
import { KUBERNETES_LAB_TEMPLATE } from "@/lib/recruit/kubernetes-lab-config";

/**
 * Right-panel editor for memo_ai tasks. Fields: title, brief, totalMarks,
 * exhibit picker (dropdown sourced from the scenario's exhibit library),
 * AI system prompt, deliverable label + placeholder.
 *
 * Saves via PATCH /api/admin/recruitment/scenarios/[id]/tasks/[taskId].
 */
export default function MemoTaskEditor({
  scenario,
  task,
  onSaved,
  onDeleted,
}: {
  scenario: EditorScenario;
  task: EditorTask;
  onSaved: (task: EditorTask) => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [briefMarkdown, setBriefMarkdown] = useState(task.briefMarkdown);
  const [totalMarks, setTotalMarks] = useState(String(task.totalMarks));
  const [systemPrompt, setSystemPrompt] = useState(task.systemPrompt ?? "");
  const [exhibitId, setExhibitId] = useState(task.exhibitId ?? "");
  const [deliverableLabel, setDeliverableLabel] = useState(task.deliverableLabel ?? "");
  const [deliverablePlaceholder, setDeliverablePlaceholder] = useState(task.deliverablePlaceholder ?? "");
  const [codeExecutionEnabled, setCodeExecutionEnabled] = useState(task.config?.codeExecutionEnabled === true);
  const [kubernetesLabEnabled, setKubernetesLabEnabled] = useState(task.config?.kubernetesLab?.enabled === true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when switching between tasks.
  useEffect(() => {
    setTitle(task.title);
    setBriefMarkdown(task.briefMarkdown);
    setTotalMarks(String(task.totalMarks));
    setSystemPrompt(task.systemPrompt ?? "");
    setExhibitId(task.exhibitId ?? "");
    setDeliverableLabel(task.deliverableLabel ?? "");
    setDeliverablePlaceholder(task.deliverablePlaceholder ?? "");
    setCodeExecutionEnabled(task.config?.codeExecutionEnabled === true);
    setKubernetesLabEnabled(task.config?.kubernetesLab?.enabled === true);
    setSavedAt(null);
    setError(null);
    // Intentionally reinitialise only when selecting a different task; parent
    // refreshes of the same task must not overwrite unsaved editor text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/recruitment/scenarios/${scenario.id}/tasks/${task.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            briefMarkdown,
            totalMarks: Number(totalMarks) || 0,
            systemPrompt,
            exhibitId: exhibitId || null,
            deliverableLabel: deliverableLabel.trim(),
            deliverablePlaceholder,
            config: { ...(task.config ?? {}), codeExecutionEnabled, kubernetesLab: kubernetesLabEnabled ? { enabled: true, templateId: KUBERNETES_LAB_TEMPLATE.id } : null },
          }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved({ ...task, ...body.task });
      setSavedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete task "${task.title}"? This cannot be undone.`)) return;
    const res = await fetch(
      `/api/admin/recruitment/scenarios/${scenario.id}/tasks/${task.id}`,
      { method: "DELETE" }
    );
    const body = await res.json();
    if (!res.ok) { setError(body.error || `HTTP ${res.status}`); return; }
    onDeleted();
  };

  // Approximate token count for the system prompt — gives the admin a rough
  // sense of how big their prompt is. Not exact (Claude uses BPE), but a
  // good-enough heuristic (chars/4).
  const approxTokens = Math.round(systemPrompt.length / 4);
  const longPromptWarning = approxTokens > 8000;

  return (
    <div className="rounded-xl border border-uq bg-uq-elev1 shadow-uq-glass p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">
          Task {task.number} · <span className="text-uq-cyan">memo_ai</span>
        </div>
        <button onClick={remove} className="text-xs font-medium text-[color:var(--uq-danger-text)] hover:underline focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)] focus-visible:rounded">Delete task</button>
      </div>

      <label className="block text-sm">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 block w-full rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1"
        />
      </label>

      <label className="block text-sm">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Brief (Markdown)</span>
        <textarea
          value={briefMarkdown}
          onChange={(e) => setBriefMarkdown(e.target.value)}
          placeholder={"**From:** Chief of MS Division\n**To:** You\n**Subject:** ...\n\nI need your review of..."}
          className="mt-1 block w-full rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm font-mono h-40 text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1"
        />
        <span className="text-xs text-uq-3 mt-1 block">
          Shown to the candidate at the top of the task panel. Supports Markdown.
        </span>
      </label>

      <label className="flex items-start gap-3 rounded-lg border border-uq bg-uq-glass-subtle p-3 text-sm">
        <input
          type="checkbox"
          checked={codeExecutionEnabled}
          onChange={(e) => setCodeExecutionEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-uq accent-[color:var(--uq-accent)]"
        />
        <span>
          <span className="block font-medium text-uq">Managed code execution</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-uq-3">Allow the AI to run Python in Anthropic&apos;s isolated sandbox. Enable only for tasks using fictional or approved data; execution traces are retained with candidate interactions.</span>
        </span>
      </label>

      <label className="flex items-start gap-3 rounded-lg border border-uq bg-uq-glass-subtle p-3 text-sm">
        <input
          type="checkbox"
          checked={kubernetesLabEnabled}
          onChange={(e) => setKubernetesLabEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-uq accent-[color:var(--uq-accent)]"
        />
        <span>
          <span className="block font-medium text-uq">Kubernetes practical lab</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-uq-3">{KUBERNETES_LAB_TEMPLATE.title}. Candidates run their own commands in a temporary Kubernetes environment; commands and results are recorded for marking. A separately configured lab runner is required before candidates can use it.</span>
        </span>
      </label>

      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Total marks</span>
          <input
            type="number"
            min={0}
            max={1000}
            value={totalMarks}
            onChange={(e) => setTotalMarks(e.target.value)}
            className="mt-1 block w-full rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1"
          />
        </label>
        <label className="block text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Exhibit</span>
          <select
            value={exhibitId}
            onChange={(e) => setExhibitId(e.target.value)}
            className="mt-1 block w-full rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm text-uq transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1 [&>option]:bg-uq-elev2 [&>option]:text-uq"
          >
            <option value="">— Select exhibit —</option>
            {scenario.exhibits.map((ex) => (
              <option key={ex.id} value={ex.id}>{ex.title}</option>
            ))}
          </select>
          <span className="text-xs text-uq-3 mt-1 block">
            Add exhibits on the <span className="font-medium text-uq-2">Exhibits</span> tab first.
          </span>
        </label>
      </div>

      <label className="block text-sm">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">AI system prompt</span>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are the [Organisation] Analysis System... Think of yourself as a smart analyst sitting next to the candidate..."
          className="mt-1 block w-full rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm font-mono h-72 text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1"
        />
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs text-uq-3">
            Defines how the AI investigation assistant behaves during this task. Cached server-side for cost/latency.
          </span>
          <span className={`text-xs font-mono ${longPromptWarning ? "text-[color:var(--uq-warn-text)]" : "text-uq-3"}`}>
            ≈{approxTokens.toLocaleString()} tokens
          </span>
        </div>
      </label>

      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Deliverable label</span>
          <input
            value={deliverableLabel}
            onChange={(e) => setDeliverableLabel(e.target.value)}
            placeholder="Memo to the Chief of MS Division"
            className="mt-1 block w-full rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1"
          />
        </label>
        <label className="block text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-uq-3">Deliverable placeholder</span>
          <textarea
            value={deliverablePlaceholder}
            onChange={(e) => setDeliverablePlaceholder(e.target.value)}
            placeholder="Draft your memo to the Chief... Identify issues and recommend actions."
            className="mt-1 block w-full rounded-md border border-uq bg-uq-glass-subtle px-3 py-2 text-sm h-24 text-uq placeholder:text-uq-3 transition-shadow duration-150 focus:outline-none focus:border-uq-accent focus:shadow-[var(--uq-glow-soft)] focus:bg-uq-elev1"
          />
        </label>
      </div>

      {error && <div className="rounded-md px-3 py-2 text-sm border border-[color:var(--uq-danger-line)] bg-[color:var(--uq-danger-soft)] text-[color:var(--uq-danger-text)]">{error}</div>}

      <div className="flex items-center justify-end gap-3 pt-2">
        {savedAt && <span className="text-xs text-uq-3">Saved {savedAt.toLocaleTimeString()}</span>}
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-uq-accent text-[color:var(--uq-text-on-accent)] text-sm font-medium shadow-uq-glow-soft transition-all duration-150 hover:bg-uq-accent-hover hover:shadow-uq-glow active:translate-y-px disabled:bg-uq-elev2 disabled:text-uq-3 disabled:shadow-none disabled:cursor-not-allowed focus-visible:outline-none focus-visible:[box-shadow:var(--uq-focus-ring)]"
        >
          {saving ? "Saving…" : "Save task"}
        </button>
      </div>
    </div>
  );
}
