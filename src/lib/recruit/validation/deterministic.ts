import { getAssessmentModePolicy } from "../assessment-modes";
import { labConfigIssue } from "../kubernetes-lab-config";
import type { BlueprintRow, DeterministicCheck, ValidationFinding } from "./types";

type ScenarioInput = {
  assessmentMode: unknown;
  defaultTotalMinutes: number;
  defenceEnabled: boolean;
  defenceQuestionCount: number;
  defenceMinutes: number;
  exhibits: Array<{ id: string; sourceId?: string | null; title: string }>;
  tasks: Array<{
    id: string; number: number; kind: string; title: string; briefMarkdown: string;
    totalMarks: number; systemPrompt?: string | null; exhibitId?: string | null; rubric?: unknown;
    emails?: unknown[]; chatScripts?: unknown[]; config?: unknown;
  }>;
  criteria: Array<{
    id: string; code: string; name: string; observableBehaviours: unknown;
    taskMappings: Array<{ taskId: string; expectedCandidateEvidence: string; rubricElementIds: unknown; marks: number }>;
  }>;
};

function categories(rubric: unknown): Record<string, Record<string, unknown>> {
  if (!rubric || typeof rubric !== "object" || Array.isArray(rubric)) return {};
  const raw = rubric as Record<string, unknown>;
  const value = raw.categories && typeof raw.categories === "object" ? raw.categories : raw;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Record<string, unknown>>)
    : {};
}

export function rubricMaximum(rubric: unknown): number {
  return Object.values(categories(rubric)).reduce((sum, category) => {
    return sum + (typeof category?.max === "number" ? category.max : 0);
  }, 0);
}

function rubricElementIds(rubric: unknown): Set<string> {
  const ids = new Set<string>();
  for (const [categoryId, category] of Object.entries(categories(rubric))) {
    ids.add(categoryId);
    const issues = Array.isArray(category?.embedded_issues) ? category.embedded_issues : [];
    for (const issue of issues) {
      if (issue && typeof issue === "object" && typeof (issue as Record<string, unknown>).id === "string") {
        ids.add(String((issue as Record<string, unknown>).id));
      }
    }
  }
  return ids;
}

function embeddedIssueLineageGaps(rubric: unknown): string[] {
  const gaps: string[] = [];
  for (const category of Object.values(categories(rubric))) {
    const issues = Array.isArray(category?.embedded_issues) ? category.embedded_issues : [];
    for (const rawIssue of issues) {
      if (!rawIssue || typeof rawIssue !== "object") continue;
      const issue = rawIssue as Record<string, unknown>;
      const id = typeof issue.id === "string" ? issue.id : "unnamed issue";
      const hasSource = ["sourceId", "source_id", "source", "evidenceReference"].some(
        (key) => typeof issue[key] === "string" && String(issue[key]).trim().length > 0
      );
      const hasInferenceRationale = ["expected", "rationale", "inferenceRationale", "professionalInferenceRationale"].some(
        (key) => typeof issue[key] === "string" && String(issue[key]).trim().length > 0
      );
      if (!hasSource && !hasInferenceRationale) gaps.push(id);
    }
  }
  return gaps;
}

export function buildBlueprintRows(scenario: ScenarioInput): BlueprintRow[] {
  const taskById = new Map(scenario.tasks.map((task) => [task.id, task]));
  const rows: BlueprintRow[] = [];
  for (const criterion of scenario.criteria) {
    const behaviours = Array.isArray(criterion.observableBehaviours)
      ? criterion.observableBehaviours.map(String).filter(Boolean)
      : [];
    if (!criterion.taskMappings.length) {
      rows.push({
        criterionId: criterion.id, criterionCode: criterion.code, criterion: criterion.name,
        observableBehaviour: behaviours.join("; ") || "Not declared", taskId: null, taskNumber: null,
        taskTitle: null, candidateEvidence: null, rubricElementIds: [], marks: 0,
        gap: "Criterion is not mapped to a task.",
      });
      continue;
    }
    for (const mapping of criterion.taskMappings) {
      const task = taskById.get(mapping.taskId);
      const ids = Array.isArray(mapping.rubricElementIds) ? mapping.rubricElementIds.map(String) : [];
      const available = task ? rubricElementIds(task.rubric) : new Set<string>();
      const missing = ids.filter((id) => !available.has(id));
      rows.push({
        criterionId: criterion.id, criterionCode: criterion.code, criterion: criterion.name,
        observableBehaviour: behaviours.join("; ") || "Not declared", taskId: mapping.taskId,
        taskNumber: task?.number ?? null, taskTitle: task?.title ?? null,
        candidateEvidence: mapping.expectedCandidateEvidence, rubricElementIds: ids, marks: mapping.marks,
        gap: !task ? "Mapped task no longer exists." : missing.length ? `Unknown rubric elements: ${missing.join(", ")}` : null,
      });
    }
  }
  return rows;
}

