"""story #3510(BE·결함·소형, 페드루 PO 確定 2026-09-05) — `members.org_role` ↔
`org_members.role` 드리프트 백필.

`PATCH /api/v2/org-members/{id}`(role 변경)이 `org_members.role`만 갱신하고 앵커
`members.org_role`을 안 옮겨, `member_ssot_resolver_shadow=true`(dev)의
`_resolve_member_anchor`가 옛 역할로 게이트를 판정했다(`app/repositories/org_member.py::
OrgMemberRepository.update`가 이 스토리에서 같은 트랜잭션 동기화를 얻었다 — 이 마이그는
그 fix *이전*에 이미 벌어진 드리프트 행만 1회 정정). 방향은 `org_members`를 정본으로
`members`에 덮어쓴다 — 지금 기본 플래그(off)의 레거시 리졸버가 `org_members.role`을
읽고 있어 그쪽이 "현재 유효한 값"이고, 드리프트도 PATCH가 `org_members`만 쓰다가
생겼기 때문(반대 방향으로 덮으면 최근 역할 변경을 되돌리는 꼴).

되돌릴 수 없음(downgrade는 no-op) — 백필 이전 `members.org_role` 값은 기록되지 않아
복원할 근거가 없다(추측으로 지어내지 않는다, no-fiction 원칙). 영향 행 수는 드물 것으로
예상(2026-09-05 dev 실측 13명 중 1명)이라 단일 UPDATE로 충분, 배치 불요.
"""
from __future__ import annotations

from alembic import op

revision = "0335"
down_revision = "0334"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE members
        SET org_role = org_members.role
        FROM org_members
        WHERE members.id = org_members.id
          AND members.type = 'human'
          AND org_members.deleted_at IS NULL
          AND members.org_role IS DISTINCT FROM org_members.role
        """
    )


def downgrade() -> None:
    pass
