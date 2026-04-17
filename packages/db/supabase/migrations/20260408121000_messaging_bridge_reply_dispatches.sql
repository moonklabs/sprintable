-- SID:531 — messaging bridge reply dispatch log for durable outbound dedupe

CREATE TABLE IF NOT EXISTS public.messaging_bridge_reply_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  memo_id uuid NOT NULL REFERENCES public.memos(id) ON DELETE CASCADE,
  reply_id uuid NOT NULL REFERENCES public.memo_replies(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('slack', 'discord', 'teams', 'telegram')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token uuid,
  claimed_at timestamptz,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(platform, reply_id)
);

CREATE INDEX IF NOT EXISTS idx_bridge_reply_dispatches_status_claimed_at
  ON public.messaging_bridge_reply_dispatches(platform, status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_bridge_reply_dispatches_memo_id
  ON public.messaging_bridge_reply_dispatches(memo_id);

ALTER TABLE public.messaging_bridge_reply_dispatches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bridge_reply_dispatches_select" ON public.messaging_bridge_reply_dispatches FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
CREATE POLICY "bridge_reply_dispatches_insert" ON public.messaging_bridge_reply_dispatches FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
CREATE POLICY "bridge_reply_dispatches_update" ON public.messaging_bridge_reply_dispatches FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
CREATE POLICY "bridge_reply_dispatches_delete" ON public.messaging_bridge_reply_dispatches FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE TRIGGER trg_bridge_reply_dispatches_updated_at
  BEFORE UPDATE ON public.messaging_bridge_reply_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
