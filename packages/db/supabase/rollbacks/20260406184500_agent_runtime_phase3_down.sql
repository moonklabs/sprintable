-- S445 rollback — agent runtime core schema

DROP POLICY IF EXISTS "agent_audit_logs_delete" ON public.agent_audit_logs;
DROP POLICY IF EXISTS "agent_audit_logs_insert" ON public.agent_audit_logs;
DROP POLICY IF EXISTS "agent_audit_logs_select" ON public.agent_audit_logs;
DROP POLICY IF EXISTS "agent_hitl_requests_delete" ON public.agent_hitl_requests;
DROP POLICY IF EXISTS "agent_hitl_requests_update" ON public.agent_hitl_requests;
DROP POLICY IF EXISTS "agent_hitl_requests_insert" ON public.agent_hitl_requests;
DROP POLICY IF EXISTS "agent_hitl_requests_select" ON public.agent_hitl_requests;
DROP POLICY IF EXISTS "agent_routing_rules_delete" ON public.agent_routing_rules;
DROP POLICY IF EXISTS "agent_routing_rules_update" ON public.agent_routing_rules;
DROP POLICY IF EXISTS "agent_routing_rules_insert" ON public.agent_routing_rules;
DROP POLICY IF EXISTS "agent_routing_rules_select" ON public.agent_routing_rules;
DROP POLICY IF EXISTS "agent_session_memories_delete" ON public.agent_session_memories;
DROP POLICY IF EXISTS "agent_session_memories_update" ON public.agent_session_memories;
DROP POLICY IF EXISTS "agent_session_memories_insert" ON public.agent_session_memories;
DROP POLICY IF EXISTS "agent_session_memories_select" ON public.agent_session_memories;
DROP POLICY IF EXISTS "agent_sessions_delete" ON public.agent_sessions;
DROP POLICY IF EXISTS "agent_sessions_update" ON public.agent_sessions;
DROP POLICY IF EXISTS "agent_sessions_insert" ON public.agent_sessions;
DROP POLICY IF EXISTS "agent_sessions_select" ON public.agent_sessions;
DROP POLICY IF EXISTS "agent_personas_delete" ON public.agent_personas;
DROP POLICY IF EXISTS "agent_personas_update" ON public.agent_personas;
DROP POLICY IF EXISTS "agent_personas_insert" ON public.agent_personas;
DROP POLICY IF EXISTS "agent_personas_select" ON public.agent_personas;

DROP TRIGGER IF EXISTS trg_agent_hitl_requests_validate_human ON public.agent_hitl_requests;
DROP TRIGGER IF EXISTS trg_agent_audit_logs_validate_agent ON public.agent_audit_logs;
DROP TRIGGER IF EXISTS trg_agent_hitl_requests_validate_agent ON public.agent_hitl_requests;
DROP TRIGGER IF EXISTS trg_agent_routing_rules_validate_agent ON public.agent_routing_rules;
DROP TRIGGER IF EXISTS trg_agent_session_memories_validate_agent ON public.agent_session_memories;
DROP TRIGGER IF EXISTS trg_agent_sessions_validate_agent ON public.agent_sessions;
DROP TRIGGER IF EXISTS trg_agent_personas_validate_agent ON public.agent_personas;

DROP TRIGGER IF EXISTS trg_agent_hitl_requests_updated_at ON public.agent_hitl_requests;
DROP TRIGGER IF EXISTS trg_agent_routing_rules_updated_at ON public.agent_routing_rules;
DROP TRIGGER IF EXISTS trg_agent_session_memories_updated_at ON public.agent_session_memories;
DROP TRIGGER IF EXISTS trg_agent_sessions_updated_at ON public.agent_sessions;
DROP TRIGGER IF EXISTS trg_agent_personas_updated_at ON public.agent_personas;

DROP FUNCTION IF EXISTS public.validate_agent_hitl_human_member();

ALTER TABLE IF EXISTS public.agent_long_term_memories
  DROP CONSTRAINT IF EXISTS fk_agent_long_term_memories_source_session_scope,
  DROP CONSTRAINT IF EXISTS fk_agent_long_term_memories_source_run_scope,
  DROP CONSTRAINT IF EXISTS fk_agent_long_term_memories_deployment_scope,
  DROP CONSTRAINT IF EXISTS fk_agent_long_term_memories_agent_scope;

