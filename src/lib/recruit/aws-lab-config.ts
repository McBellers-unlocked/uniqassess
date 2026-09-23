/** Draft assessment metadata only. Runtime endpoints and credentials never belong in task config. */
export const AWS_LAB_TEMPLATE = {
  id: "aws-service-release-v1",
  title: "AWS service release lab",
  instructions: "Use the assigned AWS sandbox to prepare infrastructure as code, run the release pipeline and verify the service. Cloud jobs run asynchronously; inspect their recorded status and results before retrying. Record your design, changes, deployment evidence and monitoring decisions in the deliverable. The assessment deadline ends access and starts environment cleanup.",
} as const;

export const AWS_LAB_SETUP_REQUIRED = "AWS practical lab setup is required: a dedicated sandbox account, durable job runner and verified cleanup must be available before this assessment can be published or assigned to candidates.";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function awsLabConfigIssue(config: unknown, kind = "memo_ai"): string | null {
  const raw = record(config)?.awsLab;
  if (raw === undefined || raw === null) return null;
  const lab = record(raw);
  if (!lab || typeof lab.enabled !== "boolean") return "AWS lab configuration requires an enabled boolean.";
  if (Object.keys(lab).some((key) => !["enabled", "templateId"].includes(key))) {
    return "AWS lab configuration only accepts enabled and templateId; runtime URLs and credentials are not allowed.";
  }
  if (lab.templateId !== undefined && lab.templateId !== AWS_LAB_TEMPLATE.id) {
    return "Select a supported, versioned AWS lab template.";
  }
  if (!lab.enabled) return null;
  if (kind !== "memo_ai") return "AWS labs must be attached to a written task.";
  if (lab.templateId !== AWS_LAB_TEMPLATE.id) return "Select a supported, versioned AWS lab template.";
  if (record(record(config)?.kubernetesLab)?.enabled === true) {
    return "Choose either an AWS lab or a Kubernetes lab for each task.";
  }
  return null;
}

/** Describes planned content for authoring; this does not advertise a working candidate console. */
export function taskAwsLab(config: unknown) {
  if (awsLabConfigIssue(config)) return null;
  return record(record(config)?.awsLab)?.enabled === true
    ? { templateId: AWS_LAB_TEMPLATE.id, title: AWS_LAB_TEMPLATE.title, instructions: AWS_LAB_TEMPLATE.instructions }
    : null;
}

/** Server callers must establish actual runtime availability; authoring and environment flags cannot grant it. */
export function awsLabPublicationIssue(config: unknown, kind = "memo_ai", runtimeAvailable = false): string | null {
  const issue = awsLabConfigIssue(config, kind);
  if (issue) return issue;
  return taskAwsLab(config) && !runtimeAvailable ? AWS_LAB_SETUP_REQUIRED : null;
}

export function awsLabPublicationIssues(tasks: ReadonlyArray<{
  number: number; title?: string; kind: string; config?: unknown;
}>, runtimeAvailable = false): string[] {
  return tasks.flatMap((task) => {
    const issue = awsLabPublicationIssue(task.config, task.kind, runtimeAvailable);
    return issue ? [`Task ${task.number}${task.title ? ` (${task.title})` : ""}: ${issue}`] : [];
  });
}
