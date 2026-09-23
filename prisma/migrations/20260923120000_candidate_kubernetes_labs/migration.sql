CREATE TABLE "recruitment_lab_sessions" (
  "id" TEXT NOT NULL,
  "candidate_id" TEXT NOT NULL,
  "task_number" INTEGER NOT NULL,
  "template_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'starting',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "error" TEXT,
  "snapshot" JSONB,
  "cleanup_completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recruitment_lab_sessions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "recruitment_lab_commands" (
  "id" UUID NOT NULL,
  "session_id" TEXT NOT NULL,
  "request_id" UUID NOT NULL,
  "command" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "stdout" TEXT NOT NULL DEFAULT '',
  "stderr" TEXT NOT NULL DEFAULT '',
  "exit_code" INTEGER,
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "recruitment_lab_commands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "recruitment_lab_sessions_candidate_id_task_number_key" ON "recruitment_lab_sessions"("candidate_id", "task_number");
CREATE INDEX "recruitment_lab_sessions_status_expires_at_idx" ON "recruitment_lab_sessions"("status", "expires_at");
CREATE UNIQUE INDEX "recruitment_lab_commands_session_id_request_id_key" ON "recruitment_lab_commands"("session_id", "request_id");
CREATE INDEX "recruitment_lab_commands_session_id_created_at_idx" ON "recruitment_lab_commands"("session_id", "created_at");
ALTER TABLE "recruitment_lab_sessions" ADD CONSTRAINT "recruitment_lab_sessions_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruitment_lab_commands" ADD CONSTRAINT "recruitment_lab_commands_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "recruitment_lab_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
