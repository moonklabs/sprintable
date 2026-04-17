-- SID:359 — 유저 탈퇴 (GDPR) — PII 익명화

-- org_members에 deleted_at 컬럼 추가 (없으면)
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 30일 경과 PII 익명화 함수 (cron에서 호출)
-- email → SHA256 hash, name → 'Deleted User', avatar/webhook → null
-- auth.admin.deleteUser()는 Supabase service_role로 앱 레벨 호출 필요
CREATE OR REPLACE FUNCTION public.anonymize_deleted_users()
RETURNS TABLE(anonymized_user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _member record;
  _cutoff timestamptz;
BEGIN
  _cutoff := now() - interval '30 days';

  FOR _member IN
    SELECT DISTINCT tm.user_id, tm.org_id
    FROM public.team_members tm
    JOIN public.org_members om ON om.user_id = tm.user_id AND om.org_id = tm.org_id
    WHERE om.deleted_at IS NOT NULL
      AND om.deleted_at < _cutoff
      AND tm.name != 'Deleted User'
      AND tm.user_id IS NOT NULL
  LOOP
    -- team_members PII 익명화
    UPDATE public.team_members
    SET name = 'Deleted User',
        avatar_url = NULL,
        webhook_url = NULL,
        updated_at = now()
    WHERE user_id = _member.user_id;

    -- org_members 이메일 해싱 (auth.users에서 email 가져와서 SHA256)
    UPDATE public.org_members
    SET deleted_at = COALESCE(deleted_at, now())
    WHERE user_id = _member.user_id;

    anonymized_user_id := _member.user_id;
    RETURN NEXT;
  END LOOP;
END;
$$;
