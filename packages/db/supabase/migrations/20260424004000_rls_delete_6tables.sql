-- E-SEC-HARDENING:S6 — DELETE RLS 일괄 봉쇄 (6테이블)
-- 정책(policy-webhook §2, policy-standup §2, policy-retrospective §2)

-- AC1: webhook_configs
CREATE POLICY "webhook_configs_delete_admin"
  ON public.webhook_configs FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- AC2: standup_entries
CREATE POLICY "standup_entries_delete_admin"
  ON public.standup_entries FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- AC3: retro_sessions
CREATE POLICY "retro_sessions_delete_admin"
  ON public.retro_sessions FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- AC4: retro_items (session_id → retro_sessions.org_id)
CREATE POLICY "retro_items_delete_admin"
  ON public.retro_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.retro_sessions rs
      WHERE rs.id = session_id
        AND rs.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );

-- AC5: retro_votes (item_id → retro_items → retro_sessions.org_id)
CREATE POLICY "retro_votes_delete_admin"
  ON public.retro_votes FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.retro_items ri
      JOIN public.retro_sessions rs ON rs.id = ri.session_id
      WHERE ri.id = item_id
        AND rs.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );

-- AC6: retro_actions (session_id → retro_sessions.org_id)
CREATE POLICY "retro_actions_delete_admin"
  ON public.retro_actions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.retro_sessions rs
      WHERE rs.id = session_id
        AND rs.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );
