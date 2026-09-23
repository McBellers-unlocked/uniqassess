/**
 * Shared types for recruitment scenarios.
 *
 * A scenario can come from two sources:
 *   1. Code (src/lib/recruit/fam-p4-2026.ts — legacy Finance & Accounting
 *      Manager scenario that shipped to production before the builder existed).
 *   2. Database (RecruitmentScenario + RecruitmentScenarioTask + ... tables
 *      — authored via the admin UI at /admin/recruitment/scenarios).
 *
 * Both paths are normalised through src/lib/recruit/scenario-loader.ts into
 * the same RecruitScenarioConfig shape so the candidate-facing code doesn't
 * need to know where the scenario came from.
 */

export type TaskKind = "memo_ai" | "email_inbox" | "chat";

/**
 * A single scripted email revealed during an email_inbox task. The absolute
 * reveal time is candidate.startedAt + triggerOffsetSeconds.
 */
export interface RecruitEmailConfig {
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

/**
 * A persona-chat script that fires once at triggerOffsetSeconds. MVP always
 * runs the chat through Claude with the admin-authored systemPrompt; a
 * scripted (deterministic) mode is a follow-up.
 */
export interface RecruitChatScriptConfig {
  id: string;
  triggerOffsetSeconds: number;
  personaName: string;
  personaRole: string;
  openerMessage: string;
  systemPrompt: string;
  maxTurns: number;
  expectedOutcomes: string | null;
}

/**
 * Discriminated union by `kind`. Legacy FAM tasks are `memo_ai`; new task
 * types carry their scripted content in kind-specific fields.
 */
export interface RecruitTaskConfigBase {
  /** DB task id when database-authored; null for legacy code scenarios. */
  taskId?: string | null;
  number: number;
  kind: TaskKind;
  title: string;
  briefMarkdown: string;
  totalMarks: number;
}

export interface RecruitMemoAiTaskConfig extends RecruitTaskConfigBase {
  kind: "memo_ai";
  systemPrompt: string;
  /** Run model-authored Python in Anthropic's isolated managed sandbox. */
  codeExecutionEnabled?: boolean;
  kubernetesLab?: import("./kubernetes-lab-config").LabTaskConfig | null;
  awsLab?: import("./kubernetes-lab-config").LabTaskConfig | null;
  exhibitHtml: string;
  exhibitTitle: string;
  exhibitSourceId?: string;
  deliverableLabel: string;
  deliverablePlaceholder: string;
}

export interface RecruitEmailInboxTaskConfig extends RecruitTaskConfigBase {
  kind: "email_inbox";
  emails: RecruitEmailConfig[];
}

export interface RecruitChatTaskConfig extends RecruitTaskConfigBase {
  kind: "chat";
  script: RecruitChatScriptConfig;
}

export type RecruitTaskConfig =
  | RecruitMemoAiTaskConfig
  | RecruitEmailInboxTaskConfig
  | RecruitChatTaskConfig;

export interface RecruitScenarioConfig {
  scenarioId: string;            // stable id; "fam-p4-2026" for legacy, cuid for DB scenarios
  slug: string;                  // URL segment
  title: string;
  organisation: string;
  positionTitle: string;
  defaultTotalMinutes: number;
  assessmentMode?: import("./assessment-modes").AssessmentMode;
  modePolicyVersion?: string;
  defenceEnabled?: boolean;
  defenceQuestionCount?: number;
  defenceMinutes?: number;
  /**
   * Branding for the in-assessment AI panel. The candidate UI falls back to
   * the IDSC defaults when these are absent, so existing scenarios are
   * unaffected; a scenario set in a different organisation (e.g. IPAC) sets
   * its own. assistantName is the full system name shown in the panel header
   * ("IPAC Knowledge System"); assistantShortName is the terse tag used in the
   * rail / "thinking…" indicator ("IPAC").
   */
  assistantName?: string;
  assistantShortName?: string;
  /**
   * Variable length (MVP: 1-N tasks). Legacy FAM uses exactly 2. The
   * candidate UI tolerates any count and renders tabs dynamically.
   */
  tasks: RecruitTaskConfig[];
  /** "code" = src/lib/recruit/*.ts; "db" = RecruitmentScenario table. */
  source: "code" | "db";
}

/** Type guards — candidate UI and APIs dispatch on kind. */
export function isMemoAiTask(task: RecruitTaskConfig): task is RecruitMemoAiTaskConfig {
  return task.kind === "memo_ai";
}
export function isEmailInboxTask(task: RecruitTaskConfig): task is RecruitEmailInboxTaskConfig {
  return task.kind === "email_inbox";
}
export function isChatTask(task: RecruitTaskConfig): task is RecruitChatTaskConfig {
  return task.kind === "chat";
}
