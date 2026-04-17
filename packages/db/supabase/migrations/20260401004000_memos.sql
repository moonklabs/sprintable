-- E-002:S4 — 메모 테이블 + Realtime 활성화

-- ============================================================
-- 1. memos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.memos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  memo_type       text NOT NULL DEFAULT 'memo',
  title           text,
  content         text NOT NULL,
  created_by      uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  assigned_to     uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected')),
  supersedes_id   uuid REFERENCES public.memos(id) ON DELETE SET NULL,
  resolved_by     uuid,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.memos IS '메모 (팀 커뮤니케이션)';

CREATE INDEX idx_memos_org_id ON public.memos(org_id);
CREATE INDEX idx_memos_project_id ON public.memos(project_id);
CREATE INDEX idx_memos_created_by ON public.memos(created_by);
CREATE INDEX idx_memos_assigned_to ON public.memos(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_memos_status ON public.memos(status);

-- ============================================================
-- 2. memo_replies
-- ============================================================
CREATE TABLE IF NOT EXISTS public.memo_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memo_id     uuid NOT NULL REFERENCES public.memos(id) ON DELETE CASCADE,
  content     text NOT NULL,
  created_by  uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  review_type text NOT NULL DEFAULT 'comment',
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.memo_replies IS '메모 답글';

CREATE INDEX idx_memo_replies_memo_id ON public.memo_replies(memo_id);
CREATE INDEX idx_memo_replies_created_by ON public.memo_replies(created_by);

-- ============================================================
-- 3. Helper — 현재 auth user의 human team_member id 조회 (org-scoped)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_team_member_id_for_org(_org_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT id FROM public.team_members
  WHERE user_id = auth.uid() AND type = 'human' AND org_id = _org_id
  LIMIT 1;
$$;

-- ============================================================
-- 4. RLS — org_id 기반 격리 + created_by 위조 방지
-- ============================================================

-- memos
ALTER TABLE public.memos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memos_select" ON public.memos FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "memos_insert" ON public.memos FOR INSERT
  WITH CHECK (
    org_id IN (SELECT public.get_user_org_ids())
    AND created_by = public.get_my_team_member_id_for_org(org_id)
  );
CREATE POLICY "memos_update" ON public.memos FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "memos_delete" ON public.memos FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- memo_replies (memo의 org_id를 통해 격리 + created_by 위조 방지)
ALTER TABLE public.memo_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memo_replies_select" ON public.memo_replies FOR SELECT
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
  );
CREATE POLICY "memo_replies_insert" ON public.memo_replies FOR INSERT
  WITH CHECK (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND created_by IN (
      SELECT public.get_my_team_member_id_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_id
    )
  );
CREATE POLICY "memo_replies_delete" ON public.memo_replies FOR DELETE
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );

-- ============================================================
-- 4. updated_at 트리거
-- ============================================================
CREATE TRIGGER trg_memos_updated_at
  BEFORE UPDATE ON public.memos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 5. created_by immutability 트리거
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_created_by_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'created_by is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_memos_created_by_immutable
  BEFORE UPDATE ON public.memos
  FOR EACH ROW EXECUTE FUNCTION public.prevent_created_by_change();

CREATE TRIGGER trg_memo_replies_created_by_immutable
  BEFORE UPDATE ON public.memo_replies
  FOR EACH ROW EXECUTE FUNCTION public.prevent_created_by_change();

-- ============================================================
-- 6. Supabase Realtime 활성화
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.memos;
ALTER PUBLICATION supabase_realtime ADD TABLE public.memo_replies;
