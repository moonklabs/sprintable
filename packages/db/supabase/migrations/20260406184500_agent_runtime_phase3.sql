-- S445 — Phase 2 first axis: agent runtime core schema
-- Adds the remaining runtime tables for personas / sessions / routing / HITL / audit.

-- ============================================================
-- 1. agent_personas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_personas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  name          text NOT NULL,
  slug          text NOT NULL,
  description   text,
  system_prompt text NOT NULL DEFAULT '',
  style_prompt  text,
  model         text,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default    boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

COMMENT ON TABLE public.agent_personas IS '에이전트 페르소나 정의';

CREATE INDEX IF NOT EXISTS idx_agent_personas_org_project
  ON public.agent_personas(org_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_personas_agent
  ON public.agent_personas(agent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_personas_agent_slug
  ON public.agent_personas(project_id, agent_id, slug)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_personas_default
  ON public.agent_personas(project_id, agent_id)
  WHERE is_default = true AND deleted_at IS NULL;

-- ============================================================
-- 2. agent_deployments 확장
-- ============================================================
ALTER TABLE public.agent_deployments
  ADD COLUMN IF NOT EXISTS persona_id uuid REFERENCES public.agent_personas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_deployments_persona
  ON public.agent_deployments(persona_id, created_at DESC)
  WHERE persona_id IS NOT NULL;

-- ============================================================
-- 3. agent_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id              uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  persona_id            uuid REFERENCES public.agent_personas(id) ON DELETE SET NULL,
  deployment_id         uuid REFERENCES public.agent_deployments(id) ON DELETE SET NULL,
  session_key           text NOT NULL,
  channel               text NOT NULL DEFAULT 'internal',
  title                 text,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'idle', 'paused', 'ended', 'archived')),
  context_window_tokens integer CHECK (context_window_tokens IS NULL OR context_window_tokens > 0),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  last_activity_at      timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

COMMENT ON TABLE public.agent_sessions IS '에이전트 세션 메타데이터';

