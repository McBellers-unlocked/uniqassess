import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { getOrCreateAssessmentVersion } from "@/lib/recruit/assessment-versions";
import { loadPsychometricProgrammeDashboard } from "@/lib/recruit/psychometric-programme-service";
import { PSYCHOMETRIC_EVIDENCE_CATEGORIES } from "@/lib/recruit/psychometrics";
import { awsLabPublicationIssues, taskAwsLab } from "@/lib/recruit/aws-lab-config";
import { awsLabRuntimeAvailable } from "@/lib/recruit/aws-lab-runner";
import { syntheticPilotRestriction } from "@/lib/recruit/controlled-pilot";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  const scenario = await prisma.recruitmentScenario.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!scenario) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await loadPsychometricProgrammeDashboard(params.id));
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => ({}));
  const scenario = await prisma.recruitmentScenario.findUnique({
    where: { id: params.id },
    select: { id: true, title: true, status: true, roleEvidenceRecord: true, tasks: { select: { number: true, title: true, kind: true, config: true } } },
  });
  if (!scenario) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (scenario.status !== "published") {
    return NextResponse.json(
      { error: "Publish the scenario and complete design preflight before freezing a study version." },
      { status: 409 },
    );
  }
  const pilotRestriction = syntheticPilotRestriction(scenario.roleEvidenceRecord);
  if (pilotRestriction) return NextResponse.json({ error: pilotRestriction }, { status: 409 });
  const awsAvailable = scenario.tasks.some((task) => taskAwsLab(task.config)) ? await awsLabRuntimeAvailable() : false;
  const labIssues = awsLabPublicationIssues(scenario.tasks, awsAvailable);
  if (labIssues.length) return NextResponse.json({ error: "Practical lab setup is incomplete", details: labIssues }, { status: 409 });

  const intendedUse = textField(body.intendedUse, 8_000);
  const targetPopulation = textField(body.targetPopulation, 8_000);
  const constructDefinition = textField(body.constructDefinition, 12_000);
  const decisionContext = textField(body.decisionContext, 8_000);
  const missing = [
    ["intended use", intendedUse],
    ["target population", targetPopulation],
    ["construct definition", constructDefinition],
    ["decision context", decisionContext],
  ].filter(([, value]) => !value).map(([label]) => label);
  if (missing.length) {
    return NextResponse.json(
      { error: `Complete the ${missing.join(", ")} before creating the programme.` },
      { status: 400 },
    );
  }

  const version = await getOrCreateAssessmentVersion(params.id, auth.userId);
  const name = textField(body.name, 240) || `${scenario.title} validation programme`;
  const programme = await prisma.recruitmentPsychometricProgramme.create({
    data: {
      scenarioId: params.id,
      assessmentVersionId: version.id,
      name,
      intendedUse,
      targetPopulation,
      constructDefinition,
      decisionContext,
      createdById: auth.userId,
      evidenceRecords: {
        create: PSYCHOMETRIC_EVIDENCE_CATEGORIES.map((category) => ({
          category,
          updatedById: auth.userId,
        })),
      },
    },
    select: { id: true },
  });
  return NextResponse.json(
    { programmeId: programme.id, dashboard: await loadPsychometricProgrammeDashboard(params.id) },
    { status: 201 },
  );
}

function textField(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
