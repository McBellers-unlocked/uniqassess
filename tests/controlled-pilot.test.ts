import test from "node:test";
import assert from "node:assert/strict";
import { SYNTHETIC_PILOT_RESTRICTION, syntheticPilotCohortRestriction, syntheticPilotRestriction } from "../src/lib/recruit/controlled-pilot";

test("explicit synthetic-only pilots cannot be assigned through ordinary cohort or study creation", () => {
  assert.equal(syntheticPilotRestriction({ controlledPilot: { cohortId: "named-pilot", syntheticOnly: true, formallyApproved: false } }), SYNTHETIC_PILOT_RESTRICTION);
  assert.equal(syntheticPilotRestriction({ reviewed: true, controlledPilot: { syntheticOnly: true } }), SYNTHETIC_PILOT_RESTRICTION,
    "a review flag cannot silently remove an explicit pilot-only restriction");
});

test("candidate import respects a frozen pilot marker after editable content changes", () => {
  assert.equal(syntheticPilotCohortRestriction({ roleEvidenceRecord: { controlledPilot: { syntheticOnly: true } } }, { reviewed: true }), SYNTHETIC_PILOT_RESTRICTION);
  assert.equal(syntheticPilotCohortRestriction(null, { controlledPilot: { syntheticOnly: true } }), SYNTHETIC_PILOT_RESTRICTION);
  assert.equal(syntheticPilotCohortRestriction({ roleEvidenceRecord: { reviewed: true } }, { reviewed: true }), null);
  assert.equal(syntheticPilotCohortRestriction(null, null), null);
});

test("ordinary scenarios and unrelated draft/readiness metadata retain their existing publication workflow", () => {
  for (const value of [undefined, null, {}, [], { reviewed: false }, { launchReadiness: { status: "blocked" } },
    { sourceType: "synthetic_operational_pilot" }, { controlledPilot: null }, { controlledPilot: [] },
    { controlledPilot: { syntheticOnly: false } }, { controlledPilot: { syntheticOnly: "true" } }]) {
    assert.equal(syntheticPilotRestriction(value), null);
  }
});
