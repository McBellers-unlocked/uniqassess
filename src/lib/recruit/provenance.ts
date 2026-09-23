export const WORK_PROVENANCE_POLICY_NOTE =
  "Work-provenance information is contextual evidence. It must not be treated as proof of misconduct or used as an undisclosed scoring criterion.";

export type ProvenanceSummary = {
  pasteCount: number;
  pastedCharacters: number;
  focusChanges: number;
  focusChangedMs: number;
  knowledgeQuestions: number;
  evidenceSaved: number;
  evidenceChecked: number;
  evidenceRejected: number;
};

type ActivityLike = { eventType: string; metadata: unknown };

function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function summariseWorkProvenance(
  events: ActivityLike[],
  knowledgeQuestions = 0,
  evidence: Array<{ candidateDisposition: string }> = []
): ProvenanceSummary {
  let pasteCount = 0;
  let pastedCharacters = 0;
  let focusChanges = 0;
  let focusChangedMs = 0;
  for (const event of events) {
    const meta = metadata(event.metadata);
    if (event.eventType === "paste") {
      pasteCount += 1;
      if (typeof meta.charCount === "number") pastedCharacters += Math.max(0, meta.charCount);
    }
    if (event.eventType === "visibility_hidden") focusChanges += 1;
    if (event.eventType === "visibility_visible" && typeof meta.hiddenMs === "number") {
      focusChangedMs += Math.max(0, meta.hiddenMs);
    }
  }
  return {
    pasteCount,
    pastedCharacters,
    focusChanges,
    focusChangedMs,
    knowledgeQuestions,
    evidenceSaved: evidence.length,
    evidenceChecked: evidence.filter((item) => item.candidateDisposition === "CHECKED").length,
    evidenceRejected: evidence.filter((item) => ["REJECTED", "DISMISSED"].includes(item.candidateDisposition)).length,
  };
}

export function provenanceEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    assessment_started: "Assessment started",
    lab_started: "Kubernetes lab requested",
    task_opened: "Task opened",
    exhibit_opened: "Source exhibit opened",
    paste: "Paste activity",
    visibility_hidden: "Focus changed away from the workspace",
    visibility_visible: "Focus returned to the workspace",
    email_delivered: "Scripted email delivered",
    chat_opened: "Persona conversation opened",
    evidence_saved: "Evidence card saved",
    evidence_checked: "Evidence source marked checked",
    evidence_rejected: "Evidence card rejected",
    evidence_dismissed: "Evidence card dismissed",
    evidence_removed: "Evidence card removed from board",
    source_opened: "Evidence source opened",
    memo_sent: "Task sent",
    defence_started: "Reasoning defence started",
    defence_submitted: "Reasoning defence submitted",
    tool_declaration: "Tool-use declaration submitted",
    final_submission: "Assessment submitted",
  };
  return labels[eventType] ?? eventType.replace(/_/g, " ");
}
