-- 013: Retro sessions + items + votes + actions

-- 1. retro_sessions
CREATE TABLE IF NOT EXISTS public.retro_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  sprint_id   uuid REFERENCES public.sprints(id) ON DELETE SET NULL,
  title       text NOT NULL,
  phase       text NOT NULL DEFAULT 'collect' CHECK (phase IN ('collect', 'group', 'vote', 'discuss', 'action', 'closed')),
  created_by  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_retro_sessions_project ON public.retro_sessions(project_id);
CREATE INDEX idx_retro_sessions_sprint ON public.retro_sessions(sprint_id);

-- 2. retro_items
CREATE TABLE IF NOT EXISTS public.retro_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.retro_sessions(id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('good', 'bad', 'improve')),
  text        text NOT NULL,
  author_id   uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  vote_count  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_retro_items_session ON public.retro_items(session_id);

-- 3. retro_votes
CREATE TABLE IF NOT EXISTS public.retro_votes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES public.retro_items(id) ON DELETE CASCADE,
  voter_id    uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, voter_id)
);

-- 4. retro_actions
CREATE TABLE IF NOT EXISTS public.retro_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.retro_sessions(id) ON DELETE CASCADE,
  title       text NOT NULL,
  assignee_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_retro_actions_session ON public.retro_actions(session_id);

-- RLS
ALTER TABLE public.retro_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "retro_sessions_select" ON public.retro_sessions FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "retro_sessions_insert" ON public.retro_sessions FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "retro_sessions_update" ON public.retro_sessions FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));

ALTER TABLE public.retro_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "retro_items_select" ON public.retro_items FOR SELECT
  USING (session_id IN (SELECT id FROM public.retro_sessions WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "retro_items_insert" ON public.retro_items FOR INSERT
  WITH CHECK (session_id IN (SELECT id FROM public.retro_sessions WHERE org_id IN (SELECT public.get_user_org_ids())));

ALTER TABLE public.retro_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "retro_votes_select" ON public.retro_votes FOR SELECT
  USING (item_id IN (SELECT id FROM public.retro_items WHERE session_id IN (SELECT id FROM public.retro_sessions WHERE org_id IN (SELECT public.get_user_org_ids()))));
CREATE POLICY "retro_votes_insert" ON public.retro_votes FOR INSERT
  WITH CHECK (item_id IN (SELECT id FROM public.retro_items WHERE session_id IN (SELECT id FROM public.retro_sessions WHERE org_id IN (SELECT public.get_user_org_ids()))));

ALTER TABLE public.retro_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "retro_actions_select" ON public.retro_actions FOR SELECT
  USING (session_id IN (SELECT id FROM public.retro_sessions WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "retro_actions_insert" ON public.retro_actions FOR INSERT
  WITH CHECK (session_id IN (SELECT id FROM public.retro_sessions WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "retro_actions_update" ON public.retro_actions FOR UPDATE
  USING (session_id IN (SELECT id FROM public.retro_sessions WHERE org_id IN (SELECT public.get_user_org_ids())));

-- updated_at
CREATE TRIGGER trg_retro_sessions_updated_at
  BEFORE UPDATE ON public.retro_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- vote_count trigger
CREATE OR REPLACE FUNCTION public.update_retro_vote_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.retro_items SET vote_count = vote_count + 1 WHERE id = NEW.item_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.retro_items SET vote_count = vote_count - 1 WHERE id = OLD.item_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_retro_votes_count
  AFTER INSERT OR DELETE ON public.retro_votes
  FOR EACH ROW EXECUTE FUNCTION public.update_retro_vote_count();
