-- E-PLATFORM-SECURE S4: organizations soft delete + RLS 업데이트

-- 1. deleted_at 컬럼 추가
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 2. org_select_own RLS 정책에 deleted_at IS NULL 조건 추가
DROP POLICY IF EXISTS "org_select_own" ON public.organizations;

CREATE POLICY "org_select_own"
  ON public.organizations FOR SELECT
  USING (id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
