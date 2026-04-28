-- Operator Cockpit Phase A — agent identity columns on team_members
-- Phase A에서 inbox-row가 agent identity(컬러+이름)에 즉시 의존하므로 phase A 첫 PR에 동봉.
-- See .omc/plans/2026-04-26-01-operator-cockpit-redesign.md (Phase B.3 — Codebase 정렬: agents 테이블 X, team_members 사용)

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS color      text NOT NULL DEFAULT '#3385f8',
  ADD COLUMN IF NOT EXISTS agent_role text;
  -- agent_role: 'backend'|'frontend'|'qa'|'design'|'pm'|'api' for type='agent', NULL for human

-- Hex color check constraint (codex tactical fix #6 — stored CSS injection 방지)
ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_color_hex_check
    CHECK (color ~ '^#[0-9a-fA-F]{6}$');

-- agent_role only meaningful for agents (codex tactical fix #7 — humans don't need role tag)
ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_agent_role_only_for_agents
    CHECK (
      (type = 'agent' AND (agent_role IS NULL OR agent_role IN ('backend','frontend','qa','design','pm','api')))
      OR (type != 'agent' AND agent_role IS NULL)
    );

COMMENT ON COLUMN public.team_members.color IS 'Hex color for UI identity. Default brand blue. Auto-assigned via hash for new agents.';
COMMENT ON COLUMN public.team_members.agent_role IS 'Agent specialty (backend/frontend/qa/design/pm/api). NULL for human members.';
