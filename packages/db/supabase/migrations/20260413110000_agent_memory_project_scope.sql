-- Tighten agent memory/session access to the active project membership boundary.

DROP POLICY IF EXISTS "agent_sessions_select" ON public.agent_sessions;
CREATE POLICY "agent_sessions_select" ON public.agent_sessions FOR SELECT
  USING (
    deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_sessions_insert" ON public.agent_sessions;
CREATE POLICY "agent_sessions_insert" ON public.agent_sessions FOR INSERT
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_sessions_update" ON public.agent_sessions;
CREATE POLICY "agent_sessions_update" ON public.agent_sessions FOR UPDATE
  USING (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_sessions_delete" ON public.agent_sessions;
CREATE POLICY "agent_sessions_delete" ON public.agent_sessions FOR DELETE
  USING (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_session_memories_select" ON public.agent_session_memories;
CREATE POLICY "agent_session_memories_select" ON public.agent_session_memories FOR SELECT
  USING (
    deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_session_memories_insert" ON public.agent_session_memories;
CREATE POLICY "agent_session_memories_insert" ON public.agent_session_memories FOR INSERT
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_session_memories_update" ON public.agent_session_memories;
CREATE POLICY "agent_session_memories_update" ON public.agent_session_memories FOR UPDATE
  USING (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_session_memories_delete" ON public.agent_session_memories;
CREATE POLICY "agent_session_memories_delete" ON public.agent_session_memories FOR DELETE
  USING (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_long_term_memories_select" ON public.agent_long_term_memories;
CREATE POLICY "agent_long_term_memories_select" ON public.agent_long_term_memories FOR SELECT
  USING (
    deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_long_term_memories_insert" ON public.agent_long_term_memories;
CREATE POLICY "agent_long_term_memories_insert" ON public.agent_long_term_memories FOR INSERT
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_long_term_memories_update" ON public.agent_long_term_memories;
CREATE POLICY "agent_long_term_memories_update" ON public.agent_long_term_memories FOR UPDATE
  USING (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "agent_long_term_memories_delete" ON public.agent_long_term_memories;
CREATE POLICY "agent_long_term_memories_delete" ON public.agent_long_term_memories FOR DELETE
  USING (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND deleted_at IS NULL
    AND project_id IN (
      SELECT project_id
      FROM public.team_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );
