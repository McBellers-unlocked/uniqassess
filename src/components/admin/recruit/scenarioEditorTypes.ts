/**
 * Client-side shapes for the admin scenario editor. These mirror the payload
 * returned by GET /api/admin/recruitment/scenarios/[id], not the full Prisma
 * types — the editor only needs a subset.
 */

export type EditorStatus = "draft" | "published" | "archived";
export type EditorTaskKind = "memo_ai" | "email_inbox" | "chat";

export interface EditorExhibit {
  id: string;
  sourceId: string | null;
  title: string;
  html: string;
}

export interface EditorEmail {
  id: string;
  orderIndex: number;
  triggerOffsetSeconds: number;
  senderName: string;
  senderEmail: string;
  subject: string;
  bodyHtml: string;
  expectedAction: "reply" | "ignore" | "flag" | "forward";
  markerNotes: string | null;
}

export interface EditorChatScript {
  id: string;
  triggerOffsetSeconds: number;
  personaName: string;
  personaRole: string;
  openerMessage: string;
  systemPrompt: string;
  maxTurns: number;
  expectedOutcomes: string | null;
}

export interface EditorTask {
  id: string;
  number: number;
  kind: EditorTaskKind;
  title: string;
  briefMarkdown: string;
  totalMarks: number;
  systemPrompt: string | null;
  exhibitId: string | null;
  exhibit: EditorExhibit | null;
  deliverableLabel: string | null;
  deliverablePlaceholder: string | null;
  config?: { codeExecutionEnabled?: boolean; kubernetesLab?: { enabled: boolean; templateId: string } | null; [key: string]: unknown } | null;
  emails: EditorEmail[];
  chatScripts: EditorChatScript[];
}

export interface EditorScenario {
  id: string;
  slug: string;
  title: string;
  organisation: string;
  positionTitle: string;
  defaultTotalMinutes: number;
  assessmentMode: "EVIDENCE" | "COPILOT" | "OPEN_AGENT";
  modePolicyVersion: string;
  defenceEnabled: boolean;
  defenceQuestionCount: number;
  defenceMinutes: number;
  roleEvidenceRecord: Record<string, unknown> | null;
  roleEvidenceReviewedById: string | null;
  roleEvidenceReviewedAt: string | null;
  status: EditorStatus;
  publishedAt: string | null;
  tasks: EditorTask[];
  exhibits: EditorExhibit[];
  _count: { assessments: number };
  criteria?: Array<{
    id: string; code: string; name: string; description: string; sourceRequirement: string | null;
    observableBehaviours: string[]; roleEvidence: Record<string, unknown> | null; order: number;
    taskMappings: Array<{ id: string; taskId: string; expectedCandidateEvidence: string; rubricElementIds: string[]; marks: number; task: { id: string; number: number; title: string } }>;
  }>;
  validationRuns?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
}
