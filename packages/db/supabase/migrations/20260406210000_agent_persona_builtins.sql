-- S450 — Built-in agent personas: is_builtin column, RLS protection, seeding function
-- Adds is_builtin flag to agent_personas and prevents modification of builtin rows.

-- ============================================================
-- 1. Add is_builtin column
-- ============================================================
ALTER TABLE public.agent_personas
  ADD COLUMN IF NOT EXISTS is_builtin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.agent_personas.is_builtin IS '내장 페르소나 여부 — true이면 수정/삭제 불가';

CREATE INDEX IF NOT EXISTS idx_agent_personas_builtin
  ON public.agent_personas(project_id, agent_id, is_builtin)
  WHERE is_builtin = true AND deleted_at IS NULL;

-- ============================================================
-- 2. RLS policy: block UPDATE/DELETE on builtin personas
-- ============================================================
-- Replace existing UPDATE policy to exclude builtins
DROP POLICY IF EXISTS "agent_personas_update" ON public.agent_personas;
CREATE POLICY "agent_personas_update" ON public.agent_personas FOR UPDATE
  USING (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND is_builtin = false
  )
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND is_builtin = false
  );

-- Replace existing DELETE policy to exclude builtins
DROP POLICY IF EXISTS "agent_personas_delete" ON public.agent_personas;
CREATE POLICY "agent_personas_delete" ON public.agent_personas FOR DELETE
  USING (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND is_builtin = false
  );

-- ============================================================
-- 3. Trigger: prevent INSERT with is_builtin=true from normal users
--    (only seed/migration should set is_builtin)
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_builtin_persona_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Allow service_role (migrations/seeds) but block anon/authenticated
  IF NEW.is_builtin = true AND current_user NOT IN ('service_role', 'supabase_admin', 'postgres') THEN
    RAISE EXCEPTION 'Cannot create builtin personas via client API';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_personas_prevent_builtin_insert ON public.agent_personas;
CREATE TRIGGER trg_agent_personas_prevent_builtin_insert
  BEFORE INSERT ON public.agent_personas
  FOR EACH ROW EXECUTE FUNCTION public.prevent_builtin_persona_insert();

-- ============================================================
-- 4. Function to seed builtin personas for an agent
-- ============================================================
CREATE OR REPLACE FUNCTION public.seed_builtin_personas(
  _org_id uuid,
  _project_id uuid,
  _agent_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _slugs text[] := ARRAY['general', 'product-owner', 'developer', 'qa'];
  _names text[] := ARRAY['General', 'Product Owner', 'Developer', 'QA'];
  _descriptions text[] := ARRAY[
    'General-purpose assistant persona',
    'Product-oriented planning and prioritization persona',
    'Development-focused implementation persona',
    'Quality assurance and testing persona'
  ];
  _system_prompts text[] := ARRAY[
    'You are a general-purpose project assistant. Help the team with any task.',
    'You are a product owner. Focus on requirements, priorities, and stakeholder alignment.',
    'You are a developer. Focus on implementation, code quality, and technical decisions.',
    'You are a QA engineer. Focus on test coverage, edge cases, and quality assurance.'
  ];
  _i integer;
BEGIN
  FOR _i IN 1..4 LOOP
    INSERT INTO public.agent_personas (
      org_id, project_id, agent_id,
      name, slug, description, system_prompt,
      is_builtin, is_default, created_by
    ) VALUES (
      _org_id, _project_id, _agent_id,
      _names[_i], _slugs[_i], _descriptions[_i], _system_prompts[_i],
      true,
      (_i = 1),  -- 'general' is the default
      NULL
    )
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

-- ============================================================
-- 5. Trigger: seed builtins atomically for newly created agents
-- ============================================================
CREATE OR REPLACE FUNCTION public.seed_builtin_personas_for_new_agent_member()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_builtin_personas(NEW.org_id, NEW.project_id, NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_team_members_seed_builtin_personas ON public.team_members;
CREATE TRIGGER trg_team_members_seed_builtin_personas
  AFTER INSERT ON public.team_members
  FOR EACH ROW
  WHEN (NEW.type = 'agent')
  EXECUTE FUNCTION public.seed_builtin_personas_for_new_agent_member();

-- ============================================================
-- 6. Seed builtins for all existing agents
-- ============================================================
DO $$
DECLARE
  _rec RECORD;
BEGIN
  FOR _rec IN
    SELECT id, org_id, project_id
    FROM public.team_members
    WHERE type = 'agent'
  LOOP
    PERFORM public.seed_builtin_personas(_rec.org_id, _rec.project_id, _rec.id);
  END LOOP;
END $$;
