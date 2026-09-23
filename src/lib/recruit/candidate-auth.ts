/**
 * Server-side helper: load a candidate by token and verify the request comes
 * from the same browser session that originally started the assessment.
 *
 * Single-use enforcement rule:
 *   - status "invited"   → anyone with the right token can call START to begin.
 *                          Other endpoints reject (assessment not begun).
 *   - status "started"   → only the cookie-bearing browser can continue.
 *                          A second browser using the same token is rejected.
 *   - status "submitted" → all chat/memo/start endpoints reject. Only state
 *                          endpoint is allowed (read-only post-submission view).
 *   - status "expired"   → similarly read-only.
 *
 * Auto-expiry: if the candidate is "started" but past their deadline, this
 * helper transitions them to "submitted" and returns a read-only signal
 * before the caller does any further work.
 */
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { RecruitmentCandidate, RecruitmentAssessment } from "@prisma/client";
import { createCandidateDefence, submitCandidateDefence } from "./defence-service";
import { closeCandidateLabs } from "./kubernetes-lab-service";

export const COOKIE_NAME = "recruit_session";

export type CandidateAuthResult =
  | { ok: true; candidate: RecruitmentCandidate; assessment: RecruitmentAssessment; nowExpired: boolean }
  | { ok: false; status: number; error: string };

export async function loadCandidate(token: string): Promise<CandidateAuthResult> {
  if (!token || typeof token !== "string") {
    return { ok: false, status: 400, error: "token required" };
  }
  const candidate = await prisma.recruitmentCandidate.findUnique({
    where: { token },
    include: { assessment: true },
  });
  if (!candidate) return { ok: false, status: 404, error: "Invalid token" };

  // Window check
  const now = new Date();
  if (candidate.assessment.closeDate < now && candidate.status === "invited") {
    return { ok: false, status: 410, error: "Assessment window has closed" };
  }

  // Auto-expire if past deadline
  let nowExpired = false;
  if (candidate.status === "started" && candidate.deadline && candidate.deadline < now) {
    if (candidate.assessment.defenceEnabled) {
      await createCandidateDefence(candidate.id, candidate.assessment, { fallbackOnly: true });
      candidate.status = "defence";
      candidate.workLockedAt = now;
    } else {
      await prisma.recruitmentCandidate.update({
        where: { id: candidate.id },
        data: { status: "submitted", submittedAt: now, workLockedAt: now },
      });
      candidate.status = "submitted";
      candidate.submittedAt = now;
      candidate.workLockedAt = now;
    }
    nowExpired = true;
    await closeCandidateLabs(candidate.id).catch(() => {});
  }

  // Defence timeout is also server anchored. Autosaved answers remain intact.
  if (candidate.status === "defence") {
    const defence = await prisma.recruitmentCandidateDefence.findUnique({ where: { candidateId: candidate.id } });
    if (defence && defence.status !== "submitted" && defence.deadline < now) {
      await submitCandidateDefence(candidate.id, now);
      candidate.status = "submitted";
      candidate.submittedAt = now;
      nowExpired = true;
    }
  }

  return { ok: true, candidate, assessment: candidate.assessment, nowExpired };
}

/**
 * Verify the cookie carries the right session-token for this candidate.
 * Returns true if cookie matches; false if missing/wrong (caller decides
 * what to do — typically reject with 403 "started in another session").
 */
export async function verifySessionCookie(candidate: RecruitmentCandidate): Promise<boolean> {
  if (!candidate.sessionToken) return false;
  const c = cookies().get(COOKIE_NAME);
  if (!c?.value) return false;
  // cookie value is "<token>:<sessionToken>"
  const [tok, sid] = c.value.split(":", 2);
  return tok === candidate.token && sid === candidate.sessionToken;
}
