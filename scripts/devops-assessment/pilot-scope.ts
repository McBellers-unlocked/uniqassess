export const PILOT_SCENARIO = "cmue2g57x0000jqawq22g7zpt";
export const PILOT_SLUG = "devops-kubernetes-aws-practical-v1";
export const PILOTS = {
  alpha: { id: "devops-two-lab-live-pilot-v1", title: "PILOT ONLY — DevOps Kubernetes and AWS browser verification", minutes: 100,
    name: "Synthetic DevOps Pilot Alpha", email: "alpha@devops-pilot.example" },
  expiry: { id: "devops-two-lab-expiry-pilot-v1", title: "PILOT ONLY — DevOps closed-browser expiry verification", minutes: 6,
    name: "Synthetic DevOps Pilot Beta", email: "beta@devops-pilot.example" },
} as const;

type Cohort = {
  id: string; title: string; customScenarioId: string | null; scenarioSlug: string; totalMinutes: number;
  assessmentMode: string; defenceEnabled: boolean; assessmentVersionId: string | null;
  candidates: { name: string; email: string; anonymousId: string }[];
};

/** Inspect identities only; never change or reset an existing attempt. */
export function assertPilotCohortScope(cohorts: Cohort[], versionId: string, requireAlpha: boolean): void {
  if (cohorts.length > 2 || new Set(cohorts.map((row) => row.id)).size !== cohorts.length) throw new Error("Unexpected synthetic cohort count.");
  if (requireAlpha && !cohorts.some((row) => row.id === PILOTS.alpha.id)) throw new Error("Activate the named Alpha pilot before an expiry pilot or rerun.");
  for (const row of cohorts) {
    const expected = Object.values(PILOTS).find((pilot) => pilot.id === row.id);
    if (!expected || row.title !== expected.title || row.customScenarioId !== PILOT_SCENARIO || row.scenarioSlug !== PILOT_SLUG
      || row.totalMinutes !== expected.minutes || row.assessmentMode !== "EVIDENCE" || row.defenceEnabled || row.assessmentVersionId !== versionId) {
      throw new Error("An existing cohort is outside the exact synthetic scope; no overwrite is allowed.");
    }
    if (row.candidates.length !== 1 || row.candidates[0].name !== expected.name || row.candidates[0].email !== expected.email
      || row.candidates[0].anonymousId !== indexToAnonymousId(0)) throw new Error("An existing cohort has unexpected candidates; no attempt is changed.");
  }
}
import { indexToAnonymousId } from "../../src/lib/recruit/tokens";
