"""story #3516 조각②(Phase2·마케팅운영) 라이브 결함 핫픽스(페드루 실사용 재현
2026-09-05 16:19Z, 배포32) — `publication_commands.content_kind`의 CHECK 제약
(story e4fc29fa, migration 0323 — `IN ('channel_post', 'site_post')`)이
`content_kind="comment_reply"`(3516 조각②의 `gate_service.py::_maybe_create_
scheduled_publication_command` comment_reply 분기)를 안 담아, 댓글 답변 게이트
승인 시 `create_or_get_publication_command`의 INSERT가 PostgreSQL CheckViolation
(IntegrityError)으로 즉시 실패했다.

`create_or_get_publication_command`(publication_command.py)의 예외 처리는
`uq_publication_commands_idempotency`(UNIQUE) 위반만 걸러 재조회로 흡수하고 그
외 IntegrityError는 그대로 re-raise한다 — CheckViolation은 `except ValueError`
(gates.py::transition_gate_endpoint)에도 안 걸려 500 INTERNAL_ERROR로 샜다.

로컬 테스트가 못 잡은 이유 — `tests/test_3516_comment_reply.py`의 disposable DB는
`Base.metadata.create_all()`로 세팅되는데, 이 CHECK는 0323이 raw SQL
`op.create_check_constraint(...)`로만 걸었고 `PublicationCommand` 모델의
`__table_args__`엔 반영된 적이 없다(모델↔마이그 패리티 갭 — `project_
artifact_versions_fk_name_parity_gap` 메모리와 동형 클래스) — `create_all()`은
SQLAlchemy 모델 정의만 보고 이 제약 자체를 안 만들어 로컬 테스트가 원천적으로
이 실패를 재현 못 했다. CI(alembic upgrade 경유) 실행 여부는 grep 필요(후속 조사
— 이 핫픽스는 우선 라이브 결함부터 막는다).

정정: 기존 CHECK를 drop하고 'comment_reply'를 추가한 CHECK로 재생성. 모델
`__table_args__`에도 이 제약을 이번엔 명시 추가해(같은 파일에서) 다음 값 추가
때도 같은 클래스의 모델↔마이그 드리프트가 재발하지 않게 한다."""
from __future__ import annotations

from alembic import op

revision = "0340"
down_revision = "0339"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.create_check_constraint(
        "ck_publication_commands_content_kind",
        "publication_commands",
        "content_kind IN ('channel_post', 'site_post', 'comment_reply')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.create_check_constraint(
        "ck_publication_commands_content_kind",
        "publication_commands",
        "content_kind IN ('channel_post', 'site_post')",
    )
