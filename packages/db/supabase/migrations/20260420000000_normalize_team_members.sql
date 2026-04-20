-- E-AUTH-PERM: members (org-level) + project_permissions (junction)
-- team_members 테이블 정규화 — 같은 사람이 프로젝트마다 중복 레코드 생성되는 설계 결함 수정

-- ============================================================
-- 1. members — org 레벨 1건으로 통합
-- ============================================================
CREATE TABLE IF NOT EXISTS public.members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  type          text NOT NULL CHECK (type IN ('human', 'agent')),
  avatar_url    text,
  agent_config  jsonb,
  webhook_url   text,
  is_active     boolean NOT NULL DEFAULT true,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT members_human_unique UNIQUE (user_id, org_id),
  CONSTRAINT chk_members_human_user_id CHECK (type != 'human' OR user_id IS NOT NULL),
  CONSTRAINT chk_members_agent_config CHECK (type != 'agent' OR agent_config IS NOT NULL)
);

COMMENT ON TABLE public.members IS 'org 레벨 멤버 (사람/에이전트 통합, 프로젝트 중립)';

CREATE INDEX idx_members_org_id ON public.members(org_id);
CREATE INDEX idx_members_user_id ON public.members(user_id) WHERE user_id IS NOT NULL;

-- ============================================================
-- 2. project_permissions — member × project junction
-- ============================================================
CREATE TABLE IF NOT EXISTS public.project_permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  permissions jsonb NOT NULL DEFAULT '{"read": true, "write": true, "manage": false}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (member_id, project_id)
);

COMMENT ON TABLE public.project_permissions IS 'member와 project 간 권한 junction 테이블';

CREATE INDEX idx_project_permissions_member_id ON public.project_permissions(member_id);
CREATE INDEX idx_project_permissions_project_id ON public.project_permissions(project_id);

-- ============================================================
-- 3. 기존 team_members 데이터 마이그레이션
-- ============================================================

-- 3a. human 멤버: (user_id, org_id) 기준 중복 제거 — 가장 먼저 생성된 레코드 기준
INSERT INTO public.members (org_id, user_id, name, type, avatar_url, is_active, deleted_at, created_at, updated_at)
SELECT DISTINCT ON (user_id, org_id)
  org_id, user_id, name, 'human', avatar_url, is_active, deleted_at, created_at, updated_at
FROM public.team_members
WHERE type = 'human'
ORDER BY user_id, org_id, created_at ASC;

-- 3b. agent 멤버: 중복 없이 그대로 이관
INSERT INTO public.members (org_id, user_id, name, type, avatar_url, agent_config, webhook_url, is_active, deleted_at, created_at, updated_at)
SELECT org_id, NULL, name, 'agent', avatar_url, agent_config, webhook_url, is_active, deleted_at, created_at, updated_at
FROM public.team_members
WHERE type = 'agent';

-- ============================================================
-- 4. team_members에 member_id FK 추가
-- ============================================================
ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES public.members(id) ON DELETE SET NULL;

CREATE INDEX idx_team_members_member_id ON public.team_members(member_id) WHERE member_id IS NOT NULL;

-- 4a. human 멤버: (user_id, org_id)로 매핑
UPDATE public.team_members tm
SET member_id = m.id
FROM public.members m
WHERE tm.type = 'human'
  AND tm.user_id IS NOT NULL
  AND tm.user_id = m.user_id
  AND tm.org_id = m.org_id;

-- 4b. agent 멤버: (name, org_id, type)로 매핑
UPDATE public.team_members tm
SET member_id = m.id
FROM public.members m
WHERE tm.type = 'agent'
  AND tm.name = m.name
  AND tm.org_id = m.org_id
  AND m.type = 'agent';

-- ============================================================
-- 5. project_permissions 초기 데이터: team_members에서 생성
-- ============================================================
INSERT INTO public.project_permissions (member_id, project_id, role, created_at, updated_at)
SELECT DISTINCT ON (member_id, project_id)
  member_id, project_id, role, created_at, updated_at
FROM public.team_members
WHERE member_id IS NOT NULL
  AND deleted_at IS NULL
ORDER BY member_id, project_id, created_at ASC;

-- ============================================================
-- 6. RLS — members
-- ============================================================
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_select_own_org"
  ON public.members FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "members_insert_admin"
  ON public.members FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "members_update_admin"
  ON public.members FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "members_delete_admin"
  ON public.members FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- 7. RLS — project_permissions
-- ============================================================
ALTER TABLE public.project_permissions ENABLE ROW LEVEL SECURITY;

-- 같은 프로젝트 멤버는 권한 목록 조회 가능
CREATE POLICY "project_permissions_select"
  ON public.project_permissions FOR SELECT
  USING (
    project_id IN (
      SELECT tm.project_id FROM public.team_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.is_active = true
        AND tm.deleted_at IS NULL
    )
  );

-- org admin은 project_permissions 전체 관리 가능
CREATE POLICY "project_permissions_manage_admin"
  ON public.project_permissions FOR ALL
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      WHERE p.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT p.id FROM public.projects p
      WHERE p.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );

-- ============================================================
-- 8. updated_at 트리거
-- ============================================================
CREATE TRIGGER trg_members_updated_at
  BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trg_project_permissions_updated_at
  BEFORE UPDATE ON public.project_permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
