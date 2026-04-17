-- SID:360 — 초대 플로우

CREATE TABLE IF NOT EXISTS public.invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email       text NOT NULL,
  token       text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  role        text NOT NULL DEFAULT 'member',
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  invited_by  uuid NOT NULL REFERENCES public.team_members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invitations IS '조직 초대';

CREATE INDEX idx_invitations_org ON public.invitations(org_id);
CREATE INDEX idx_invitations_token ON public.invitations(token);
CREATE INDEX idx_invitations_email ON public.invitations(email);

-- RLS
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invitations_select_own_org" ON public.invitations FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "invitations_insert_admin" ON public.invitations FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "invitations_update_admin" ON public.invitations FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- team_members 중복 방지 partial unique index (human + user_id + project_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_human_unique
  ON public.team_members (project_id, user_id)
  WHERE type = 'human' AND user_id IS NOT NULL;

-- 초대 수락 RPC (SECURITY DEFINER — RLS 우회)
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

  IF _invite.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation expired';
  END IF;

  -- 이메일 검증
  SELECT email INTO _user_email FROM auth.users WHERE id = _uid;
  IF _user_email != _invite.email THEN
    RAISE EXCEPTION 'Email mismatch: invitation was sent to a different email';
  END IF;

  -- org_member 생성 (중복 체크)
  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (_invite.org_id, _uid, COALESCE(_invite.role, 'member'))
  ON CONFLICT DO NOTHING;

  -- team_member 생성 (첫 프로젝트)
  SELECT id INTO _project FROM public.projects
  WHERE org_id = _invite.org_id LIMIT 1;

  IF _project IS NOT NULL THEN
    _name := COALESCE(
      (SELECT raw_user_meta_data->>'name' FROM auth.users WHERE id = _uid),
      (SELECT raw_user_meta_data->>'full_name' FROM auth.users WHERE id = _uid),
      _user_email,
      'Unknown'
    );
    -- partial unique index (project_id, user_id WHERE type='human') 로 concurrent 중복 방지
    INSERT INTO public.team_members (org_id, project_id, type, user_id, name, role)
    VALUES (_invite.org_id, _project.id, 'human', _uid, _name, 'member')
    ON CONFLICT (project_id, user_id) WHERE type = 'human' AND user_id IS NOT NULL
    DO NOTHING;
  END IF;

  -- 초대 수락 표시
  UPDATE public.invitations SET accepted_at = now() WHERE id = _invite.id;

  RETURN jsonb_build_object('ok', true, 'org_id', _invite.org_id);
END;
$$;