CREATE INDEX IF NOT EXISTS idx_agent_sessions_org_project_status_activity
  ON public.agent_sessions(org_id, project_id, status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent
  ON public.agent_sessions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_deployment
  ON public.agent_sessions(deployment_id, created_at DESC)
  WHERE deployment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_sessions_project_session_key
  ON public.agent_sessions(project_id, session_key)
  WHERE deleted_at IS NULL;

-- ============================================================
-- 4. agent_runs 확장
-- ============================================================
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.agent_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_session_created
  ON public.agent_runs(session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

-- ============================================================
-- 5. agent_session_memories
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_session_memories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES public.agent_sessions(id) ON DELETE CASCADE,
  run_id      uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  memory_type text NOT NULL DEFAULT 'context'
                CHECK (memory_type IN ('context', 'summary', 'decision', 'todo', 'fact')),
  importance  smallint NOT NULL DEFAULT 50 CHECK (importance BETWEEN 0 AND 100),
  content     text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

COMMENT ON TABLE public.agent_session_memories IS '세션 단기 메모리 스냅샷';

CREATE INDEX IF NOT EXISTS idx_agent_session_memories_session_created
  ON public.agent_session_memories(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_session_memories_agent_type_created
  ON public.agent_session_memories(agent_id, memory_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_session_memories_run
  ON public.agent_session_memories(run_id)
  WHERE run_id IS NOT NULL;

-- ============================================================
-- 6. agent_long_term_memories 확장
-- ============================================================
ALTER TABLE public.agent_long_term_memories
  ADD COLUMN IF NOT EXISTS source_session_id uuid REFERENCES public.agent_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS memory_type text NOT NULL DEFAULT 'fact',
  ADD COLUMN IF NOT EXISTS importance smallint NOT NULL DEFAULT 50;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_agent_long_term_memories_memory_type'
  ) THEN
    ALTER TABLE public.agent_long_term_memories
      ADD CONSTRAINT chk_agent_long_term_memories_memory_type
      CHECK (memory_type IN ('context', 'summary', 'decision', 'todo', 'fact'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_agent_long_term_memories_importance_range'
  ) THEN
    ALTER TABLE public.agent_long_term_memories
      ADD CONSTRAINT chk_agent_long_term_memories_importance_range
      CHECK (importance BETWEEN 0 AND 100);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_source_session
  ON public.agent_long_term_memories(source_session_id)
  WHERE source_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_type_importance
  ON public.agent_long_term_memories(agent_id, memory_type, importance DESC, created_at DESC);

-- ============================================================
-- 7. agent_routing_rules
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_routing_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id       uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  persona_id     uuid REFERENCES public.agent_personas(id) ON DELETE SET NULL,
  deployment_id  uuid REFERENCES public.agent_deployments(id) ON DELETE SET NULL,
  name           text NOT NULL,
  priority       integer NOT NULL DEFAULT 100,
  match_type     text NOT NULL DEFAULT 'event'
                   CHECK (match_type IN ('event', 'channel', 'project', 'manual', 'fallback')),
  conditions     jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_runtime text NOT NULL DEFAULT 'openclaw',
  target_model   text,
  is_enabled     boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

COMMENT ON TABLE public.agent_routing_rules IS '에이전트 라우팅 / 모델 선택 규칙';

CREATE INDEX IF NOT EXISTS idx_agent_routing_rules_priority
  ON public.agent_routing_rules(org_id, project_id, is_enabled, priority ASC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_routing_rules_agent
  ON public.agent_routing_rules(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_routing_rules_deployment
  ON public.agent_routing_rules(deployment_id, created_at DESC)
  WHERE deployment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_routing_rules_name
  ON public.agent_routing_rules(project_id, agent_id, name)
  WHERE deleted_at IS NULL;

-- ============================================================
-- 8. agent_hitl_requests
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_hitl_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  deployment_id uuid REFERENCES public.agent_deployments(id) ON DELETE SET NULL,
  session_id    uuid REFERENCES public.agent_sessions(id) ON DELETE SET NULL,
  run_id        uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  request_type  text NOT NULL DEFAULT 'approval'
                  CHECK (request_type IN ('approval', 'input', 'confirmation', 'escalation')),
  title         text NOT NULL,
  prompt        text NOT NULL,
  requested_for uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled', 'resolved')),
  response_text text,
  responded_by  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  responded_at  timestamptz,
  expires_at    timestamptz,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

COMMENT ON TABLE public.agent_hitl_requests IS '사람 승인/입력 개입 요청';

CREATE INDEX IF NOT EXISTS idx_agent_hitl_requests_status_expires
  ON public.agent_hitl_requests(org_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_hitl_requests_requested_for
  ON public.agent_hitl_requests(requested_for, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_hitl_requests_run
  ON public.agent_hitl_requests(run_id)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_hitl_requests_session
  ON public.agent_hitl_requests(session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

-- ============================================================
-- 9. agent_audit_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  deployment_id uuid REFERENCES public.agent_deployments(id) ON DELETE SET NULL,
  session_id    uuid REFERENCES public.agent_sessions(id) ON DELETE SET NULL,
  run_id        uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  event_type    text NOT NULL,
  severity      text NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('debug', 'info', 'warn', 'error', 'security')),
  summary       text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_audit_logs IS '에이전트 런타임 감사 로그';

CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_org_project_created
  ON public.agent_audit_logs(org_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_run
  ON public.agent_audit_logs(run_id, created_at DESC)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_session
  ON public.agent_audit_logs(session_id, created_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_event_type
  ON public.agent_audit_logs(event_type, created_at DESC);

-- ============================================================
-- 10. scope integrity constraints
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_team_members_id_org_project'
  ) THEN
    ALTER TABLE public.team_members
      ADD CONSTRAINT uq_team_members_id_org_project UNIQUE (id, org_id, project_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_agent_personas_scope'
  ) THEN
    ALTER TABLE public.agent_personas
      ADD CONSTRAINT uq_agent_personas_scope UNIQUE (id, org_id, project_id, agent_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_agent_deployments_scope'
  ) THEN
    ALTER TABLE public.agent_deployments
      ADD CONSTRAINT uq_agent_deployments_scope UNIQUE (id, org_id, project_id, agent_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_agent_sessions_scope'
  ) THEN
    ALTER TABLE public.agent_sessions
      ADD CONSTRAINT uq_agent_sessions_scope UNIQUE (id, org_id, project_id, agent_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_agent_runs_scope'
  ) THEN
    ALTER TABLE public.agent_runs
      ADD CONSTRAINT uq_agent_runs_scope UNIQUE (id, org_id, project_id, agent_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_personas_agent_scope'
  ) THEN
    ALTER TABLE public.agent_personas
      ADD CONSTRAINT fk_agent_personas_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_personas_created_by_scope'
  ) THEN
    ALTER TABLE public.agent_personas
      ADD CONSTRAINT fk_agent_personas_created_by_scope
      FOREIGN KEY (created_by, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_deployments_agent_scope'
  ) THEN
    ALTER TABLE public.agent_deployments
      ADD CONSTRAINT fk_agent_deployments_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_deployments_persona_scope'
  ) THEN
    ALTER TABLE public.agent_deployments
      ADD CONSTRAINT fk_agent_deployments_persona_scope
      FOREIGN KEY (persona_id, org_id, project_id, agent_id)
      REFERENCES public.agent_personas(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_deployments_created_by_scope'
  ) THEN
    ALTER TABLE public.agent_deployments
      ADD CONSTRAINT fk_agent_deployments_created_by_scope
      FOREIGN KEY (created_by, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_sessions_agent_scope'
  ) THEN
    ALTER TABLE public.agent_sessions
      ADD CONSTRAINT fk_agent_sessions_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_sessions_persona_scope'
  ) THEN
    ALTER TABLE public.agent_sessions
      ADD CONSTRAINT fk_agent_sessions_persona_scope
      FOREIGN KEY (persona_id, org_id, project_id, agent_id)
      REFERENCES public.agent_personas(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_sessions_deployment_scope'
  ) THEN
    ALTER TABLE public.agent_sessions
      ADD CONSTRAINT fk_agent_sessions_deployment_scope
      FOREIGN KEY (deployment_id, org_id, project_id, agent_id)
      REFERENCES public.agent_deployments(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_sessions_created_by_scope'
  ) THEN
    ALTER TABLE public.agent_sessions
      ADD CONSTRAINT fk_agent_sessions_created_by_scope
      FOREIGN KEY (created_by, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_runs_agent_scope'
  ) THEN
    ALTER TABLE public.agent_runs
      ADD CONSTRAINT fk_agent_runs_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_runs_deployment_scope'
  ) THEN
    ALTER TABLE public.agent_runs
      ADD CONSTRAINT fk_agent_runs_deployment_scope
      FOREIGN KEY (deployment_id, org_id, project_id, agent_id)
      REFERENCES public.agent_deployments(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_runs_session_scope'
  ) THEN
    ALTER TABLE public.agent_runs
      ADD CONSTRAINT fk_agent_runs_session_scope
      FOREIGN KEY (session_id, org_id, project_id, agent_id)
      REFERENCES public.agent_sessions(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_session_memories_agent_scope'
  ) THEN
    ALTER TABLE public.agent_session_memories
      ADD CONSTRAINT fk_agent_session_memories_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_session_memories_session_scope'
  ) THEN
    ALTER TABLE public.agent_session_memories
      ADD CONSTRAINT fk_agent_session_memories_session_scope
      FOREIGN KEY (session_id, org_id, project_id, agent_id)
      REFERENCES public.agent_sessions(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_session_memories_run_scope'
  ) THEN
    ALTER TABLE public.agent_session_memories
      ADD CONSTRAINT fk_agent_session_memories_run_scope
      FOREIGN KEY (run_id, org_id, project_id, agent_id)
      REFERENCES public.agent_runs(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_long_term_memories_agent_scope'
  ) THEN
    ALTER TABLE public.agent_long_term_memories
      ADD CONSTRAINT fk_agent_long_term_memories_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_long_term_memories_deployment_scope'
  ) THEN
    ALTER TABLE public.agent_long_term_memories
      ADD CONSTRAINT fk_agent_long_term_memories_deployment_scope
      FOREIGN KEY (deployment_id, org_id, project_id, agent_id)
      REFERENCES public.agent_deployments(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_long_term_memories_source_run_scope'
  ) THEN
    ALTER TABLE public.agent_long_term_memories
      ADD CONSTRAINT fk_agent_long_term_memories_source_run_scope
      FOREIGN KEY (source_run_id, org_id, project_id, agent_id)
      REFERENCES public.agent_runs(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_long_term_memories_source_session_scope'
  ) THEN
    ALTER TABLE public.agent_long_term_memories
      ADD CONSTRAINT fk_agent_long_term_memories_source_session_scope
      FOREIGN KEY (source_session_id, org_id, project_id, agent_id)
      REFERENCES public.agent_sessions(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_routing_rules_agent_scope'
  ) THEN
    ALTER TABLE public.agent_routing_rules
      ADD CONSTRAINT fk_agent_routing_rules_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_routing_rules_persona_scope'
  ) THEN
    ALTER TABLE public.agent_routing_rules
      ADD CONSTRAINT fk_agent_routing_rules_persona_scope
      FOREIGN KEY (persona_id, org_id, project_id, agent_id)
      REFERENCES public.agent_personas(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_routing_rules_deployment_scope'
  ) THEN
    ALTER TABLE public.agent_routing_rules
      ADD CONSTRAINT fk_agent_routing_rules_deployment_scope
      FOREIGN KEY (deployment_id, org_id, project_id, agent_id)
      REFERENCES public.agent_deployments(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_routing_rules_created_by_scope'
  ) THEN
    ALTER TABLE public.agent_routing_rules
      ADD CONSTRAINT fk_agent_routing_rules_created_by_scope
      FOREIGN KEY (created_by, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_hitl_requests_agent_scope'
  ) THEN
    ALTER TABLE public.agent_hitl_requests
      ADD CONSTRAINT fk_agent_hitl_requests_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_hitl_requests_deployment_scope'
  ) THEN
    ALTER TABLE public.agent_hitl_requests
      ADD CONSTRAINT fk_agent_hitl_requests_deployment_scope
      FOREIGN KEY (deployment_id, org_id, project_id, agent_id)
      REFERENCES public.agent_deployments(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_hitl_requests_session_scope'
  ) THEN
    ALTER TABLE public.agent_hitl_requests
      ADD CONSTRAINT fk_agent_hitl_requests_session_scope
      FOREIGN KEY (session_id, org_id, project_id, agent_id)
      REFERENCES public.agent_sessions(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_hitl_requests_run_scope'
  ) THEN
    ALTER TABLE public.agent_hitl_requests
      ADD CONSTRAINT fk_agent_hitl_requests_run_scope
      FOREIGN KEY (run_id, org_id, project_id, agent_id)
      REFERENCES public.agent_runs(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_hitl_requests_requested_for_scope'
  ) THEN
    ALTER TABLE public.agent_hitl_requests
      ADD CONSTRAINT fk_agent_hitl_requests_requested_for_scope
      FOREIGN KEY (requested_for, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_hitl_requests_responded_by_scope'
  ) THEN
    ALTER TABLE public.agent_hitl_requests
      ADD CONSTRAINT fk_agent_hitl_requests_responded_by_scope
      FOREIGN KEY (responded_by, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_audit_logs_agent_scope'
  ) THEN
    ALTER TABLE public.agent_audit_logs
      ADD CONSTRAINT fk_agent_audit_logs_agent_scope
      FOREIGN KEY (agent_id, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_audit_logs_deployment_scope'
  ) THEN
    ALTER TABLE public.agent_audit_logs
      ADD CONSTRAINT fk_agent_audit_logs_deployment_scope
      FOREIGN KEY (deployment_id, org_id, project_id, agent_id)
      REFERENCES public.agent_deployments(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_audit_logs_session_scope'
  ) THEN
    ALTER TABLE public.agent_audit_logs
      ADD CONSTRAINT fk_agent_audit_logs_session_scope
      FOREIGN KEY (session_id, org_id, project_id, agent_id)
      REFERENCES public.agent_sessions(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_audit_logs_run_scope'
  ) THEN
    ALTER TABLE public.agent_audit_logs
      ADD CONSTRAINT fk_agent_audit_logs_run_scope
      FOREIGN KEY (run_id, org_id, project_id, agent_id)
      REFERENCES public.agent_runs(id, org_id, project_id, agent_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_audit_logs_created_by_scope'
  ) THEN
    ALTER TABLE public.agent_audit_logs
      ADD CONSTRAINT fk_agent_audit_logs_created_by_scope
      FOREIGN KEY (created_by, org_id, project_id)
      REFERENCES public.team_members(id, org_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

-- ============================================================
-- 11. validation triggers
-- ============================================================
DROP TRIGGER IF EXISTS trg_agent_personas_validate_agent ON public.agent_personas;
CREATE TRIGGER trg_agent_personas_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_personas
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_runtime_member();

DROP TRIGGER IF EXISTS trg_agent_sessions_validate_agent ON public.agent_sessions;
CREATE TRIGGER trg_agent_sessions_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_sessions
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_runtime_member();

DROP TRIGGER IF EXISTS trg_agent_session_memories_validate_agent ON public.agent_session_memories;
CREATE TRIGGER trg_agent_session_memories_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_session_memories
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_runtime_member();

DROP TRIGGER IF EXISTS trg_agent_routing_rules_validate_agent ON public.agent_routing_rules;
CREATE TRIGGER trg_agent_routing_rules_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_routing_rules
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_runtime_member();

DROP TRIGGER IF EXISTS trg_agent_hitl_requests_validate_agent ON public.agent_hitl_requests;
CREATE TRIGGER trg_agent_hitl_requests_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_hitl_requests
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_runtime_member();

DROP TRIGGER IF EXISTS trg_agent_audit_logs_validate_agent ON public.agent_audit_logs;
CREATE TRIGGER trg_agent_audit_logs_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_runtime_member();

CREATE OR REPLACE FUNCTION public.validate_agent_hitl_human_member()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  _requested_type text;
  _responded_type text;
BEGIN
  IF NEW.requested_for IS NOT NULL THEN
    SELECT type INTO _requested_type FROM public.team_members WHERE id = NEW.requested_for;
    IF _requested_type IS NULL OR _requested_type != 'human' THEN
      RAISE EXCEPTION 'agent_hitl_requests.requested_for must reference a team_member with type=human';
    END IF;
  END IF;

  IF NEW.responded_by IS NOT NULL THEN
    SELECT type INTO _responded_type FROM public.team_members WHERE id = NEW.responded_by;
    IF _responded_type IS NULL OR _responded_type != 'human' THEN
      RAISE EXCEPTION 'agent_hitl_requests.responded_by must reference a team_member with type=human';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_hitl_requests_validate_human ON public.agent_hitl_requests;
CREATE TRIGGER trg_agent_hitl_requests_validate_human
  BEFORE INSERT OR UPDATE ON public.agent_hitl_requests
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_hitl_human_member();

-- ============================================================
-- 12. updated_at triggers
-- ============================================================
DROP TRIGGER IF EXISTS trg_agent_personas_updated_at ON public.agent_personas;
CREATE TRIGGER trg_agent_personas_updated_at
  BEFORE UPDATE ON public.agent_personas
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_agent_sessions_updated_at ON public.agent_sessions;
CREATE TRIGGER trg_agent_sessions_updated_at
  BEFORE UPDATE ON public.agent_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_agent_session_memories_updated_at ON public.agent_session_memories;
CREATE TRIGGER trg_agent_session_memories_updated_at
  BEFORE UPDATE ON public.agent_session_memories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_agent_routing_rules_updated_at ON public.agent_routing_rules;
CREATE TRIGGER trg_agent_routing_rules_updated_at
  BEFORE UPDATE ON public.agent_routing_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_agent_hitl_requests_updated_at ON public.agent_hitl_requests;
CREATE TRIGGER trg_agent_hitl_requests_updated_at
  BEFORE UPDATE ON public.agent_hitl_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 13. RLS
-- ============================================================
ALTER TABLE public.agent_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_session_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_hitl_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_personas_select" ON public.agent_personas;
CREATE POLICY "agent_personas_select" ON public.agent_personas FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "agent_personas_insert" ON public.agent_personas;
CREATE POLICY "agent_personas_insert" ON public.agent_personas FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_personas_update" ON public.agent_personas;
CREATE POLICY "agent_personas_update" ON public.agent_personas FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_personas_delete" ON public.agent_personas;
CREATE POLICY "agent_personas_delete" ON public.agent_personas FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_sessions_select" ON public.agent_sessions;
CREATE POLICY "agent_sessions_select" ON public.agent_sessions FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "agent_sessions_insert" ON public.agent_sessions;
CREATE POLICY "agent_sessions_insert" ON public.agent_sessions FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_sessions_update" ON public.agent_sessions;
CREATE POLICY "agent_sessions_update" ON public.agent_sessions FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_sessions_delete" ON public.agent_sessions;
CREATE POLICY "agent_sessions_delete" ON public.agent_sessions FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_session_memories_select" ON public.agent_session_memories;
CREATE POLICY "agent_session_memories_select" ON public.agent_session_memories FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "agent_session_memories_insert" ON public.agent_session_memories;
CREATE POLICY "agent_session_memories_insert" ON public.agent_session_memories FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_session_memories_update" ON public.agent_session_memories;
CREATE POLICY "agent_session_memories_update" ON public.agent_session_memories FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_session_memories_delete" ON public.agent_session_memories;
CREATE POLICY "agent_session_memories_delete" ON public.agent_session_memories FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_routing_rules_select" ON public.agent_routing_rules;
CREATE POLICY "agent_routing_rules_select" ON public.agent_routing_rules FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "agent_routing_rules_insert" ON public.agent_routing_rules;
CREATE POLICY "agent_routing_rules_insert" ON public.agent_routing_rules FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_routing_rules_update" ON public.agent_routing_rules;
CREATE POLICY "agent_routing_rules_update" ON public.agent_routing_rules FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_routing_rules_delete" ON public.agent_routing_rules;
CREATE POLICY "agent_routing_rules_delete" ON public.agent_routing_rules FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_hitl_requests_select" ON public.agent_hitl_requests;
CREATE POLICY "agent_hitl_requests_select" ON public.agent_hitl_requests FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "agent_hitl_requests_insert" ON public.agent_hitl_requests;
CREATE POLICY "agent_hitl_requests_insert" ON public.agent_hitl_requests FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_hitl_requests_update" ON public.agent_hitl_requests;
CREATE POLICY "agent_hitl_requests_update" ON public.agent_hitl_requests FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_hitl_requests_delete" ON public.agent_hitl_requests;
CREATE POLICY "agent_hitl_requests_delete" ON public.agent_hitl_requests FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_audit_logs_select" ON public.agent_audit_logs;
CREATE POLICY "agent_audit_logs_select" ON public.agent_audit_logs FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
DROP POLICY IF EXISTS "agent_audit_logs_insert" ON public.agent_audit_logs;
CREATE POLICY "agent_audit_logs_insert" ON public.agent_audit_logs FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_audit_logs_delete" ON public.agent_audit_logs;
CREATE POLICY "agent_audit_logs_delete" ON public.agent_audit_logs FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
