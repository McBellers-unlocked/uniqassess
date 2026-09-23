export const SYNTHETIC_PILOT_RESTRICTION = "This assessment is restricted to its named synthetic technical pilots. Human review and engineer calibration remain incomplete. Ordinary candidates, cohorts and validation programmes cannot be added to this pilot version.";

/** Only the explicit controlled-pilot marker changes ordinary authoring behavior. */
export function syntheticPilotRestriction(roleEvidence: unknown): string | null {
  if (!roleEvidence || typeof roleEvidence !== "object" || Array.isArray(roleEvidence)) return null;
  const pilot = (roleEvidence as Record<string, unknown>).controlledPilot;
  return pilot && typeof pilot === "object" && !Array.isArray(pilot)
    && (pilot as Record<string, unknown>).syntheticOnly === true ? SYNTHETIC_PILOT_RESTRICTION : null;
}

/** Frozen pilot cohorts stay restricted even if a later editable version changes. */
export function syntheticPilotCohortRestriction(snapshot: unknown, currentRoleEvidence: unknown): string | null {
  const frozenRole = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>).roleEvidenceRecord : null;
  return syntheticPilotRestriction(frozenRole) ?? syntheticPilotRestriction(currentRoleEvidence);
}
