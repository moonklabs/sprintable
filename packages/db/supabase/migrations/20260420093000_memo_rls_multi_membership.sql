-- BUG — 메모 RLS multi-membership 호환 수정
-- get_my_team_member_id_for_org(LIMIT 1)이 멀티 프로젝트 유저의 INSERT를 차단하는 버그 수정
-- 새 SETOF 함수 추가 + 5개 INSERT/UPDATE 정책 교체

-- ============================================================
-- 1. 새 Helper: 유저의 모든 team_member ID 반환 (org-scoped, LIMIT 없음)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_team_member_ids_for_org(_org_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT id FROM public.team_members
  WHERE user_id = auth.uid() AND type = 'human' AND org_id = _org_id;
$$;

-- ============================================================
-- 2. memos_insert — created_by 위조 방지 (multi-membership 호환)
-- ============================================================
DROP POLICY IF EXISTS "memos_insert" ON public.memos;
CREATE POLICY "memos_insert" ON public.memos FOR INSERT
  WITH CHECK (
    org_id IN (SELECT public.get_user_org_ids())
    AND created_by IN (SELECT public.get_my_team_member_ids_for_org(org_id))
  );

-- ============================================================
-- 3. memo_replies_insert — created_by 위조 방지 (multi-membership 호환)
-- ============================================================
DROP POLICY IF EXISTS "memo_replies_insert" ON public.memo_replies;
CREATE POLICY "memo_replies_insert" ON public.memo_replies FOR INSERT
  WITH CHECK (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND created_by IN (
      SELECT public.get_my_team_member_ids_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_id
    )
  );

-- ============================================================
-- 4. memo_doc_links_insert — created_by 위조 방지 (multi-membership 호환)
-- ============================================================
DROP POLICY IF EXISTS "memo_doc_links_insert" ON public.memo_doc_links;
CREATE POLICY "memo_doc_links_insert" ON public.memo_doc_links FOR INSERT
  WITH CHECK (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND doc_id IN (
      SELECT d.id
      FROM public.docs d
      JOIN public.memos m ON m.project_id = d.project_id
      WHERE m.id = memo_id
        AND m.org_id IN (SELECT public.get_user_org_ids())
    )
    AND created_by IN (
      SELECT public.get_my_team_member_ids_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_id
    )
  );

-- ============================================================
-- 5. memo_reads_insert — team_member_id 위조 방지 (multi-membership 호환)
-- ============================================================
DROP POLICY IF EXISTS "memo_reads_insert" ON public.memo_reads;
CREATE POLICY "memo_reads_insert" ON public.memo_reads FOR INSERT
  WITH CHECK (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND team_member_id IN (
      SELECT public.get_my_team_member_ids_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_id
    )
  );

-- ============================================================
-- 6. memo_reads_update — team_member_id 위조 방지 (multi-membership 호환)
-- ============================================================
DROP POLICY IF EXISTS "memo_reads_update" ON public.memo_reads;
CREATE POLICY "memo_reads_update" ON public.memo_reads FOR UPDATE
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND team_member_id IN (
      SELECT public.get_my_team_member_ids_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_id
    )
  );
