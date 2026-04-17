-- SID:427 — agent session lifecycle management
ALTER TABLE public.agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_status_check;

ALTER TABLE public.agent_sessions
  ADD COLUMN IF NOT EXISTS context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS idle_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminated_at timestamptz;

UPDATE public.agent_sessions
SET status = CASE status
  WHEN 'paused' THEN 'suspended'
  WHEN 'ended' THEN 'terminated'
  WHEN 'archived' THEN 'terminated'
  ELSE status
END
WHERE status IN ('paused', 'ended', 'archived');

UPDATE public.agent_sessions
SET idle_at = COALESCE(idle_at, last_activity_at)
WHERE status = 'idle' AND idle_at IS NULL;

UPDATE public.agent_sessions
SET suspended_at = COALESCE(suspended_at, last_activity_at)
WHERE status = 'suspended' AND suspended_at IS NULL;

UPDATE public.agent_sessions
SET terminated_at = COALESCE(terminated_at, ended_at, last_activity_at),
    ended_at = COALESCE(ended_at, terminated_at, last_activity_at)
WHERE status = 'terminated' AND terminated_at IS NULL;

ALTER TABLE public.agent_sessions
  ADD CONSTRAINT agent_sessions_status_check
  CHECK (status IN ('active', 'idle', 'suspended', 'terminated'));

DROP INDEX IF EXISTS idx_agent_sessions_org_project_status_activity;
CREATE INDEX IF NOT EXISTS idx_agent_sessions_org_project_status_activity
  ON public.agent_sessions(org_id, project_id, status, last_activity_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_status_activity
  ON public.agent_sessions(agent_id, status, last_activity_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_session_status_created
  ON public.agent_runs(session_id, status, created_at DESC)
  WHERE session_id IS NOT NULL;
