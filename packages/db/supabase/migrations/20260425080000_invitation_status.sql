-- E-PLATFORM-SECURE S3: invitations.status 컬럼 추가 (revoke 지원)

ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'accepted', 'revoked'));

-- 기존 수락된 초대 백필
UPDATE public.invitations SET status = 'accepted' WHERE accepted_at IS NOT NULL;

-- accept_invitation RPC 업데이트: revoked 초대 거부
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
  _project record;
  _name text;
BEGIN
  _uid := auth.uid();
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 초대 조회 (FOR UPDATE로 race condition 방지)
  SELECT * INTO _invite FROM public.invitations
  WHERE token = _token AND accepted_at IS NULL
  FOR UPDATE;

  IF _invite IS NULL THEN
    RAISE EXCEPTION 'Invitation not found or already accepted';
  END IF;

  IF _invite.status = 'revoked' THEN
    RAISE EXCEPTION 'Invitation revoked';
  END IF;

  IF _invite.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation expired';
  END IF;

  -- 이메일 검증
  SELECT email INTO _user_email FROM auth.users WHERE id = _uid;
  IF _user_email != _invite.email THEN
    RAISE EXCEPTION 'Email mismatch: invitation was sent to a different email';
  END IF;

  -- org_member 생성 (이미 존재하면 무시)
  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (_invite.org_id, _uid, COALESCE(_invite.role, 'member'))
  ON CONFLICT DO NOTHING;

  -- team_member 생성: project_id가 지정되었으면 해당 프로젝트, 아니면 첫 프로젝트
  IF _invite.project_id IS NOT NULL THEN
    SELECT id INTO _project FROM public.projects WHERE id = _invite.project_id;
  ELSE
    SELECT id INTO _project FROM public.projects
    WHERE org_id = _invite.org_id LIMIT 1;
  END IF;

  IF _project IS NOT NULL THEN
    _name := COALESCE(
      (SELECT raw_user_meta_data->>'name' FROM auth.users WHERE id = _uid),
      (SELECT raw_user_meta_data->>'full_name' FROM auth.users WHERE id = _uid),
      _user_email,
      'Unknown'
    );
    INSERT INTO public.team_members (org_id, project_id, type, user_id, name, role)
    VALUES (_invite.org_id, _project.id, 'human', _uid, _name, 'member')
    ON CONFLICT (project_id, user_id) WHERE type = 'human' AND user_id IS NOT NULL
    DO NOTHING;
  END IF;

  -- 초대 수락 표시
  UPDATE public.invitations SET accepted_at = now(), status = 'accepted' WHERE id = _invite.id;

  RETURN jsonb_build_object(
    'ok', true,
    'org_id', _invite.org_id,
    'project_id', _invite.project_id
  );
END;
$$;
