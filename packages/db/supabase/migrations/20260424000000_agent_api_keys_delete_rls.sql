-- E-SEC-HARDENING:S1 — agent_api_keys DELETE RLS 추가
-- 정책(§13 P0-2): org admin(owner+admin)만 삭제 가능

-- DELETE: org admin(owner+admin)만 삭제 가능
CREATE POLICY "agent_api_keys_delete_admin"
  ON public.agent_api_keys FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = team_member_id
        AND tm.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );
