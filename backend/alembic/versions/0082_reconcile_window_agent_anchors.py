"""E-MEMBER-SSOT AC3-1b AC2 보정: window agent anchor 재조정(members + agent_project_profiles).

AC2 감사(in-VPC): cut-on 위반 active api_key 중 1건(a52b4ccd, agent active=True·members 부재) = 실 회귀
+ 0080 FK VALIDATE 블로커. 원인: **0075 agent 백필 ↔ AC3-1b write-sync(코드) 배포 사이 window에 생성된
agent** — 0075엔 아직 없었고 write-sync 배포 전이라 members/profile 미생성. (나머지 5건은 inactive agent
= legacy도 is_active 요구로 401 = 무회귀.)

해소: 0075 agent 백필 로직을 idempotent 재실행해 members 없는 agent team_member를 모두 재조정. write-sync
배포로 window는 닫혔으므로 신규 agent는 정상; 이 마이그는 과거 window agent를 소급 보정한다.

- members(id=tm.id·type='agent'·owner=생성휴먼·런타임 미러) ON CONFLICT (id) DO NOTHING.
- agent_project_profiles(member=tm.id) ON CONFLICT (project_id, member_id) DO NOTHING.
- 보정 후 0080 FK 가드 VALIDATE: members 부재 referent 0건이면 VALIDATE(아니면 NOT VALID 유지+NOTICE).

orphan-safe(트랙#4): organizations JOIN으로 orphan org 스킵, owner는 members 실재 시만(LEFT JOIN). 추가형·가역.

Revision ID: 0082
Revises: 0081
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0082"
down_revision = "0081"
branch_labels = None
depends_on = None

_FK = "fk_agent_api_keys_member_id_members"


def upgrade() -> None:
    # 1. members 재조정 — 0075 §3 agent 백필 동형(idempotent)
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
    # 2. agent_project_profiles 재조정 — 0075 §6 동형(idempotent)
    op.execute(
        """
        INSERT INTO agent_project_profiles
            (id, member_id, project_id, agent_config, webhook_url, agent_role, fakechat_port, last_seen_at, active_story_id, agent_status, created_at, updated_at)
        SELECT gen_random_uuid(), tm.id, tm.project_id, tm.agent_config, tm.webhook_url, tm.agent_role,
               tm.fakechat_port, tm.last_seen_at, tm.active_story_id, tm.agent_status, tm.created_at, now()
        FROM team_members tm
        WHERE tm.type = 'agent'
          AND EXISTS (SELECT 1 FROM members m WHERE m.id = tm.id)
        ON CONFLICT (project_id, member_id) DO NOTHING
        """
    )
    # 3. 0080 FK 가드 VALIDATE — 보정 후 members 부재 referent 0건이면 검증(아니면 NOT VALID 유지)
    op.execute(
        f"""
        DO $$
        DECLARE bad int;
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{_FK}' AND NOT convalidated) THEN
                SELECT count(*) INTO bad FROM agent_api_keys ak
                WHERE ak.member_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = ak.member_id);
                IF bad = 0 THEN
                    ALTER TABLE agent_api_keys VALIDATE CONSTRAINT {_FK};
                ELSE
                    RAISE NOTICE 'agent_api_keys.member_id FK NOT VALID 유지: members 부재 row % 건 (window 보정 후에도 잔여 — 점검 필요)', bad;
                END IF;
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    # 일방향 재조정 백필(0075 동형) — 역삭제는 정상 0075 백필분과 구분 불가라 위험. no-op(0075 정책).
    pass
