-- BUG — memo_assignees INSERT RLS multi-membership 호환 수정
-- PR #76 패치 누락분: memo_assignees_insert_org_member가 project_id JOIN 패턴 그대로여서
-- 복수 프로젝트 멤버십 유저의 INSERT 거부. get_my_team_member_ids_for_org() 패턴으로 교체.

DROP POLICY IF EXISTS "memo_assignees_insert_org_member" ON public.memo_assignees;
CREATE POLICY "memo_assignees_insert_org_member"
  ON public.memo_assignees
  FOR INSERT
  TO authenticated
  WITH CHECK (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND assigned_by IN (
      SELECT public.get_my_team_member_ids_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_assignees.memo_id
    )
  );
