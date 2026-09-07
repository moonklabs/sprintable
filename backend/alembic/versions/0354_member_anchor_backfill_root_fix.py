"""story #3635(BE·결함 클래스 근본·prod, 페드루 PO 確定 2026-09-07) — 휴먼 org_member의
members 앵커 부재를 뿌리에서 닫는다.

migration 0075의 `members.id == org_members.id` 백필 불변식은 그 마이그 시점 한정이었다
— 이후 org_member 생성 경로(특히 `org_members.py:154` 관리자 직접 추가, story #3635
그라운딩 확認)가 `ensure_human_member`를 안 불러 앵커가 안 생기는 org_member가 계속
쌓였다(dev PO Test Org owner가 그 실물). #3627/#3629/#3634가 자리별로 막았지만
25곳 넘게 흩어진 `type == "human"` 소비처를 전부 세는 대신, 이 마이그가 0075와 완전히
같은 SELECT(활성 org_member ∖ members)를 다시 돌려 앵커를 전수 채운다 — additive·
idempotent(대상 없는 ON CONFLICT DO NOTHING — PK·uq_members_active_human 어느 쪽이
막아도 조용히 스킵, story #3987 CI 실사고로 대상 지정에서 정정)라 재실행해도 안전,
`OrgMemberRepository.create()`가
이제 `ensure_human_member`를 호출해도(이 PR의 코드 변경) 이 백필과 중복 INSERT 시도가
0건 사고 없이 겹친다.

prod 승격(promote/main-20260907-3629-3635, 결재 2f9e82fa) — down_revision을 develop의
"0353"에서 main head "0295"로 재작성했다(develop 전용 마이그 0296~0353은 이 승격에
안 실린다 — 스키마 따라잡기 0, revision id 자체는 develop과 대조용으로 "0354" 그대로
유지). 0283/0289/0292 선례와 같은 방식."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0354"
down_revision = "0295"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # 0075:116-124와 완전히 동형(그라운딩 재사용, 새 백필 규칙 발명 0) — 활성 org_member 중
    # members 행이 없는 것만 채운다. story #3987 CI 실사고(2026-09-07, run 34121108303) —
    # 대상 지정 `ON CONFLICT (id) DO NOTHING`은 PK 충돌만 삼킨다. 같은 (org_id, user_id)에
    # id가 다른 active human member 행이 이미 있으면(uq_members_active_human 부분 유니크
    # 인덱스) 그 자리는 PK 충돌이 아니라서 그대로 UniqueViolation으로 죽는다 — "이미
    # 앵커가 있다"는 이 백필의 목표가 이미 달성된 상태인데도 크래시하는 건 과잉이다.
    # 대상 없는 bare DO NOTHING으로 바꿔 이 테이블의 어떤 유니크/배제 제약 충돌이든
    # (지금은 PK·uq_members_active_human 둘) 조용히 건너뛴다 — "이미 있으면 스킵"이라는
    # 이 백필의 의도 자체가 원래 대상 무관이었다.
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
            ON CONFLICT DO NOTHING
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
