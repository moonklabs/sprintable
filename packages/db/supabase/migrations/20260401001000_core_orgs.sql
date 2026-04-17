-- E-002:S1 — Core tables: organizations, org_members, projects + RLS

-- ============================================================
-- 1. organizations
-- ============================================================
CREATE TABLE IF NOT EXISTS public.organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  plan        text NOT NULL DEFAULT 'free',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.organizations IS '조직 (테넌트)';

-- ============================================================
-- 2. org_members
-- ============================================================
CREATE TABLE IF NOT EXISTS public.org_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

COMMENT ON TABLE public.org_members IS '조직 멤버 (사용자-조직 매핑)';

CREATE INDEX idx_org_members_org_id ON public.org_members(org_id);
CREATE INDEX idx_org_members_user_id ON public.org_members(user_id);

-- ============================================================
-- 3. projects
-- ============================================================
CREATE TABLE IF NOT EXISTS public.projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.projects IS '프로젝트';

CREATE INDEX idx_projects_org_id ON public.projects(org_id);

-- ============================================================
-- 4. Helper function — RLS 자기참조 방지 (security definer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_org_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT org_id FROM public.org_members WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.get_user_admin_org_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT org_id FROM public.org_members
  WHERE user_id = auth.uid() AND role IN ('owner', 'admin');
$$;

-- ============================================================
-- 5. RLS — 테넌트 격리 (helper function 사용)
-- ============================================================

-- organizations
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_select_own"
  ON public.organizations FOR SELECT
  USING (id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "org_insert_authenticated"
  ON public.organizations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "org_update_admin"
  ON public.organizations FOR UPDATE
  USING (id IN (SELECT public.get_user_admin_org_ids()));

-- org_members
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_select_same_org"
  ON public.org_members FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "members_insert_admin"
  ON public.org_members FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "members_update_admin"
  ON public.org_members FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "members_delete_admin"
  ON public.org_members FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- projects
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "projects_select_own_org"
  ON public.projects FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "projects_insert_admin"
  ON public.projects FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "projects_update_admin"
  ON public.projects FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "projects_delete_admin"
  ON public.projects FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- 6. Organization bootstrap — 생성 시 owner 자동 등록
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_organization()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid;
BEGIN
  _uid := auth.uid();
  -- null guard: seed/migration 등 auth 컨텍스트 없는 경우 스킵
  IF _uid IS NOT NULL THEN
    INSERT INTO public.org_members (org_id, user_id, role)
    VALUES (NEW.id, _uid, 'owner');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_org_bootstrap_owner
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_organization();

-- ============================================================
-- 7. updated_at 자동 갱신 트리거
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
