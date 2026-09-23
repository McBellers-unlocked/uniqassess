import { ASSESSMENT_MODE_POLICY_VERSION } from "../../src/lib/recruit/assessment-modes";
import { hashScenarioSnapshot } from "../../src/lib/recruit/scenario-content-hash";
import { ASSESSOR_POLICY, CRITERIA, TASK_RUBRICS } from "./rubric";
import { CONTENT_ID, EXHIBITS, ORGANISATION, POSITION_TITLE, SLUG, TASKS, TITLE, TOTAL_MINUTES } from "./scenario";

export const ROLE_EVIDENCE = {
  version: "role-evidence-v1",
  fixtureId: CONTENT_ID,
  sourceKind: "HIRING_MANAGER_PRIORITIES",
  sourceLabel: "Six hiring-manager priorities and the agreed two-task design supplied in this conversation",
  sourceLink: null,
  assessmentMode: "EVIDENCE",
  disclaimer: "Draft assessment-design evidence. Hiring-manager priorities inform the content, but no completed job analysis, independent content review, engineer calibration or psychometric validation is claimed. The uploaded terms-of-reference document was not used to invent additional requirements.",
  reviewed: false,
  launchReadiness: {
    status: "blocked",
    blockers: [
      { code: "AWS_LAB_RUNTIME_NOT_READY", taskNumber: 2, message: "Connect and live-test a dedicated AWS candidate environment, asynchronous pipeline jobs, Terraform artifacts, evidence capture, credential revocation and verified cleanup before publication." },
      { code: "ASSESSMENT_ENGINEER_CALIBRATION_PENDING", message: "Trial both tasks with practising engineers; review timing, difficulty, rubric agreement and platform-caused lost time before hiring use." },
    ],
  },
  assessorPolicy: ASSESSOR_POLICY,
  exclusions: ["Azure practical proficiency", "Kubernetes cluster installation/upgrades/storage administration", "Comprehensive multi-region/distributed-systems design", "Broad APM platform implementation"],
  criteria: CRITERIA.map((criterion, index) => ({
    reviewId: `devops-role-${index + 1}`, sourceRequirement: criterion.sourceRequirement,
    criterion: criterion.name, origin: "MANUAL", entryRequirement: "PARTLY_REQUIRED",
    importance: "CORE", consequence: "MEDIUM", observability: "PARTLY", aiCondition: "EVIDENCE",
    observableBehaviours: [...criterion.behaviours],
    expectedCandidateEvidence: criterion.mappings.map((mapping) => mapping.evidence).join(" "),
    reviewerRationale: "Provisional translation of the hiring manager's priority into observable work. Required-at-entry breadth, task timing and marking anchors still need accountable human review and engineer calibration.",
    decision: "KEEP", confirmed: false,
  })),
};

export const DEFINITION = {
  slug: SLUG, title: TITLE, organisation: ORGANISATION, positionTitle: POSITION_TITLE,
  defaultTotalMinutes: TOTAL_MINUTES, status: "draft", publishedAt: null,
  assessmentMode: "EVIDENCE", modePolicyVersion: ASSESSMENT_MODE_POLICY_VERSION,
  defenceEnabled: false, defenceQuestionCount: 2, defenceMinutes: 5,
  roleEvidenceRecord: ROLE_EVIDENCE,
  exhibits: EXHIBITS.map((exhibit) => ({ ...exhibit })),
  tasks: TASKS.map((task) => ({ ...task, rubric: TASK_RUBRICS[task.number] })),
  criteria: CRITERIA.map((criterion, index) => ({
    code: criterion.code, name: criterion.name, description: criterion.description,
    sourceRequirement: criterion.sourceRequirement, observableBehaviours: [...criterion.behaviours],
    roleEvidence: ROLE_EVIDENCE.criteria[index], order: index + 1,
    taskMappings: criterion.mappings.map((mapping) => ({
      taskNumber: mapping.taskNumber, expectedCandidateEvidence: mapping.evidence,
      rubricElementIds: [...mapping.rubricElementIds], marks: mapping.marks,
    })),
  })),
};
export const DEFINITION_HASH = hashScenarioSnapshot(DEFINITION);

/** A DB-free snapshot for the existing content/blueprint checks. IDs are local fixtures only. */
export function validationSnapshot() {
  return {
    ...DEFINITION,
    exhibits: DEFINITION.exhibits.map((exhibit) => ({ ...exhibit, id: exhibit.sourceId })),
    tasks: DEFINITION.tasks.map((task) => ({ ...task, id: `task-${task.number}`, exhibitId: task.exhibitSourceId, emails: [], chatScripts: [] })),
    criteria: DEFINITION.criteria.map((criterion) => ({
      ...criterion, id: criterion.code,
      taskMappings: criterion.taskMappings.map((mapping) => ({ ...mapping, taskId: `task-${mapping.taskNumber}` })),
    })),
  };
}
