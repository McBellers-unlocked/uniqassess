import assert from "node:assert/strict";
import test from "node:test";
import { DEFINITION, validationSnapshot } from "../scripts/devops-assessment/definition";
import { TASK_RUBRICS } from "../scripts/devops-assessment/rubric";
import { runDeterministicChecks } from "../src/lib/recruit/validation/deterministic";

test("DevOps draft has valid rubric lineage and the agreed six-priority allocation", () => {
  const result = runDeterministicChecks(validationSnapshot());
  assert.deepEqual(result.checks.filter((check) => !check.passed && check.id !== "aws-lab-readiness"), []);
  assert.deepEqual(DEFINITION.tasks.map((task) => task.totalMarks), [40, 60]);
  assert.deepEqual(Object.fromEntries(DEFINITION.criteria.map((criterion) => [criterion.code, criterion.taskMappings.reduce((total, mapping) => total + mapping.marks, 0)])), {
    KUBERNETES: 30, AWS: 20, CICD: 15, IAC: 15, ARCHITECTURE: 10, APM: 10,
  });
  assert.equal(DEFINITION.defaultTotalMinutes, 100);
  assert.equal(result.blueprint.length, 8);
});

test("AWS prerequisite and unresolved launch state cannot be mistaken for a published scenario", () => {
  assert.equal(DEFINITION.status, "draft");
  assert.equal(DEFINITION.publishedAt, null);
  assert.equal(DEFINITION.roleEvidenceRecord.launchReadiness.status, "blocked");
  assert.ok(DEFINITION.roleEvidenceRecord.launchReadiness.blockers.some((blocker) => blocker.code === "AWS_LAB_RUNTIME_NOT_READY"));
  assert.ok(DEFINITION.roleEvidenceRecord.criteria.every((criterion) => criterion.confirmed === false));
  assert.deepEqual(DEFINITION.tasks[1].config, { awsLab: { enabled: true, templateId: "aws-service-release-v1" } });
  assert.match(DEFINITION.tasks[1].briefMarkdown, /not yet connected/);
});

test("candidate packs label synthetic evidence and keep seeded answers out of the exhibits and AI context", () => {
  const candidateContent = DEFINITION.exhibits.map((exhibit) => exhibit.html).join("\n")
    + DEFINITION.tasks.map((task) => task.briefMarkdown + task.systemPrompt + task.deliverablePlaceholder).join("\n");
  assert.match(candidateContent, /synthetic/);
  assert.match(candidateContent, /not observations from your live lab/);
  assert.doesNotMatch(candidateContent, /checkout-previous|readiness on 8081|resource scope does not cover/);
  assert.match(JSON.stringify(TASK_RUBRICS), /checkout-previous/);
  assert.match(candidateContent, /not a running cloud environment/);
  assert.match(candidateContent, /no live monitoring installation is required/);
});
