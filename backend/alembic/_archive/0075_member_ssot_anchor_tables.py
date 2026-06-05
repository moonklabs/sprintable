"""E-MEMBER-SSOT AC2-1: 신원 앵커 테이블 additive 마이그 (코드 cutover 없음).

blueprint-member-ssot-anchor §4 Phase 1-2. 공유 dev/prod DB — 모든 DDL idempotent
가드(IF NOT EXISTS / IF EXISTS) + 백필 ID 보존 + 메타데이터-only 가역 롤백.

토대:
- members(통합 신원), member_identity_aliases(레거시 id 매핑), agent_project_profiles(에이전트 per-project)
- project_access에 member_id/role/color/can_manage_members/access_source/inherited_from_member_id 추가

백필(ID 보존):
- 휴먼 members.id = org_members.id (Phase0 ID 보존)
- 에이전트 members.id = team_members.id (API키/event/participant ID 보존) — team_member별 1:1
- 에이전트 owner = team_members.created_by → 동org 휴먼 member
- 휴먼 team_member마다 alias / project_access.member_id=org_member_id / 에이전트 direct placement + agent_project_profiles 시드

Revision ID: 0075
Revises: 0074
Create Date: 2026-06-03
"""
from __future__ import annotations

from alembic import op

revision = "0075"
down_revision = "0074"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. 앵커 테이블 (idempotent) ──────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS members (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            type text NOT NULL CHECK (type IN ('human', 'agent')),
            user_id uuid REFERENCES users(id) ON DELETE SET NULL,
            owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
            name text NOT NULL,
            avatar_url text,
            org_role text,
            is_active boolean NOT NULL DEFAULT true,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            deleted_at timestamptz
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS member_identity_aliases (
            alias_id uuid PRIMARY KEY,
            member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            org_id uuid NOT NULL,
            project_id uuid,
            alias_source text NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_project_profiles (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            agent_config jsonb,
            webhook_url text,
            agent_role text,
            fakechat_port integer,
            last_seen_at timestamptz,
            active_story_id uuid REFERENCES stories(id) ON DELETE SET NULL,
            agent_status text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_agent_project_profiles_proj_member UNIQUE (project_id, member_id)
        )
        """
    )

    # 인덱스 (members / aliases / agent_project_profiles)
    op.execute("CREATE INDEX IF NOT EXISTS ix_members_org_id ON members (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_members_user_id ON members (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_members_owner_member_id ON members (owner_member_id)")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_active_human "
        "ON members (org_id, user_id) WHERE type = 'human' AND deleted_at IS NULL"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_member_aliases_member ON member_identity_aliases (member_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_member_aliases_org ON member_identity_aliases (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_agent_profiles_member ON agent_project_profiles (member_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_agent_profiles_project ON agent_project_profiles (project_id)")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_profiles_proj_port "
        "ON agent_project_profiles (project_id, fakechat_port) WHERE fakechat_port IS NOT NULL"
    )

    # ── 2. project_access placement 컬럼 (additive) ──────────────────────────
    op.execute("ALTER TABLE project_access ADD COLUMN IF NOT EXISTS member_id uuid")
    op.execute("ALTER TABLE project_access ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'")
    op.execute("ALTER TABLE project_access ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#3385f8'")
    op.execute("ALTER TABLE project_access ADD COLUMN IF NOT EXISTS can_manage_members boolean NOT NULL DEFAULT false")
    op.execute("ALTER TABLE project_access ADD COLUMN IF NOT EXISTS access_source text NOT NULL DEFAULT 'direct'")
    op.execute("ALTER TABLE project_access ADD COLUMN IF NOT EXISTS inherited_from_member_id uuid")
    # 에이전트 direct placement(org_member 없음)를 수용하기 위해 org_member_id NOT NULL 완화
    op.execute("ALTER TABLE project_access ALTER COLUMN org_member_id DROP NOT NULL")
    op.execute("ALTER TABLE project_access ALTER COLUMN org_member_id DROP DEFAULT")

    # ── 3. 백필: members (휴먼 먼저 — 에이전트 owner가 휴먼 member 참조) ────────
    # 휴먼: members.id = org_members.id (Phase0 ID 보존), org_role = org_members.role.
    #   ⚠️ 실 DB 데이터 정합: org_members.org_id/user_id는 FK가 없어 orphan 가능.
    #   - user_id는 u.id(LEFT JOIN 검증값) 사용 → orphan user_id면 NULL (members.user_id FK 위반 방지)
    #   - org_id는 organizations와 JOIN → orphan org_id 행은 스킵 (members.org_id NOT NULL FK 위반 방지)
    op.execute(
        """
        INSERT INTO members (id, org_id, type, user_id, owner_member_id, name, org_role, is_active, created_at, updated_at)
        SELECT om.id, om.org_id, 'human', u.id, NULL,
               COALESCE(u.display_name, u.email, om.user_id::text),
               om.role, true, om.created_at, now()
        FROM org_members om
        JOIN organizations o ON o.id = om.org_id
        LEFT JOIN users u ON u.id = om.user_id
        WHERE om.deleted_at IS NULL
        ON CONFLICT (id) DO NOTHING
        """
    )
    # 에이전트: members.id = team_members.id (1:1 ID 보존), owner = created_by 휴먼 member.
    #   org_id는 organizations JOIN으로 검증(orphan org 스킵).
    op.execute(
        """
        INSERT INTO members (id, org_id, type, user_id, owner_member_id, name, avatar_url, org_role, is_active, created_at, updated_at)
        SELECT tm.id, tm.org_id, 'agent', NULL, owner.id, tm.name, tm.avatar_url, NULL, tm.is_active, tm.created_at, now()
        FROM team_members tm
        JOIN organizations o ON o.id = tm.org_id
        LEFT JOIN org_members owner
               ON owner.org_id = tm.org_id AND owner.user_id = tm.created_by AND owner.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM members m WHERE m.id = owner.id)
        WHERE tm.type = 'agent'
        ON CONFLICT (id) DO NOTHING
        """
    )

    # ── 4. 백필: aliases (휴먼 team_member.id → 휴먼 member) ───────────────────
    op.execute(
        """
        INSERT INTO member_identity_aliases (alias_id, member_id, org_id, project_id, alias_source)
        SELECT tm.id, om.id, tm.org_id, tm.project_id, 'human_team_member'
        FROM team_members tm
        JOIN org_members om
          ON om.org_id = tm.org_id AND om.user_id = tm.user_id AND om.deleted_at IS NULL
        JOIN members m ON m.id = om.id   -- 휴먼 member가 실제 생성됐을 때만(orphan org 스킵분 제외)
        WHERE tm.type = 'human'
        ON CONFLICT (alias_id) DO NOTHING
        """
    )

    # ── 5. 백필: project_access ──────────────────────────────────────────────
    # 휴먼 기존 grant: member_id = org_member_id (휴먼 members.id = org_members.id).
    #   member가 실제 생성된 org_member만 (orphan org 스킵분은 NOT VALID FK 위반 방지 위해 제외).
    op.execute(
        """
        UPDATE project_access SET member_id = org_member_id
        WHERE member_id IS NULL AND org_member_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM members m WHERE m.id = project_access.org_member_id)
        """
    )
    # 에이전트 direct placement: team_members.type='agent' → project_access 행 신설.
    #   에이전트 member가 생성된 경우만(orphan org 스킵분 제외).
    op.execute(
        """
        INSERT INTO project_access (id, project_id, org_member_id, member_id, permission, role, color, can_manage_members, access_source, created_at)
        SELECT gen_random_uuid(), tm.project_id, NULL, tm.id, 'granted', tm.role, tm.color, tm.can_manage_members, 'direct', tm.created_at
        FROM team_members tm
        WHERE tm.type = 'agent' AND tm.is_active = true
          AND EXISTS (SELECT 1 FROM members m WHERE m.id = tm.id)
          AND NOT EXISTS (
              SELECT 1 FROM project_access pa
              WHERE pa.project_id = tm.project_id AND pa.member_id = tm.id
          )
        """
    )

    # ── 6. 백필: agent_project_profiles (에이전트 team_member 런타임/설정) ──────
    op.execute(
        """
        INSERT INTO agent_project_profiles
            (id, member_id, project_id, agent_config, webhook_url, agent_role, fakechat_port, last_seen_at, active_story_id, agent_status, created_at, updated_at)
        SELECT gen_random_uuid(), tm.id, tm.project_id, tm.agent_config, tm.webhook_url, tm.agent_role,
               tm.fakechat_port, tm.last_seen_at, tm.active_story_id, tm.agent_status, tm.created_at, now()
        FROM team_members tm
        WHERE tm.type = 'agent'
          AND EXISTS (SELECT 1 FROM members m WHERE m.id = tm.id)   -- 에이전트 member 생성분만
        ON CONFLICT (project_id, member_id) DO NOTHING
        """
    )

    # ── 7. project_access placement 유니크 + NOT VALID FK ─────────────────────
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_project_access_project_member_v2 "
        "ON project_access (project_id, member_id) WHERE member_id IS NOT NULL"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_project_access_member_id ON project_access (member_id)")
    # NOT VALID FK — 기존 행 검증 보류(후속 phase에서 VALIDATE)
    op.execute(
        """
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_access_member') THEN
                ALTER TABLE project_access
                    ADD CONSTRAINT fk_project_access_member
                    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE NOT VALID;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_access_inherited_member') THEN
                ALTER TABLE project_access
                    ADD CONSTRAINT fk_project_access_inherited_member
                    FOREIGN KEY (inherited_from_member_id) REFERENCES members(id) ON DELETE SET NULL NOT VALID;
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    """메타데이터-only 가역 — 신규 테이블 drop + project_access 신규 컬럼/제약 제거.

    org_member_id NOT NULL 복원은 백필된 에이전트 행(org_member_id NULL) 제거 후 수행.
    """
    # NOT VALID FK + 인덱스 제거
    op.execute("ALTER TABLE project_access DROP CONSTRAINT IF EXISTS fk_project_access_member")
    op.execute("ALTER TABLE project_access DROP CONSTRAINT IF EXISTS fk_project_access_inherited_member")
    op.execute("DROP INDEX IF EXISTS uq_project_access_project_member_v2")
    op.execute("DROP INDEX IF EXISTS ix_project_access_member_id")

    # 백필된 에이전트 direct placement 제거(org_member_id NULL 행)
    op.execute("DELETE FROM project_access WHERE org_member_id IS NULL AND access_source = 'direct'")

    # org_member_id NOT NULL 복원 (잔여 NULL 없을 때만)
    op.execute(
        """
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM project_access WHERE org_member_id IS NULL) THEN
                ALTER TABLE project_access ALTER COLUMN org_member_id SET NOT NULL;
            END IF;
        END $$;
        """
    )

    # project_access 신규 컬럼 제거
    for col in ("member_id", "role", "color", "can_manage_members", "access_source", "inherited_from_member_id"):
        op.execute(f"ALTER TABLE project_access DROP COLUMN IF EXISTS {col}")

    # 앵커 테이블 drop (의존 역순)
    op.execute("DROP TABLE IF EXISTS agent_project_profiles")
    op.execute("DROP TABLE IF EXISTS member_identity_aliases")
    op.execute("DROP TABLE IF EXISTS members")
