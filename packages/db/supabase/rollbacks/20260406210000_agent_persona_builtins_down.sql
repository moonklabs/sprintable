-- S450 rollback — builtin agent personas support

DROP TRIGGER IF EXISTS trg_agent_personas_prevent_builtin_insert ON public.agent_personas;
DROP FUNCTION IF EXISTS public.prevent_builtin_persona_insert();
DROP TRIGGER IF EXISTS trg_team_members_seed_builtin_personas ON public.team_members;
DROP FUNCTION IF EXISTS public.seed_builtin_personas_for_new_agent_member();
DROP FUNCTION IF EXISTS public.seed_builtin_personas(uuid, uuid, uuid);

DROP POLICY IF EXISTS "agent_personas_update" ON public.agent_personas;
CREATE POLICY "agent_personas_update" ON public.agent_personas FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_personas_delete" ON public.agent_personas;
CREATE POLICY "agent_personas_delete" ON public.agent_personas FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DELETE FROM public.agent_personas WHERE is_builtin = true;

DROP INDEX IF EXISTS idx_agent_personas_builtin;

ALTER TABLE public.agent_personas
  DROP COLUMN IF EXISTS is_builtin;
