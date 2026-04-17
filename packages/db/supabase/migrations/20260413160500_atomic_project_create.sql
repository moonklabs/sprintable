-- E-003:S9 — project create + creator membership provisioning must be atomic

CREATE OR REPLACE FUNCTION public.create_project_with_creator_membership(
  _org_id uuid,
  _name text,
  _description text,
  _creator_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid;
  _org_role text;
  _project public.projects%ROWTYPE;
  _normalized_creator_name text;
BEGIN
  _uid := auth.uid();
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO _org_role
  FROM public.org_members
  WHERE user_id = _uid
    AND org_id = _org_id
  LIMIT 1;

  IF _org_role IS NULL THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;

  IF _org_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  _normalized_creator_name := NULLIF(BTRIM(_creator_name), '');

  INSERT INTO public.projects (org_id, name, description)
  VALUES (_org_id, _name, _description)
  RETURNING * INTO _project;

  PERFORM public.ensure_my_team_member(
    _org_id,
    _project.id,
    COALESCE(_normalized_creator_name, 'Unknown user')
  );

  RETURN jsonb_build_object(
    'id', _project.id,
    'org_id', _project.org_id,
    'name', _project.name,
    'description', _project.description,
    'created_at', _project.created_at
  );
END;
$$;
