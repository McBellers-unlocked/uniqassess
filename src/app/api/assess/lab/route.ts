import { NextRequest, NextResponse } from "next/server";
import { loadCandidate, verifySessionCookie } from "@/lib/recruit/candidate-auth";
import { getScenarioForAssessment } from "@/lib/recruit/scenario-loader";
import { isMemoAiTask } from "@/lib/recruit/types";
import { labWorkIsActive, labCommandIssue } from "@/lib/recruit/kubernetes-lab-config";
import { LabError } from "@/lib/recruit/kubernetes-lab-runner";
import { labRequestOriginAllowed } from "@/lib/recruit/kubernetes-lab-origin";
import { readLab, refreshLab, startLab, runLabCommand } from "@/lib/recruit/kubernetes-lab-service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function authorise(token: unknown, number: unknown, mutating: boolean) {
  if (typeof token !== "string" || !token || token.length > 200 || !Number.isInteger(number) || Number(number) < 1) {
    throw new LabError("A valid assessment token and task number are required.", 400);
  }
  const result = await loadCandidate(token);
  if (!result.ok) throw new LabError(result.error, result.status);
  // Cookie required for ALL reads, including retained output after submission.
  if (!await verifySessionCookie(result.candidate)) throw new LabError("Session mismatch.", 403);
  if (mutating && !labWorkIsActive(result.candidate)) throw new LabError("Assessment work is locked or the time has expired.", 403);
  const scenario = await getScenarioForAssessment(result.assessment);
  const task = scenario?.tasks.find((t) => t.number === number);
  if (!task || !isMemoAiTask(task) || !task.kubernetesLab) throw new LabError("This task does not have a practical lab.", 404);
  return { candidate: result.candidate, task, lab: task.kubernetesLab };
}

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function failure(error: unknown) {
  return error instanceof LabError ? response({ error: error.message }, error.status)
    : response({ error: "The practical lab could not be updated. Your saved work is retained." }, 503);
}

export async function GET(request: NextRequest) {
  try {
    const { candidate, task } = await authorise(request.nextUrl.searchParams.get("token"), Number(request.nextUrl.searchParams.get("taskNumber")), false);
    let error: string | undefined;
    try { await refreshLab(candidate.id, task.number, labWorkIsActive(candidate)); }
    catch (e) { error = e instanceof LabError ? e.message : "The lab status could not be refreshed. Your saved work is retained."; }
    return response({ ...await readLab(candidate.id, task.number), ...(error ? { error } : {}) });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    // Browser requests must be same-origin. Server-only broker credentials never reach this endpoint's responses.
    const origin = request.headers.get("origin");
    if (!labRequestOriginAllowed(origin, request.nextUrl.origin)) throw new LabError("Cross-origin lab requests are not permitted.", 403);
    const raw = await request.text();
    if (raw.length > 20_000) throw new LabError("The lab request is too large.", 413);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch { throw new LabError("The lab request must be valid JSON.", 400); }
    if (!["start", "command"].includes(String(body.action))) throw new LabError("Choose a supported lab action.", 400);
    const { candidate, task, lab } = await authorise(body.token, body.taskNumber, true);
    if (body.action === "start") await startLab(candidate.id, task.number, lab.templateId);
    else {
      const issue = labCommandIssue(body.command, body.requestId);
      if (issue) throw new LabError(issue, 400);
      await runLabCommand(candidate.id, task.number, body.command as string, body.requestId as string);
    }
    return response(await readLab(candidate.id, task.number));
  } catch (error) { return failure(error); }
}
