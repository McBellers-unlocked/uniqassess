# UNIQAssess

Powered by UNICC. AI-era professional-judgement assessment platform. Competency simulations for
professional hiring: declared AI-use modes, evidence-native Knowledge Systems,
scenario preflight, per-candidate tokens, realistic work tasks, short reasoning
defences, and blind human marking with explicit reveal.

Optional **candidate-operated Kubernetes labs** add a direct command console,
recorded runtime evidence and a versioned troubleshooting exercise to written
tasks. The feature is disabled until a dedicated sandbox runner and cluster are
configured; live deployment and pilot checks are still required. See
[Kubernetes lab setup](docs/KUBERNETES_LABS.md) and the
[AWS lab follow-on plan](docs/AWS_CLOUD_LAB_PLAN.md).

Carved out of the Callater (`sdi-assessment-platform`) repo. See
[`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md) for the carve-out log — what
was copied, what was renamed, what was excluded, and what is still open.

---

## Stack

- Next.js 14 (App Router, RSC where possible; `"use client"` for the candidate UI and admin screens)
- TypeScript
- Postgres via Prisma 6
- next-auth 4 (Cognito provider for admin sign-in; candidates are token-based and do **not** use next-auth)
- Anthropic SDK (Claude) for the live AI investigation + persona chat
- Tailwind CSS
- TipTap (memo WYSIWYG), `react-markdown` + `remark-gfm` (AI reply + brief rendering)

---

## AI-era assessment framework

Every database-authored scenario declares one of three versioned policies. The
policy and defence configuration are copied into a cohort when it is created,
so later scenario edits cannot silently change candidate instructions.

| Mode | Declared policy |
|---|---|
| **Evidence Mode** | The in-platform AI can retrieve, compare, explain and challenge supplied material. It cannot author the final deliverable. External AI is not permitted. |
| **Copilot Mode** | The in-platform AI may analyse, outline, draft and revise. Drafts remain visibly labelled and separated from evidence and uncertainty. External AI is not permitted. |
| **Open Agent Mode** | Permitted contemporary tools may be used. The candidate submits a descriptive tool-use declaration and completes the configured human-reviewed defence. |

Memo-task replies use a versioned structured schema: `analysisSummary`,
`evidenceCards[]`, `uncertainties[]`, `questionsToResolve[]`, and an optional
labelled `workingDraft`. Evidence Mode removes `workingDraft` server-side.
Direct-evidence cards carry a stable source ID and excerpt; the server checks
both against the supplied exhibit. A verified match establishes only that the
source/excerpt exists, not that an interpretation is correct. Candidates can
save, check, reject and remove cards on their own evidence board.

The **Role Evidence Review** is a shared design gate for uploaded job
descriptions and WIPO/ITU careers-board imports. AI proposes criteria,
observable behaviours and expected evidence; an accountable reviewer confirms
entry requirement, job importance, consequence, observability, AI condition,
rationale and keep/exclude decisions before task generation. The attributed
record and source provenance are retained in the assessment blueprint. This is
initial assessment-design evidence, not a completed job analysis or
psychometric validation study.

The **Validation Lab** is a design preflight for database scenarios. It hashes
versioned scenario content, persists that exact immutable model-input snapshot,
runs deterministic checks immediately, and queues
model-assisted ambiguity, leakage, accessibility, synthetic-profile and policy
tests on the existing SQS/Lambda worker. Results become stale when content
changes. Publication requires a current completed run, no open blockers and
recorded subject-matter, assessment-design and accessibility reviews, or an
audited demonstration override. This is preflight—not psychometric validation.

The separate **Validation Programme** is the study-governance surface for real
empirical work. Creating a programme freezes a content-addressed assessment
version containing the scenario, tasks, exhibits, rubrics, criteria and AI
policy. New DB-authored cohorts capture such a version automatically and both
candidate delivery and marking read the frozen snapshot. A programme records a
delimited intended use, target population, construct and decision context;
links version-matched pilot cohorts; assigns anonymous independent ratings that
do not alter operational hiring marks; reports descriptive absolute-agreement
statistics; and maintains six attributed evidence domains. A supportive
conclusion is blocked until all domains contain study evidence and an
independent reviewer is identified. The software manages evidence—it does not
manufacture validity, fairness or legal conclusions.

Configured assessments lock the main work before a two-question written
reasoning defence. Questions are generated once under a row lock; a model
timeout or invalid response uses two published deterministic fallbacks. The
defence has its own server deadline and autosave.

Marker-facing telemetry is labelled **work provenance**: Knowledge System
dialogue, evidence actions, paste counts/character totals, focus changes and
time away. Paste content is never captured. Lexical overlap means literal text
similarity only; it is not an authorship or originality detector.

For database-authored scenarios, markers can also enter human criterion-level
component scores against the stable blueprint mappings. Results aggregate these
as descriptive pilot distributions; they do not infer scores from provenance or
model output.

> Work-provenance information is contextual evidence. It must not be treated
> as proof of misconduct or used as an undisclosed scoring criterion.

---

## First-run setup

### 1. Install

```bash
cd C:/dev/meritia
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
# …then fill in the values
```

Required at minimum for a fresh local install:

| Variable | What it is |
|----------|-----------|
| `DATABASE_URL` | Postgres connection string (e.g. `postgres://…@localhost:5432/meritia`). Create the DB first. |
| `NEXTAUTH_URL` | Canonical URL of the admin surface, e.g. `http://localhost:3000`. Used to build candidate invitation URLs. |
| `NEXTAUTH_SECRET` | 32-byte random string. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ANTHROPIC_API_KEY` | Direct key, or set `SECRET_ARN` + `APP_REGION` to fetch from AWS Secrets Manager (production path). |

For admin sign-in you also need:

| Variable | What it is |
|----------|-----------|
| `COGNITO_CLIENT_ID` | Cognito app client ID (PKCE, public client — **no** client secret). |
| `COGNITO_ISSUER` | `https://cognito-idp.<region>.amazonaws.com/<pool-id>` |

### 3. Create or upgrade the database schema

```bash
npx prisma migrate deploy
```

Optionally bootstrap an admin row before first sign-in:

```bash
SEED_ADMIN_EMAIL=you@example.com npm run db:seed
```

(Not required — the first Cognito sign-in auto-creates the admin user.)

### 4. Run

```bash
npm run dev
```

- Marketing landing: `http://localhost:3000/`
- Admin sign-in: `http://localhost:3000/login`
- Admin recruitment list (after sign-in): `http://localhost:3000/admin/recruitment`
- Candidate URL pattern: `http://localhost:3000/assess/<scenario-slug>?token=<token>`

---

## Golden-path manual test (before every release)

Run these end-to-end after any non-trivial change. All assume a fresh local
DB and a working Cognito pool.

### A. Admin can create a cohort against the built-in scenario

1. Sign in → `/admin/recruitment`.
2. Create new assessment, pick the built-in `Finance and Accounting Manager (P4) — IDSC` scenario, set open/close dates and 90 minutes.
3. Open the new assessment → Manage candidates.
4. Paste a test candidate (`Alice Test, alice@example.com`) → Add.
5. Copy the candidate URL.

### B. Candidate can complete the assessment

1. Open the copied URL in an incognito window.
2. Check the landing: organisation, position, duration, close date all rendered.
3. Tick acknowledge → Begin. The timer starts.
4. Ask the IDSC Knowledge System a specific question (e.g. "What's in the intangibles balance?"). Verify a Claude response arrives.
5. Type ≥ 50 words in the Task 1 memo. Switch tabs. Come back. Confirm autosave indicator.
6. Switch to Task 2. Ask another question. Type.
7. Submit. Confirm the read-only "Thank you" page.

### C. Admin can mark the submission

1. Back in admin → open the assessment → "Mark submissions" (shows 1 after submission).
2. Open the candidate's row. The marker view should show the memo + AI investigation trail side-by-side.
3. Enter a per-task score + comment. Save.
4. Go to "Results & ranking". Candidate appears with the total score.

### D. Scripted scenarios: custom builder (smoke)

1. `/admin/recruitment/scenarios` → New scenario.
2. Add a memo_ai task. Paste a short system prompt. Attach an exhibit with some HTML. Add an email_inbox task with one scripted email at offset 60s. Add a chat task with a persona.
3. Publish.
4. Create a cohort against the new custom scenario. Invite a candidate. Start it. Verify email arrives at ~60s and the persona chat popup opens at its offset.

### E. Single-use enforcement

1. Open the candidate URL in browser A. Click Begin.
2. Open the same URL in browser B (no cookie). Click Begin.
3. B must be rejected with a "started in another session" error.

### F. AI-era framework golden path

1. Create a database scenario in Evidence Mode and enable the two-question defence.
2. Add stable criteria and map each to expected task evidence and rubric elements in **Validation Lab**.
3. Run the preflight. Confirm the request returns after queueing and the page polls the worker result.
4. Resolve blockers with reviewer rationale; record subject-matter, assessment-design and accessibility decisions; publish.
5. Create a cohort and confirm its mode badge/configuration remain unchanged after editing the source scenario.
6. As a candidate, ask for evidence. Confirm cards, source status and uncertainty are separate; save and check a card.
7. Submit the memo. Confirm it becomes read-only before defence, complete both defence answers, and submit.
8. As a marker, confirm the submission, structured dialogue, evidence actions, defence and neutral provenance timeline are visible while identity remains hidden.
9. Repeat a reduced path in Copilot Mode (labelled working draft) and Open Agent Mode (tool-use declaration).

### G. Validation Programme study-readiness path

1. Open a published DB scenario → **Validation Programme**.
2. Define the intended score use, target population, construct and decision context; create the programme. Confirm the frozen version hash is shown.
3. Create a fresh cohort from that scenario. Confirm the cohort receives an immutable assessment-version reference.
4. Link the cohort as a pilot. Historical cohorts already in progress must require a detailed retrospective attestation.
5. Select two ADMIN raters and assign submitted candidates.
6. As each rater, open the independent-rating link. Confirm identity, operational marks, dialogue, provenance and other-rater scores are absent.
7. Save a draft, then submit. Confirm submitted study ratings are immutable and do not alter `RecruitmentResponse.score` or candidate ranking.
8. After a balanced double-rated sample exists, inspect the descriptive ICC, mean absolute difference and within-five-marks rate.
9. Record methodology, sample, findings and limitations in all six evidence domains. Confirm a supportive review conclusion is blocked while any domain is incomplete.
10. Attribute the final evidence review to an independent qualified reviewer. Treat the conclusion as version/use/population-specific, never as a universal badge.

Automated checks do not make live model calls:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

### H. Seeded Halcyon demonstration

After migrations and an ADMIN sign-in have created the reviewer account:

```bash
npx tsx scripts/seed-demo-cohort.ts
```

This idempotently recreates three fictional, clearly labelled scenario
variants—Evidence, Copilot and Open Agent—with current demonstration preflight
runs, synthetic Developing/Competent/Strong design artefacts, policy tests,
blueprint mappings, human-review records and a visible cohort for each mode.
The Evidence cohort includes marked and unmarked candidates spanning rich-to-
minimal Knowledge System dialogue, minimal-to-high paste activity and no-to-
substantial time away, plus evidence actions and completed defences. Evidence,
Copilot and Open Agent each include three fresh live-walkthrough invitations.
The script prints the cohort, builder, marker and spare-candidate links and
verifies all new relationships. Remove only these demo rows with
`npx tsx scripts/seed-demo-cohort.ts --teardown`.

---

## Deployment

The code is deployment-agnostic. Validated paths:

- **Vercel / Fly / Railway**: straightforward — set the env vars, run `npm run build`, serve.
- **AWS Amplify SSR**: the Callater origin deployed here. UNIQAssess will work but verify two things:
  1. The serverless bundle includes `infra/recruit/**` at runtime. `next.config.mjs` has `outputFileTracingIncludes` for the `/api/**` and `/assess/**` routes that call `readFileSync`.
  2. Amplify's SSR Lambda timeout is ≥ 60 s. `api/assess/chat/route.ts` sets `export const maxDuration = 60`. If your target platform caps below that, either raise the cap or shorten the Claude call (reduce `RECRUIT_MAX_TOKENS`).
- **Validation worker**: deploy the updated `lambda/task-generator` package before enabling Validation Lab. The established queue now accepts both `{ jobId }` and `{ jobType: "scenario-validation-v1", validationRunId }` messages.
- **RDS in a private VPC**: the Prisma client talks to the DB directly. If the SSR runtime can't reach RDS (e.g. Amplify SSR on a public network with RDS in a private subnet), you will need a DB proxy. The Callater repo shipped a Lambda-proxy transport in `src/lib/prisma.ts`; it was dropped during the carve-out but can be restored if needed - see the git history of `sdi-assessment-platform/src/lib/prisma.ts`.

---

## Open TODOs (stabilisation)

From `docs/MIGRATION_PLAN.md` — the things that must or should be done before
real use:

### Must do before any real candidate sees this

- [ ] **Cognito user pool**: create a dedicated UNIQAssess pool. Do NOT reuse the Callater pool. Only invite accounts that should have admin rights.
- [ ] **Brand assets**: drop in a real `public/favicon.ico`, `apple-touch-icon.png`, `og-image.png`. Placeholder text "M" logo in `/login` works but is temporary.
- [ ] **NEXTAUTH_SECRET**: generate a new one. Never reuse Callater's.
- [ ] **Smoke-test `infra/recruit/*` in prod bundle**: after first deploy, hit the candidate URL and confirm the exhibit renders. If empty, `outputFileTracingIncludes` needs adjusting.

### Nice to have

- [ ] Prune unused `crimson` / `teal` palettes from `tailwind.config.ts`.
- [ ] Consider swapping Cognito for a simpler provider (email magic link via Resend, or credentials provider with bcrypt) if the operator doesn't already have a Cognito pool. `src/lib/auth.ts` is the only change needed.
- [ ] Add a minimal admin-users admin page (create / deactivate). Currently admins are created implicitly by first Cognito sign-in.
- [ ] Decide on candidate-URL host. If `assess.uniqassess.org` ≠ `www.uniqassess.org`, update `NEXTAUTH_URL` and confirm CSV candidate-URL generation uses the right origin.
- [ ] Re-introduce a lightweight logger / request-id middleware. The Callater origin used `console.log`; adequate for now.

### Known brittle bits (flagged)

- `src/lib/recruit/{fam-p4-2026,aplo-p2-2026,rubric}.ts` use `process.cwd()` + `readFileSync` to load scenario exhibits and rubric JSONs. This works with the default Next build. If you see 404-style empty exhibits in production, the serverless bundle is missing `infra/recruit/`.
- Anthropic calls in `src/app/api/assess/chat/route.ts` use prompt caching (`cache_control: ephemeral`). This cuts cost ~90% for repeat prompts within 5 minutes. Do not remove the cache marker without measuring cost impact.
- Legacy code scenarios remain runnable but do not have full editable Validation Lab support. Port one to a database scenario before preflight/publishing it through the builder.

---

## File map (at carve-out)

```
meritia/
├─ docs/MIGRATION_PLAN.md       ← carve-out record, dependencies, risks
├─ prisma/
│  ├─ schema.prisma             ← recruitment models + User
│  └─ seed.ts
├─ infra/recruit/
│  ├─ idsc-fam-p4-2026/         ← FAM exhibits + rubric JSON
│  └─ idsc-aplo-p2-2026/        ← APLO exhibits + rubric JSON
├─ public/                      ← placeholder; drop brand assets here
└─ src/
   ├─ app/
   │  ├─ layout.tsx, page.tsx, globals.css, fonts/
   │  ├─ (auth)/login/page.tsx
   │  ├─ (admin)/admin/recruitment/         ← 9 admin pages
   │  ├─ assess/[scenarioSlug]/page.tsx     ← candidate entry (token URL)
   │  └─ api/
   │     ├─ auth/[...nextauth]/route.ts
   │     ├─ admin/recruitment/              ← ~20 admin endpoints
   │     └─ assess/                         ← 8 candidate endpoints
   ├─ components/
   │  ├─ Nav.tsx, Providers.tsx
   │  ├─ recruit/{AssessmentView,LiveEventsOverlay}.tsx
   │  └─ admin/recruit/                     ← scenario builder editors
   └─ lib/
      ├─ prisma.ts, secrets.ts, auth.ts, admin-auth.ts, constants.ts
      └─ recruit/{types, tokens, candidate-auth, scenario-loader,
                  rubric, fam-p4-2026, aplo-p2-2026}.ts
```

---

## Design principles (from the source platform)

These were the right calls in Callater and UNIQAssess preserves them:

- **AI behaviour follows the declared mode.** Evidence Mode keeps authorship
  with the candidate; Copilot and Open Agent modes permit visibly labelled
  working material while preserving evidence and uncertainty. The server-owned
  mode wrapper overrides contradictory scenario prompt text.
- **Server-enforced timer**. The clock runs against `candidate.startedAt` in
  the DB. Closing the browser, refreshing, or using a second device does not
  stop it. Auto-submit on expiry.
- **Single-use tokens** via cookie + session secret. First browser to call
  `/api/assess/start` locks the session. The candidate can refresh / come back;
  other browsers are rejected.
- **Anonymised marking**. Markers see `Candidate A`, `Candidate AD`, etc. — not
  names or emails — until an admin explicitly clicks Reveal on the cohort.
- **Work provenance without clipboard content capture**. Pastes are logged by character
  count only; the pasted text is never stored. Same for visibility events —
  we record the gap, not what was viewed.
