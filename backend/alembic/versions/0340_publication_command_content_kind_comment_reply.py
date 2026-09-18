"""story #3516 조각② 라이브 핫픽스(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) —
`publication_commands.content_kind` CHECK(0323, "channel_post"|"site_post")에
"comment_reply"가 빠져 있었다. 댓글 답변 게이트 승인(`gate_service.py::
_maybe_create_scheduled_publication_command`의 comment_reply 분기)이
`create_or_get_publication_command(..., content_kind="comment_reply")`를 부르는
순간 이 CHECK 위반으로 IntegrityError → 500(dev 배포32 실사고, 2026-09-05
16:19~16:20Z 재현 확認, admin 세션·2회 연속 재현).

**뿌리 원인**: 0323이 CHECK를 raw SQL(`op.create_check_constraint`)로만 걸고
`PublicationCommand` 모델의 `__table_args__`엔 미러하지 않았다 — 로컬 테스트는
전부 `Base.metadata.create_all()`로 스키마를 세우는데(마이그 안 거침), 그 경로는
모델에 없는 제약을 절대 못 본다. 그래서 "content_kind='comment_reply'" 회귀
테스트가 로컬에서 전부 그린으로 통과했으면서 실 마이그된 dev DB에서만 죽었다
(create_all 후시경 결여 — reference_create_all_no_pgvector류 갭과 같은 클래스,
다만 이번엔 pgvector가 아니라 CHECK 제약). 이 마이그가 DB CHECK를 갱신하고,
모델 쪽 `CheckConstraint`(같은 이름 `ck_publication_commands_content_kind`)를
같이 추가해 두 재료가 다시 어긋나지 않게 한다(마이그=정본, 모델=미러 — 이름을
맞춰 둬 나중에 grep 한 번으로 짝이 맞는지 확인 가능).
"""
from __future__ import annotations

from alembic import op

revision = "0340"
down_revision = "0339"
branch_labels = None
depends_on = None

_OLD_CHECK_SQL = "content_kind IN ('channel_post', 'site_post')"
_NEW_CHECK_SQL = "content_kind IN ('channel_post', 'site_post', 'comment_reply')"


def upgrade() -> None:
    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.create_check_constraint("ck_publication_commands_content_kind", "publication_commands", _NEW_CHECK_SQL)


def downgrade() -> None:
    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.create_check_constraint("ck_publication_commands_content_kind", "publication_commands", _OLD_CHECK_SQL)
