-- SID:363 — team_member 본인 자동 생성 RPC (SECURITY DEFINER)
-- RLS INSERT 정책이 admin-only이므로, 본인 human team_member를 생성하는
-- SECURITY DEFINER 함수를 제공하여 일반 member도 self-heal 가능하게 함.

CREATE OR REPLACE FUNCTION public.ensure_my_team_member(
  _org_id uuid,
  _project_id uuid,
  _name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid;
  _member_id uuid;
BEGIN
  _uid := auth.uid();
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- org_member 확인 (본인이 해당 org에 속해있는지)
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members
    WHERE user_id = _uid AND org_id = _org_id
  ) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;

  -- project가 해당 org에 속하는지 확인
  IF NOT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = _project_id AND org_id = _org_id
  ) THEN
    RAISE EXCEPTION 'Project not in this organization';
  END IF;

  -- 기존 team_member 확인
  SELECT id INTO _member_id
  FROM public.team_members
  WHERE user_id = _uid AND project_id = _project_id AND type = 'human'
  LIMIT 1;

  IF _member_id IS NOT NULL THEN
    RETURN _member_id;
  END IF;

  -- 신규 생성
  INSERT INTO public.team_members (org_id, project_id, type, user_id, name, role)
  VALUES (_org_id, _project_id, 'human', _uid, _name, 'member')
  RETURNING id INTO _member_id;

  RETURN _member_id;
END;
$$;
