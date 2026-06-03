"""E-MEMBER-SSOT AC3-1b AC3: agent_api_keys.member_id → members(id) FK 재추가.

AC3-1(0076)에서 member_id를 추가·dual-write 했으나, NOT VALID FK라도 **신규 INSERT는 검증**(트랩#7/8)
→ 신규 agent가 members 부재 시 api_key INSERT 위반 500(생명선)이라 FK를 제거했다(QA H1). AC3-1b AC1
(신규 agent anchor write-sync)이 members 행을 api_key 생성 전 선행 보장하므로 이제 FK 재추가 안전.

- FK NOT VALID: 기존 행 검증은 skip(신규 INSERT만 검증 — AC1로 referent 선행).
- VALIDATE는 **가드**: members 부재 referent를 가진 기존 행이 0건일 때만(있으면 NOT VALID 유지 +
  RAISE NOTICE — migrate 하드페일 방지, 머지-migrate 인시던트 교훈). 잔여 시 AC2 감사·보정 후 재VALIDATE.
- ondelete SET NULL: member_id는 nullable 미러 — 실삭제는 team_member_id FK(CASCADE)가 처리.

Revision ID: 0080
Revises: 0079
Create Date: 2026-06-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0080"
down_revision = "0079"
branch_labels = None
depends_on = None

_FK = "fk_agent_api_keys_member_id_members"


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "agent_api_keys" not in insp.get_table_names():
        return
    existing = {fk.get("name") for fk in insp.get_foreign_keys("agent_api_keys")}
    if _FK not in existing:
        op.execute(
            f"ALTER TABLE agent_api_keys ADD CONSTRAINT {_FK} "
            f"FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL NOT VALID"
        )
    # 가드된 VALIDATE: members 부재 referent 0건일 때만
    op.execute(
        f"""
        DO $$
        DECLARE bad int;
        BEGIN
            SELECT count(*) INTO bad FROM agent_api_keys ak
            WHERE ak.member_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = ak.member_id);
            IF bad = 0 THEN
                ALTER TABLE agent_api_keys VALIDATE CONSTRAINT {_FK};
            ELSE
                RAISE NOTICE 'agent_api_keys.member_id FK NOT VALID 유지: members 부재 row % 건 — AC2 감사·보정 후 재VALIDATE 필요', bad;
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "agent_api_keys" not in insp.get_table_names():
        return
    existing = {fk.get("name") for fk in insp.get_foreign_keys("agent_api_keys")}
    if _FK in existing:
        op.drop_constraint(_FK, "agent_api_keys", type_="foreignkey")
