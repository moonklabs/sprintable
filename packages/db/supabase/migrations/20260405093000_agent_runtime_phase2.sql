-- SID:389 — Phase 2 agent runtime schema
-- AC1~AC8

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 1. agent_deployments
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_deployments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  name              text NOT NULL,
  runtime           text NOT NULL DEFAULT 'openclaw',
  model             text,
  version           text,
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'building', 'active', 'failed', 'archived')),
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_deployed_at  timestamptz,
  created_by        uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_deployments_org_project
  ON public.agent_deployments(org_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_deployments_agent
  ON public.agent_deployments(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_deployments_status
  ON public.agent_deployments(status, created_at DESC);

-- ============================================================
-- 2. agent_runs 확장
-- ============================================================
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS deployment_id uuid REFERENCES public.agent_deployments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;

-- project_id backfill (멱등)
UPDATE public.agent_runs ar
SET project_id = tm.project_id
FROM public.team_members tm
WHERE ar.agent_id = tm.id
  AND ar.project_id IS NULL;

ALTER TABLE public.agent_runs
  ALTER COLUMN project_id SET NOT NULL;

-- duration_ms 계산 컬럼으로 전환 (멱등)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_runs'
      AND column_name = 'duration_ms'
      AND is_generated = 'NEVER'
  ) THEN
    ALTER TABLE public.agent_runs RENAME COLUMN duration_ms TO duration_ms_legacy;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_runs'
      AND column_name = 'duration_ms'
  ) THEN
    ALTER TABLE public.agent_runs
      ADD COLUMN duration_ms integer GENERATED ALWAYS AS (
        CASE
          WHEN finished_at IS NOT NULL AND started_at IS NOT NULL
            THEN GREATEST((EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::integer, 0)
          WHEN duration_ms_legacy IS NOT NULL
            THEN duration_ms_legacy
          ELSE NULL
        END
      ) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_runs_org_status_created
  ON public.agent_runs(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_agent_created
  ON public.agent_runs(project_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_deployment_created
  ON public.agent_runs(deployment_id, created_at DESC)
  WHERE deployment_id IS NOT NULL;

-- ============================================================
-- 3. agent_long_term_memories
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_long_term_memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  deployment_id     uuid REFERENCES public.agent_deployments(id) ON DELETE SET NULL,
  source_run_id     uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  content           text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding         vector(1536),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_org_project
  ON public.agent_long_term_memories(org_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_agent
  ON public.agent_long_term_memories(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_source_run
  ON public.agent_long_term_memories(source_run_id)
  WHERE source_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_embedding
  ON public.agent_long_term_memories
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================
-- 4. agent 연결 검증 (team_members.type=agent)
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_agent_runtime_member()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  _type text;
BEGIN
  SELECT type INTO _type FROM public.team_members WHERE id = NEW.agent_id;
  IF _type IS NULL OR _type != 'agent' THEN
    RAISE EXCEPTION 'agent runtime tables must reference a team_member with type=agent';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_deployments_validate_agent ON public.agent_deployments;
CREATE TRIGGER trg_agent_deployments_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_deployments
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_runtime_member();

DROP TRIGGER IF EXISTS trg_agent_long_term_memories_validate_agent ON public.agent_long_term_memories;
CREATE TRIGGER trg_agent_long_term_memories_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_long_term_memories
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_runtime_member();

-- 기존 agent_runs 검증 트리거는 재사용

-- ============================================================
-- 5. updated_at
-- ============================================================
DROP TRIGGER IF EXISTS trg_agent_deployments_updated_at ON public.agent_deployments;
CREATE TRIGGER trg_agent_deployments_updated_at
  BEFORE UPDATE ON public.agent_deployments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_agent_long_term_memories_updated_at ON public.agent_long_term_memories;
CREATE TRIGGER trg_agent_long_term_memories_updated_at
  BEFORE UPDATE ON public.agent_long_term_memories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 6. RLS
-- ============================================================
ALTER TABLE public.agent_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_long_term_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_deployments_select" ON public.agent_deployments;
CREATE POLICY "agent_deployments_select" ON public.agent_deployments FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "agent_deployments_insert" ON public.agent_deployments;
CREATE POLICY "agent_deployments_insert" ON public.agent_deployments FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_deployments_update" ON public.agent_deployments;
CREATE POLICY "agent_deployments_update" ON public.agent_deployments FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_deployments_delete" ON public.agent_deployments;
CREATE POLICY "agent_deployments_delete" ON public.agent_deployments FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_long_term_memories_select" ON public.agent_long_term_memories;
CREATE POLICY "agent_long_term_memories_select" ON public.agent_long_term_memories FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "agent_long_term_memories_insert" ON public.agent_long_term_memories;
CREATE POLICY "agent_long_term_memories_insert" ON public.agent_long_term_memories FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_long_term_memories_update" ON public.agent_long_term_memories;
CREATE POLICY "agent_long_term_memories_update" ON public.agent_long_term_memories FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
DROP POLICY IF EXISTS "agent_long_term_memories_delete" ON public.agent_long_term_memories;
CREATE POLICY "agent_long_term_memories_delete" ON public.agent_long_term_memories FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