export function runDeterministicChecks(scenario: ScenarioInput): {
  checks: DeterministicCheck[];
  findings: ValidationFinding[];
  blueprint: BlueprintRow[];
} {
  const checks: DeterministicCheck[] = [];
  const finding = (
    id: string, category: ValidationFinding["category"], severity: ValidationFinding["severity"],
    title: string, explanation: string, recommendation: string, evidenceReferences: string[] = []
  ): ValidationFinding => ({ id, category, severity, title, explanation, recommendation, evidenceReferences, disposition: "open" });
  const findings: ValidationFinding[] = [];
  const add = (check: DeterministicCheck, f?: ValidationFinding) => { checks.push(check); if (!check.passed && f) findings.push(f); };

  const policy = getAssessmentModePolicy(scenario.assessmentMode);
  add({ id: "mode-policy", passed: Boolean(policy), severity: "blocker", label: "Declared mode policy", detail: `${policy.label} policy resolved.` });

  const invalidLabs = scenario.tasks.filter((task) => labConfigIssue(task.config, task.kind));
  add(
    { id: "kubernetes-lab-config", passed: invalidLabs.length === 0, severity: "blocker", label: "Practical lab configuration", detail: invalidLabs.length ? invalidLabs.map((t) => `Task ${t.number}: ${labConfigIssue(t.config, t.kind)}`).join("; ") : "All configured labs use a supported versioned template." },
    finding("det-kubernetes-lab-config", "time_feasibility", "blocker", "Invalid practical lab configuration", "The lab could not be delivered consistently.", "Select a supported Kubernetes lab template on a written task.", invalidLabs.map((t) => t.id))
  );

  const scored = scenario.tasks.filter((task) => task.totalMarks > 0);
  const missingRubric = scored.filter((task) => Object.keys(categories(task.rubric)).length === 0);
  add(
    { id: "scored-rubrics", passed: missingRubric.length === 0, severity: "blocker", label: "Every scored task has a rubric", detail: missingRubric.length ? `Missing: ${missingRubric.map((t) => `Task ${t.number}`).join(", ")}` : "All scored tasks have rubrics." },
    finding("det-scored-rubrics", "rubric_quality", "blocker", "A scored task has no rubric", "Human marking cannot be applied consistently without a rubric.", "Add and review a rubric for every scored task.", missingRubric.map((t) => t.id))
  );

  const mismatched = scored.filter((task) => rubricMaximum(task.rubric) !== task.totalMarks);
  add(
    { id: "rubric-marks", passed: mismatched.length === 0, severity: "blocker", label: "Rubric marks reconcile", detail: mismatched.length ? mismatched.map((t) => `Task ${t.number}: ${rubricMaximum(t.rubric)}/${t.totalMarks}`).join("; ") : "Task and rubric totals reconcile." },
    finding("det-rubric-marks", "rubric_quality", "blocker", "Rubric marks do not reconcile", "One or more category maxima differ from the task total.", "Reconcile all category maxima with the configured task marks.", mismatched.map((t) => t.id))
  );

  const missingExhibit = scenario.tasks.filter((task) => task.kind === "memo_ai" && (!task.exhibitId || !scenario.exhibits.some((e) => e.id === task.exhibitId)));
  add(
    { id: "required-exhibits", passed: missingExhibit.length === 0, severity: "blocker", label: "Required exhibits exist", detail: missingExhibit.length ? `Missing for ${missingExhibit.map((t) => `Task ${t.number}`).join(", ")}` : "Every memo task has an exhibit." },
    finding("det-required-exhibits", "evidence_lineage", "blocker", "A memo task has no source exhibit", "The task cannot support source-grounded analysis.", "Attach the required exhibit and assign a stable source ID.", missingExhibit.map((t) => t.id))
  );

  const unmapped = scenario.criteria.filter((criterion) => criterion.taskMappings.length === 0);
  add(
    { id: "criterion-mapping", passed: scenario.criteria.length > 0 && unmapped.length === 0, severity: "blocker", label: "Criteria map to observable tasks", detail: scenario.criteria.length === 0 ? "No persisted criteria." : unmapped.length ? `Unmapped: ${unmapped.map((c) => c.code).join(", ")}` : "All criteria have a task mapping." },
    finding("det-criterion-mapping", "criterion_coverage", "blocker", scenario.criteria.length ? "A criterion has no assessment mapping" : "No assessment criteria have been declared", "The blueprint cannot show how every intended construct is observed.", "Persist stable criteria and map each one to task evidence and rubric elements.", unmapped.map((c) => c.id))
  );

  const blueprint = buildBlueprintRows(scenario);
  const blueprintGaps = blueprint.filter((row) => row.gap);
  add(
    { id: "blueprint-links", passed: blueprintGaps.length === 0, severity: "blocker", label: "Blueprint links are valid", detail: blueprintGaps.length ? `${blueprintGaps.length} mapping gap(s).` : "Criterion, task and rubric links resolve." },
    finding("det-blueprint-links", "criterion_coverage", "blocker", "Blueprint contains broken links", "One or more mappings reference a missing task or rubric element.", "Repair the highlighted blueprint mappings.", blueprintGaps.map((r) => r.criterionId))
  );

  const unmappedRubricElements = scored.flatMap((task) => {
    const mappedIds = new Set(
      scenario.criteria.flatMap((criterion) =>
        criterion.taskMappings
          .filter((mapping) => mapping.taskId === task.id && Array.isArray(mapping.rubricElementIds))
          .flatMap((mapping) => (mapping.rubricElementIds as unknown[]).map(String))
      )
    );
    return Object.keys(categories(task.rubric))
      .filter((elementId) => !mappedIds.has(elementId))
      .map((elementId) => `Task ${task.number}: ${elementId}`);
  });
  add(
    {
      id: "rubric-criterion-links",
      passed: unmappedRubricElements.length === 0,
      severity: "blocker",
      label: "Scored rubric elements map to criteria",
      detail: unmappedRubricElements.length ? unmappedRubricElements.join("; ") : "Every scored rubric category has an intended criterion.",
    },
    finding(
      "det-rubric-criterion-links",
      "criterion_coverage",
      "blocker",
      "A scored rubric element has no intended criterion",
      "The rubric would reward a behaviour that the assessment blueprint has not declared.",
      "Map every scored rubric category to a stable criterion.",
      unmappedRubricElements
    )
  );

  const issueLineageGaps = scored.flatMap((task) =>
    embeddedIssueLineageGaps(task.rubric).map((issueId) => `Task ${task.number}: ${issueId}`)
  );
  add(
    {
      id: "embedded-issue-lineage",
      passed: issueLineageGaps.length === 0,
      severity: "blocker",
      label: "Embedded issues have evidence or an inference rationale",
      detail: issueLineageGaps.length ? issueLineageGaps.join("; ") : "Every embedded issue has an authored evidence or inference explanation.",
    },
    finding(
      "det-embedded-issue-lineage",
      "evidence_lineage",
      "blocker",
      "An embedded issue has no evidence lineage",
      "A planted conclusion cannot be traced to a source or an explicit professional-inference rationale.",
      "Add a stable source reference or an authored inference rationale to each embedded issue.",
      issueLineageGaps
    )
  );

  const mappingMarkGaps = scored.flatMap((task) => {
    const mapped = scenario.criteria.reduce(
      (sum, criterion) => sum + criterion.taskMappings.filter((mapping) => mapping.taskId === task.id).reduce((mappingSum, mapping) => mappingSum + mapping.marks, 0),
      0
    );
    return mapped === task.totalMarks ? [] : [`Task ${task.number}: ${mapped}/${task.totalMarks}`];
  });
  add(
    { id: "blueprint-marks", passed: mappingMarkGaps.length === 0, severity: "blocker", label: "Blueprint marks reconcile", detail: mappingMarkGaps.length ? mappingMarkGaps.join("; ") : "Criterion mapping marks reconcile with scored task totals." },
    finding("det-blueprint-marks", "criterion_coverage", "blocker", "Blueprint marks do not reconcile", "Criterion-to-task mapping marks do not add up to the corresponding task total.", "Distribute each scored task's marks across its criterion mappings.")
  );

  const defenceValid = !scenario.defenceEnabled || (scenario.defenceQuestionCount === 2 && scenario.defenceMinutes >= 1 && scenario.defenceMinutes <= 30);
  add(
    { id: "defence-config", passed: defenceValid, severity: "blocker", label: "Defence configuration", detail: defenceValid ? (scenario.defenceEnabled ? `Two questions; ${scenario.defenceMinutes} minutes.` : "Defence disabled.") : "This release supports exactly two questions and 1-30 minutes." },
    finding("det-defence-config", "mode_alignment", "blocker", "Defence settings are inconsistent", "The configured defence cannot run safely in this release.", "Set exactly two questions and a duration between 1 and 30 minutes.")
  );

  if (policy.toolDeclarationRequired && !scenario.defenceEnabled) {
    findings.push(finding("open-agent-defence", "mode_alignment", "warning", "Open Agent defence is disabled", "Open Agent Mode normally uses a short defence after the tool declaration.", "Enable the configured defence or document the limitation."));
  }

  const estimatedReadingMinutes = Math.max(1, Math.round(scenario.exhibits.length * 4 + scenario.tasks.length * 2));
  if (estimatedReadingMinutes > scenario.defaultTotalMinutes * 0.55) {
    findings.push(finding("time-reading-load", "time_feasibility", "warning", "Reading load may crowd out analysis", `A simple range estimate places reading and orientation at approximately ${Math.max(1, estimatedReadingMinutes - 3)}-${estimatedReadingMinutes + 4} minutes before drafting and interruptions.`, "Pilot with representative users and adjust duration or exhibit burden."));
  }

  return { checks, findings, blueprint };
}
