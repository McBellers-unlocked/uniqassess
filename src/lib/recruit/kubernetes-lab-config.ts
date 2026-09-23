/** Versioned, candidate-safe lab configuration. Never store runtime URLs or credentials in tasks. */
export const KUBERNETES_LAB_TEMPLATE = {
  id: "kubernetes-troubleshooting-v1",
  title: "Kubernetes troubleshooting lab",
  instructions: "Inspect and repair the application in your assigned namespace. Use the command console to run kubectl and edit files in /workspace. Commands run for up to 20 seconds in a fresh shell; files persist. A command that reaches the time limit closes the lab, so use short checks instead of long watches. Record your diagnosis, changes and verification in your deliverable. Commands and output are retained for assessors. The lab closes when you submit or its time expires.",
} as const;

export type LabTaskConfig = { templateId: string; title: string; instructions: string };
export const LAB_COMMAND_MAX_CHARS = 8_000;
export const LAB_OUTPUT_MAX_CHARS = 32_768;
export const LAB_MAX_COMMANDS = 100;
export const LAB_MAX_MINUTES = 120;
export const LAB_ACTIVE_COMMAND_STATUSES = ["queued", "running"];
export const LAB_TERMINAL_STATUSES = ["failed", "stopped", "expired"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function labConfigIssue(config: unknown, kind = "memo_ai"): string | null {
  const raw = record(config)?.kubernetesLab;
  if (raw === undefined || raw === null) return null;
  const lab = record(raw);
  if (!lab || typeof lab.enabled !== "boolean") return "Kubernetes lab configuration requires an enabled boolean.";
  if (!lab.enabled) return null;
  if (kind !== "memo_ai") return "Kubernetes labs must be attached to a written task.";
  if (lab.templateId !== KUBERNETES_LAB_TEMPLATE.id) return "Select a supported, versioned Kubernetes lab template.";
  if (Object.keys(lab).some((key) => !["enabled", "templateId"].includes(key))) {
    return "Kubernetes lab configuration only accepts enabled and templateId.";
  }
  return null;
}

export function taskKubernetesLab(config: unknown): LabTaskConfig | null {
  if (labConfigIssue(config)) return null;
  const raw = record(record(config)?.kubernetesLab);
  return raw?.enabled === true ? {
    templateId: KUBERNETES_LAB_TEMPLATE.id,
    title: KUBERNETES_LAB_TEMPLATE.title,
    instructions: KUBERNETES_LAB_TEMPLATE.instructions,
  } : null;
}

export function labWorkIsActive(candidate: {
  status: string; workLockedAt: Date | string | null; deadline: Date | string | null;
}, now = new Date()): boolean {
  return candidate.status === "started" && !candidate.workLockedAt && !!candidate.deadline
    && new Date(candidate.deadline).getTime() > now.getTime();
}

export function labCommandIssue(command: unknown, requestId: unknown): string | null {
  if (typeof command !== "string" || !command.trim() || command.length > LAB_COMMAND_MAX_CHARS || command.includes("\0")) {
    return `Enter a command between 1 and ${LAB_COMMAND_MAX_CHARS.toLocaleString()} characters without null bytes.`;
  }
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return "A valid command request ID is required.";
  }
  return null;
}
