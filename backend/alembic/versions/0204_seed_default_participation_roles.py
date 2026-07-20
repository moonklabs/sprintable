"""SID 265f5b13/#2049 P0: 기본 참여 역할 세트 백필 — merge 게이트가 신규/기존 조직 전부에서
원천적으로 안 도는 결함 수정(AC2).

Revision ID: 0204
Revises: 0203
Create Date: 2026-07-20

발견 경위: #2047 AC5 라이브 검증 중 dev 테스트 조직 4곳을 조회했더니 `is_default=True` 참여
역할을 가진 조직이 뭉클랩(`54bac162-...`) 하나뿐이었다. `merge_verdict_gate` →
`resolve_implementation_participation`(app/services/verdict_capture.py:55-63)은
`is_default=True` 역할부터 찾고 없으면 None을 반환 — 호출자는 그대로 skip해 **게이트가 아예
생성되지 않는다.** 즉 신규 고객 조직은 물론, 이미 만들어진 dev 테스트 조직 대부분이 이 상태였다.

뭉클랩이 실측으로 보유한 5종 세트(implementation/po/qa/design/devops, 전부 2026-05-31 동시
생성)를 그대로 재사용한다 — app/repositories/organization.py의 DEFAULT_PARTICIPATION_ROLES와
byte-identical(AC1이 신규 조직에 심는 것과 같은 세트를 기존 조직에도 맞춘다). `hypothesis_owner`
(2026-06-13 별도 경로로 추가)는 이 "기본 세트"에서 제외 — 이미 0119가 전 org에 보장한다.

멱등: 0063이 만든 uq_participation_role_org_key(org_id,key)로 ON CONFLICT DO NOTHING —
**이미 해당 key를 가진 조직(뭉클랩 등)은 자연히 건드리지 않는다**(AC2 "멀쩡한 것을 손대지
않는다" 요구를 스키마 제약으로 강제). 0119(hypothesis_owner seed)와 동일 패턴.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0204"
down_revision = "0203"
branch_labels = None
depends_on = None

# app/repositories/organization.py::DEFAULT_PARTICIPATION_ROLES와 byte-identical 유지 —
# 신규 조직(AC1)과 기존 조직 백필(AC2)이 같은 세트를 갖도록.
_DEFAULT_ROLES: tuple[tuple[str, str, bool], ...] = (
    ("implementation", "구현", True),
    ("po", "PO", False),
    ("qa", "QA", False),
    ("design", "디자인", False),
    ("devops", "DevOps", False),
)


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "participation_role" not in insp.get_table_names() or "organizations" not in insp.get_table_names():
        return  # 테이블 부재(이론상 없음) — no-op.

    for key, label, is_default in _DEFAULT_ROLES:
        op.execute(
            sa.text(
                "INSERT INTO participation_role (id, org_id, key, label, is_default, created_at) "
                "SELECT gen_random_uuid(), o.id, :key, :label, :is_default, now() FROM organizations o "
                "ON CONFLICT (org_id, key) DO NOTHING"
            ).bindparams(key=key, label=label, is_default=is_default)
        )


def downgrade() -> None:
    # 재백필은 순수 데이터 정합성 수정(#2039/0203 선례와 동형) — 되돌리면 다시 게이트가 원천적으로
    # 안 도는 상태로 회귀하므로 downgrade는 no-op("고쳐진 상태 유지"가 유일하게 안전한 downgrade).
    pass
