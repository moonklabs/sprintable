-- S437 — 다중 프로젝트 기준 invite accept fallback 정리
-- project_id 없는 org-wide 초대는 더 이상 임의 첫 프로젝트를 자동 선택하지 않는다.
-- 단일 프로젝트 조직에서는 기존 레거시 온보딩 호환을 위해 유일 프로젝트로 연결하고,
-- 다중 프로젝트 조직에서는 org_member만 생성한 뒤 project assignment를 기다리도록 한다.

CREATE OR REPLACE FUNCTION public.accept_invitation(_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid;
  _invite record;
  _user_email text;
  _resolved_project_id uuid;
  _candidate_project_ids uuid[];
  _name text;
BEGIN
  _uid := auth.uid();
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO _invite FROM public.invitations
  WHERE token = _token AND accepted_at IS NULL
  FOR UPDATE;

  IF _invite IS NULL THEN
    RAISE EXCEPTION 'Invitation not found or already accepted';
  END IF;

  IF _invite.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation expired';
  END IF;

  SELECT email INTO _user_email FROM auth.users WHERE id = _uid;
  IF _user_email != _invite.email THEN
    RAISE EXCEPTION 'Email mismatch: invitation was sent to a different email';
  END IF;

  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (_invite.org_id, _uid, COALESCE(_invite.role, 'member'))
  ON CONFLICT DO NOTHING;

  IF _invite.project_id IS NOT NULL THEN
    SELECT id INTO _resolved_project_id
    FROM public.projects
    WHERE id = _invite.project_id AND org_id = _invite.org_id;
  ELSE
    SELECT array_agg(id ORDER BY created_at ASC)
    INTO _candidate_project_ids
    FROM (
      SELECT id, created_at
      FROM public.projects
      WHERE org_id = _invite.org_id
      ORDER BY created_at ASC
      LIMIT 2
    ) project_candidates;

    IF COALESCE(array_length(_candidate_project_ids, 1), 0) = 1 THEN
      _resolved_project_id := _candidate_project_ids[1];
    END IF;
  END IF;

  IF _resolved_project_id IS NOT NULL THEN
    _name := COALESCE(
      (SELECT raw_user_meta_data->>'name' FROM auth.users WHERE id = _uid),
      (SELECT raw_user_meta_data->>'full_name' FROM auth.users WHERE id = _uid),
      _user_email,
      'Unknown'
    );

    INSERT INTO public.team_members (org_id, project_id, type, user_id, name, role)
    VALUES (_invite.org_id, _resolved_project_id, 'human', _uid, _name, 'member')
    ON CONFLICT (project_id, user_id) WHERE type = 'human' AND user_id IS NOT NULL
    DO NOTHING;
  END IF;

  UPDATE public.invitations
  SET accepted_at = now()
  WHERE id = _invite.id;

  RETURN jsonb_build_object(
    'ok', true,
    'org_id', _invite.org_id,
    'project_id', _resolved_project_id
  );
END;
$$;
