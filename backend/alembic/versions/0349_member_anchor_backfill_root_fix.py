"""story #3635(BE·결함 클래스 근본·prod, 페드루 PO 確定 2026-09-07) — 휴먼 org_member의
members 앵커 부재를 뿌리에서 닫는다.

migration 0075의 `members.id == org_members.id` 백필 불변식은 그 마이그 시점 한정이었다
— 이후 org_member 생성 경로(특히 `org_members.py:154` 관리자 직접 추가, story #3635
그라운딩 확認)가 `ensure_human_member`를 안 불러 앵커가 안 생기는 org_member가 계속
쌓였다(dev PO Test Org owner가 그 실물). #3627/#3629/#3634가 자리별로 막았지만
25곳 넘게 흩어진 `type == "human"` 소비처를 전부 세는 대신, 이 마이그가 0075와 완전히
같은 SELECT(활성 org_member ∖ members)를 다시 돌려 앵커를 전수 채운다 — additive·
idempotent(ON CONFLICT DO NOTHING)라 재실행해도 안전, `OrgMemberRepository.create()`가
이제 `ensure_human_member`를 호출해도(이 PR의 코드 변경) 이 백필과 중복 INSERT 시도가
0건 사고 없이 겹친다."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0349"
down_revision = "0348"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # 0075:116-124와 완전히 동형(그라운딩 재사용, 새 백필 규칙 발명 0) — 활성 org_member 중
    # members 행이 없는 것만 채운다(ON CONFLICT (id) DO NOTHING이 이미 있는 행은 건너뜀).
    result = conn.execute(
        sa.text(
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
    )
    # story #3635 AC1 — dev/prod 각각 "몇 건이었나"가 값이다(마이그 로그로 남긴다).
    print(f"[story #3635] members 앵커 백필 — {result.rowcount}건 신규 INSERT")


def downgrade() -> None:
    # 가역이 아니다(G5류) — 이 마이그가 채운 행이 0075 원 백필 행과 구분 불가(같은 규칙,
    # 같은 id 공간)이고, 이미 다른 경로(#3627/#3629/#3634/ensure_human_member 호출부)가
    # 이 앵커 존재를 전제로 동작할 수 있어 삭제가 더 위험하다. 0075 downgrade도 앵커
    # 테이블 자체를 안 지운다(메타데이터-only 가역) — 그 관례 그대로 no-op.
    pass
