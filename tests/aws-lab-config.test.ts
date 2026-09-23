import test from "node:test";
import assert from "node:assert/strict";
import {
  AWS_LAB_TEMPLATE, AWS_LAB_SETUP_REQUIRED, awsLabConfigIssue,
  awsLabPublicationIssue, awsLabPublicationIssues, taskAwsLab,
} from "../src/lib/recruit/aws-lab-config";
import { KUBERNETES_LAB_TEMPLATE, taskKubernetesLab } from "../src/lib/recruit/kubernetes-lab-config";
import { hashScenarioSnapshot } from "../src/lib/recruit/scenario-content-hash";

const aws = { awsLab: { enabled: true, templateId: AWS_LAB_TEMPLATE.id } };
const kubernetes = { kubernetesLab: { enabled: true, templateId: KUBERNETES_LAB_TEMPLATE.id } };

test("AWS draft authoring is explicit and versioned without activating Kubernetes", () => {
  assert.equal(awsLabConfigIssue(aws), null);
  assert.deepEqual(taskAwsLab(aws), {
    templateId: AWS_LAB_TEMPLATE.id, title: AWS_LAB_TEMPLATE.title, instructions: AWS_LAB_TEMPLATE.instructions,
  });
  assert.equal(taskKubernetesLab(aws), null);
  assert.equal(taskAwsLab(kubernetes), null);
  assert.notEqual(hashScenarioSnapshot({ config: aws }), hashScenarioSnapshot({ config: {} }));
});

test("absent and explicitly disabled AWS drafts do not block unrelated assessments", () => {
  for (const config of [undefined, null, {}, kubernetes, { awsLab: null }, { awsLab: { enabled: false } }]) {
    assert.equal(awsLabConfigIssue(config), null);
    assert.equal(taskAwsLab(config), null);
    assert.equal(awsLabPublicationIssue(config), null);
  }
});

test("AWS task configuration cannot store endpoints, credentials or unsupported templates even when disabled", () => {
  for (const enabled of [false, true]) {
    for (const field of ["url", "key", "roleArn", "accountId", "runtimeAvailable"]) {
      assert.ok(awsLabConfigIssue({ awsLab: { enabled, templateId: AWS_LAB_TEMPLATE.id, [field]: "untrusted" } }));
    }
    assert.ok(awsLabConfigIssue({ awsLab: { enabled, templateId: "unreviewed" } }));
  }
  for (const value of [true, "enabled", [], { enabled: "true" }, { enabled: true }]) {
    assert.ok(awsLabConfigIssue({ awsLab: value }));
    assert.equal(taskAwsLab({ awsLab: value }), null);
  }
});

test("AWS configuration rejects incompatible task kinds and simultaneous Kubernetes execution", () => {
  for (const kind of ["chat", "email_inbox", "unknown"]) {
    assert.ok(awsLabConfigIssue(aws, kind));
    assert.ok(awsLabPublicationIssue(aws, kind, true));
  }
  assert.ok(awsLabConfigIssue({ ...aws, ...kubernetes }));
  assert.equal(taskAwsLab({ ...aws, ...kubernetes }), null);
  assert.ok(awsLabPublicationIssue({ ...aws, ...kubernetes }, "memo_ai", true));
  assert.equal(awsLabConfigIssue({ ...aws, kubernetesLab: { enabled: false } }), null);
});

test("valid AWS drafts remain unpublishable by default and release only after a server runtime check", () => {
  assert.equal(awsLabPublicationIssue(aws), AWS_LAB_SETUP_REQUIRED);
  assert.equal(awsLabPublicationIssue(aws, "memo_ai", false), AWS_LAB_SETUP_REQUIRED);
  assert.equal(awsLabPublicationIssue(aws, "memo_ai", true), null);
  assert.ok(awsLabPublicationIssue({ awsLab: { enabled: true, templateId: "unsupported" } }, "memo_ai", true));
});

test("publication and cohort gate reports task-specific blockers without removing valid draft content", () => {
  const tasks = [
    { number: 1, title: "Kubernetes repair", kind: "memo_ai", config: kubernetes },
    { number: 2, title: "AWS service release", kind: "memo_ai", config: aws },
  ];
  assert.deepEqual(awsLabPublicationIssues(tasks), [`Task 2 (AWS service release): ${AWS_LAB_SETUP_REQUIRED}`]);
  assert.deepEqual(awsLabPublicationIssues(tasks, true), []);
  assert.equal(taskAwsLab(tasks[1].config)?.templateId, AWS_LAB_TEMPLATE.id);
});
