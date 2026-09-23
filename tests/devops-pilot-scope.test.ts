import test from "node:test";
import assert from "node:assert/strict";
import { assertPilotCohortScope, PILOTS, PILOT_SCENARIO, PILOT_SLUG } from "../scripts/devops-assessment/pilot-scope";
import { indexToAnonymousId } from "../src/lib/recruit/tokens";

function cohort(pilot: typeof PILOTS.alpha | typeof PILOTS.expiry) {
  return { id: pilot.id, title: pilot.title, customScenarioId: PILOT_SCENARIO, scenarioSlug: PILOT_SLUG,
    totalMinutes: pilot.minutes, assessmentMode: "EVIDENCE", defenceEnabled: false, assessmentVersionId: "frozen-version",
    candidates: [{ name: pilot.name, email: pilot.email, anonymousId: indexToAnonymousId(0) }] };
}
test("Alpha and separate six-minute expiry pilot share one frozen version", () => {
  assert.doesNotThrow(() => assertPilotCohortScope([], "frozen-version", false));
  assert.doesNotThrow(() => assertPilotCohortScope([cohort(PILOTS.alpha)], "frozen-version", true));
  assert.doesNotThrow(() => assertPilotCohortScope([cohort(PILOTS.alpha), cohort(PILOTS.expiry)], "frozen-version", true));
  assert.throws(() => assertPilotCohortScope([cohort(PILOTS.expiry)], "frozen-version", true), /Alpha/);
});
test("reruns refuse extra candidates, missing candidates, changed identity, timer or frozen version", () => {
  for (const patch of [
    { candidates: [] },
    { candidates: [...cohort(PILOTS.alpha).candidates, { name: "Other", email: "other@example.test", anonymousId: indexToAnonymousId(1) }] },
    { candidates: [{ name: PILOTS.alpha.name, email: "human@example.test", anonymousId: indexToAnonymousId(0) }] },
    { candidates: [{ name: PILOTS.alpha.name, email: PILOTS.alpha.email, anonymousId: "A" }] },
    { candidates: [{ name: PILOTS.alpha.name, email: PILOTS.alpha.email, anonymousId: indexToAnonymousId(1) }] },
    { totalMinutes: 6 }, { assessmentVersionId: "new-version" }, { defenceEnabled: true }, { id: "unrelated" },
  ]) assert.throws(() => assertPilotCohortScope([{ ...cohort(PILOTS.alpha), ...patch }], "frozen-version", false));
  assert.throws(() => assertPilotCohortScope([cohort(PILOTS.alpha), cohort(PILOTS.alpha)], "frozen-version", true));
});
