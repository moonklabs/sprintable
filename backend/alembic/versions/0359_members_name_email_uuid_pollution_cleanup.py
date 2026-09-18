"""story #3758(BE·표시명·결함 클래스 별건④ 10번째, 페드루 PO 決 2026-09-09) — members.name
email/user_id 오염 행 정리 + 컬럼 nullable 완화.

migration 0075/0354가 앵커 백필 시 `COALESCE(u.display_name, u.email, om.user_id::text)`로
채웠다 — display_name이 없던 휴먼은 members.name에 email이나 uuid 문자열이 그대로
저장됐다(member_resolver.py 5자리·#3755와 같은 email/id 폴백 클래스가 이 테이블 자체에
박혀 있던 셈). agent_anchor_sync.py(이 스토리에서 함께 고침)가 새 오염을 안 만들게
바꾼 뒤, 기존 오염 행을 정리한다 — 정확히 그 두 규칙(join으로 email 정확 일치·
user_id::text 정확 일치)에 걸리는 행만 NULL(그 밖의 값은 손 안 댐 — auth.py 가입 시
email 로컬파트를 썼던 케이스는 members.name이 아니라 users.display_name 컬럼이라
이 마이그 대상이 아니고, PO 決으로 백필 0).

name을 NULL로 되돌리려면 컬럼이 nullable이어야 한다 — DROP NOT NULL을 UPDATE보다
먼저 실행.

downgrade는 의도적 no-op이다(페드루 PO 지적 2026-09-09, 코드가 그 사실을 말로 안 적어
뒀던 것 정정) — 정리는 일방향(NULL로 뭉친 행이 원래 email이었는지 user_id::text였는지
이 시점엔 구분 불가), nullable 완화는 그대로 유지, NULL 행이 실제로 존재하는 채로는
NOT NULL을 복원할 수도 없다(그러면 downgrade 자체가 크래시). 「downgrade까지 검증」은
이 no-op이 예외 없이 도는지 확認했다는 뜻이지, 데이터/제약을 원상복구한다는 뜻이 아니다.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0359"
down_revision = "0358"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE members ALTER COLUMN name DROP NOT NULL")
    conn = op.get_bind()

    email_result = conn.execute(
        sa.text(
            """
            UPDATE members m
            SET name = NULL
            FROM users u
            WHERE m.user_id = u.id
              AND m.type = 'human'
              AND m.name = u.email
            """
        )
    )
    uuid_result = conn.execute(
        sa.text(
            """
            UPDATE members m
            SET name = NULL
            WHERE m.type = 'human'
              AND m.name = m.user_id::text
            """
        )
    )
    # story #3758 AC — dev/prod 각각 "몇 건 정리했나"가 값이다(마이그 로그로 남긴다).
    print(f"[story #3758] members.name email 오염 정리 — {email_result.rowcount}건")
    print(f"[story #3758] members.name user_id 오염 정리 — {uuid_result.rowcount}건")


def downgrade() -> None:
    # 의도적 no-op — 정리는 일방향·nullable 완화는 유지·NULL 행이 있어 NOT NULL 복원
    # 불가(가역 아님, G5류, 0354와 동일 관례). NULL로 되돌린 행이 원래 email이었는지
    # user_id::text였는지 이 시점엔 구분 불가(둘 다 NULL로 수렴)라 데이터도 못 되돌리고,
    # NOT NULL을 다시 걸면 이 마이그가 만든(또는 그 사이 정당하게 생긴) NULL 행에서
    # downgrade 자체가 크래시한다 — 메타데이터-only 가역 관례 그대로 pass.
    pass
