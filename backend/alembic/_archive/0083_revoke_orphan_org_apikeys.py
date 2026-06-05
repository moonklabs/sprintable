"""E-MEMBER-SSOT AC3-1b AC2 마무리: orphan-org dead agent api_key revoke + FK VALIDATE.

AC2 재감사(post-0082): a52b4ccd 1건 여전 members 부재 — **org_id가 organizations에 없는 orphan-org
agent**(0075·0082 모두 INNER JOIN organizations로 의도 스킵, members.org_id NOT NULL FK라 생성 불가).
실 동작 불가한 dead agent이므로 그 api_key를 revoke. (5 inactive 키는 member_exists=True라 무영향.)

⚠️ revoke(revoked_at)만으론 FK VALIDATE가 안 됨 — VALIDATE는 revoked 무관 **전 행**의 member_id를
검사하므로 orphan member_id가 남으면 위반. 따라서 **member_id=NULL도 함께**(미러 컬럼, FK는 NULL 허용)
→ bad=0 → 0080/0082 FK 가드 VALIDATE 통과 + flag-on 안전.

idempotent: 재실행 시 이미 revoke+NULL된 행은 member_id NULL이라 NOT EXISTS 매치 안 됨 → no-op.
범위 안전: post-0082라 valid-org agent는 members 백필됨 → members 부재 = orphan-org dead만 매치(legit
agent 무영향). 데이터 보정·가역(downgrade no-op, revoke/NULL 복원 불가·불요).

Revision ID: 0083
Revises: 0082
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0083"
down_revision = "0082"
branch_labels = None
depends_on = None

_FK = "fk_agent_api_keys_member_id_members"


def upgrade() -> None:
    op.execute(
        f"""
        DO $$
        DECLARE revoked int; bad int;
        BEGIN
            -- 1. orphan-org dead agent 키 revoke + member_id NULL(FK 위반 정리)
            UPDATE agent_api_keys SET revoked_at = now(), member_id = NULL
            WHERE revoked_at IS NULL
              AND member_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = agent_api_keys.member_id);
            GET DIAGNOSTICS revoked = ROW_COUNT;
            RAISE NOTICE 'orphan-org dead agent api_key revoke + member_id NULL: % 건', revoked;

            -- 2. 가드 VALIDATE — 이제 members 부재 referent 0건이면 검증
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{_FK}' AND NOT convalidated) THEN
                SELECT count(*) INTO bad FROM agent_api_keys ak
                WHERE ak.member_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = ak.member_id);
                IF bad = 0 THEN
                    ALTER TABLE agent_api_keys VALIDATE CONSTRAINT {_FK};
                    RAISE NOTICE 'agent_api_keys.member_id FK validated (bad=0)';
                ELSE
                    RAISE NOTICE 'agent_api_keys.member_id FK NOT VALID 유지 (bad=% 잔여 — 점검 필요)', bad;
                END IF;
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    # 데이터 보정(revoke + member_id NULL) — 역복원 불가·불요(dead-org agent). no-op.
    pass
