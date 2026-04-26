-- Operator Cockpit Phase A.1 — inbox_items + RLS + agent type validation trigger
-- See .omc/plans/2026-04-26-01-operator-cockpit-redesign.md
-- Decisions applied: D1 (org_id + team_members(id) + project_id filter), D2 (typed JSONB origin_chain),
--                    Codex tactical: assignee_member_id rename, resolved_option_id uuid, idempotency unique,
--                    explicit RLS policies (5), GIN index on origin_chain.

-- ============================================================
-- 1. inbox_items
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inbox_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  assignee_member_id  uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('approval', 'decision', 'blocker', 'mention')),
  title               text NOT NULL,
  context             text,
  agent_summary       text,
  origin_chain        jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- typed array: [{type:'memo'|'story'|'run'|'initiative', id:'<uuid>'}]
    -- application-layer Zod validation; DB does not enforce referential integrity on chain nodes
  options             jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{id:'<uuid>', label, kind:'approve'|'approve-alt'|'reassign'|'changes', consequence}]
  after_decision      text,
  from_agent_id       uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  story_id            uuid REFERENCES public.stories(id) ON DELETE SET NULL,
  memo_id             uuid REFERENCES public.memos(id) ON DELETE SET NULL,
  priority            text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal')),
  state               text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'resolved', 'dismissed')),
  resolved_by         uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  resolved_option_id  uuid,
    -- references options[].id (jsonb), stable across label/kind drift
  resolved_note       text,
  source_type         text NOT NULL CHECK (source_type IN ('agent_run', 'memo_mention', 'webhook', 'manual')),
  source_id           text NOT NULL,
    -- references agent_runs.id / memos.id / external webhook id / manual creator id
  waiting_since       timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CONSTRAINT inbox_items_source_unique UNIQUE (org_id, source_type, source_id, kind)
);

COMMENT ON TABLE public.inbox_items IS 'HITL 결정 큐 — operator cockpit inbox';

-- ============================================================
-- 2. Indexes
-- ============================================================
CREATE INDEX idx_inbox_items_org_id            ON public.inbox_items(org_id);
CREATE INDEX idx_inbox_items_project_id        ON public.inbox_items(project_id);
CREATE INDEX idx_inbox_items_assignee          ON public.inbox_items(assignee_member_id);
CREATE INDEX idx_inbox_items_pending           ON public.inbox_items(state) WHERE state = 'pending';
CREATE INDEX idx_inbox_items_kind              ON public.inbox_items(kind);
CREATE INDEX idx_inbox_items_created_at        ON public.inbox_items(created_at DESC);
CREATE INDEX idx_inbox_items_origin_chain_gin  ON public.inbox_items USING gin (origin_chain);
CREATE INDEX idx_inbox_items_options_gin       ON public.inbox_items USING gin (options);

-- ============================================================
-- 3. agent type validation trigger (reuse pattern from agent_runs)
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_inbox_item_from_agent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  _type text;
BEGIN
  IF NEW.from_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT type INTO _type FROM public.team_members WHERE id = NEW.from_agent_id;
  IF _type IS NULL OR _type != 'agent' THEN
    RAISE EXCEPTION 'inbox_items.from_agent_id must reference a team_member with type=agent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inbox_items_validate_agent
  BEFORE INSERT OR UPDATE ON public.inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.validate_inbox_item_from_agent();

-- ============================================================
-- 4. RLS — explicit policies (5)
-- inbox_items는 agent reasoning + approval choices를 노출하므로 notifications보다 strict.
-- ============================================================
ALTER TABLE public.inbox_items ENABLE ROW LEVEL SECURITY;

-- 4.1 SELECT — assignee 본인만
CREATE POLICY "inbox_items_select_assignee" ON public.inbox_items FOR SELECT
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    AND assignee_member_id IN (
      SELECT id FROM public.team_members
      WHERE user_id = auth.uid()
    )
  );

-- 4.2 SELECT — admin escalation (audit/escalation 용도)
CREATE POLICY "inbox_items_select_admin" ON public.inbox_items FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- 4.3 UPDATE — assignee 본인 (state, resolved_*)
CREATE POLICY "inbox_items_update_assignee" ON public.inbox_items FOR UPDATE
  USING (
    assignee_member_id IN (
      SELECT id FROM public.team_members
      WHERE user_id = auth.uid()
    )
  );

-- 4.4 UPDATE — admin (reassign 용도, assignee_member_id 변경 가능)
CREATE POLICY "inbox_items_update_admin" ON public.inbox_items FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- 4.5 INSERT — admin org 또는 service_role
CREATE POLICY "inbox_items_insert" ON public.inbox_items FOR INSERT
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = assignee_member_id AND tm.org_id = org_id
    )
  );

-- 4.6 DELETE — admin only
CREATE POLICY "inbox_items_delete" ON public.inbox_items FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