ALTER TABLE IF EXISTS public.agent_runs
  DROP CONSTRAINT IF EXISTS fk_agent_runs_session_scope,
  DROP CONSTRAINT IF EXISTS fk_agent_runs_deployment_scope,
  DROP CONSTRAINT IF EXISTS fk_agent_runs_agent_scope,
  DROP CONSTRAINT IF EXISTS uq_agent_runs_scope;

ALTER TABLE IF EXISTS public.agent_deployments
  DROP CONSTRAINT IF EXISTS fk_agent_deployments_persona_scope,
  DROP CONSTRAINT IF EXISTS fk_agent_deployments_created_by_scope,
  DROP CONSTRAINT IF EXISTS fk_agent_deployments_agent_scope,
  DROP CONSTRAINT IF EXISTS uq_agent_deployments_scope;

ALTER TABLE IF EXISTS public.team_members
  DROP CONSTRAINT IF EXISTS uq_team_members_id_org_project;

DROP INDEX IF EXISTS idx_agent_audit_logs_event_type;
DROP INDEX IF EXISTS idx_agent_audit_logs_session;
DROP INDEX IF EXISTS idx_agent_audit_logs_run;
DROP INDEX IF EXISTS idx_agent_audit_logs_org_project_created;
DROP INDEX IF EXISTS idx_agent_hitl_requests_session;
DROP INDEX IF EXISTS idx_agent_hitl_requests_run;
DROP INDEX IF EXISTS idx_agent_hitl_requests_requested_for;
DROP INDEX IF EXISTS idx_agent_hitl_requests_status_expires;
DROP INDEX IF EXISTS uq_agent_routing_rules_name;
DROP INDEX IF EXISTS idx_agent_routing_rules_deployment;
DROP INDEX IF EXISTS idx_agent_routing_rules_agent;
DROP INDEX IF EXISTS idx_agent_routing_rules_priority;
DROP INDEX IF EXISTS idx_agent_long_term_memories_type_importance;
DROP INDEX IF EXISTS idx_agent_long_term_memories_source_session;
DROP INDEX IF EXISTS idx_agent_session_memories_run;
DROP INDEX IF EXISTS idx_agent_session_memories_agent_type_created;
DROP INDEX IF EXISTS idx_agent_session_memories_session_created;
DROP INDEX IF EXISTS idx_agent_runs_session_created;
DROP INDEX IF EXISTS uq_agent_sessions_project_session_key;
DROP INDEX IF EXISTS idx_agent_sessions_deployment;
DROP INDEX IF EXISTS idx_agent_sessions_agent;
DROP INDEX IF EXISTS idx_agent_sessions_org_project_status_activity;
DROP INDEX IF EXISTS idx_agent_deployments_persona;
DROP INDEX IF EXISTS uq_agent_personas_default;
DROP INDEX IF EXISTS uq_agent_personas_agent_slug;
DROP INDEX IF EXISTS idx_agent_personas_agent;
DROP INDEX IF EXISTS idx_agent_personas_org_project;

ALTER TABLE public.agent_long_term_memories
  DROP CONSTRAINT IF EXISTS chk_agent_long_term_memories_importance_range,
  DROP CONSTRAINT IF EXISTS chk_agent_long_term_memories_memory_type;

ALTER TABLE public.agent_long_term_memories
  DROP COLUMN IF EXISTS importance,
  DROP COLUMN IF EXISTS memory_type,
  DROP COLUMN IF EXISTS source_session_id;

ALTER TABLE public.agent_runs
  DROP COLUMN IF EXISTS session_id;

ALTER TABLE public.agent_deployments
  DROP COLUMN IF EXISTS persona_id;

DROP TABLE IF EXISTS public.agent_audit_logs;
DROP TABLE IF EXISTS public.agent_hitl_requests;
DROP TABLE IF EXISTS public.agent_routing_rules;
DROP TABLE IF EXISTS public.agent_session_memories;
DROP TABLE IF EXISTS public.agent_sessions;
DROP TABLE IF EXISTS public.agent_personas;
