"""story #3806(Phase3·3-2 PR3, 페드루 PO 確定 2026-09-11) — `publication_commands`
`content_kind` CHECK에 "ads_boost" 추가 + `toggle_seq` 열 신설 + idempotency UNIQUE
확장.

## 왜 toggle_seq가 필요한가(페드루 PO 追加 確定, PR 3 착수 직후)
기존 `UNIQUE(org_id, destination, approved_version, operation)`은 "그 destination+
approved_version+operation 조합은 평생 한 번"을 전제한다 — publish/unpublish처럼
한 승인 주기에 각각 딱 한 번만 일어나는 조합엔 맞지만, ads_boost의 pause/resume은
같은 승인 주기(같은 sealed_ads_boost_version_id) 안에서 여러 번 토글될 수 있다
(중지→재개→중지…). `toggle_seq`(0345류 sealed_* 관례와 달리 이건 `publication_
commands` 자체의 열) 를 UNIQUE에 포함시켜 "같은 승인 주기의 N번째 토글"을 별개
행으로 구분한다.

- `boost_start`는 toggle_seq=0 고정(publish/unpublish와 동형 1회성 — 그 승인
  주기당 정확히 한 번).
- `pause`/`resume`은 그 승인 주기의 직전 토글 행(있으면) toggle_seq+1. 직전 토글
  행이 아직 비종결(pending/in_progress/blocked)이고 **같은 operation**을 다시
  요청하면(더블클릭) 새 행을 안 만들고 그 행 자체를 재사용(app/services/
  ads_boost_execution.py::_resolve_toggle_seq).
- 다른 content_kind(channel_post/site_post/comment_reply)는 이 열이 항상
  server_default 0 그대로라 기존 UNIQUE 의미가 전혀 안 바뀐다(그 kind들은 toggle_
  seq=0을 절대 벗어나지 않는다 — additive, 회귀 0).

## downgrade 주의
실 운영에서 이 기능이 쓰인 뒤(즉 (org,destination,approved_version,operation)이
같고 toggle_seq만 다른 행이 2개 이상 존재한 뒤) downgrade하면 옛 4열 UNIQUE
재생성이 중복 위반으로 실패한다 — 이 마이그는 신규 기능이라 로컬 검증 시점엔
그런 행이 없다는 전제로만 downgrade를 지원한다(운영 rollback은 별도 데이터
정리 선행 필요, 0217류 선례와 같은 성격의 알려진 제약).

## ads_boost_runs 신설(페드루 PO 追加 確定 2026-09-11, PR 3 워커 fix — 같은
마이그에 동봉)
`_process_one_command`가 content_kind=="ads_boost"를 오분기(channel_post
전용 기본 분기로 떨어져 매번 CHANNEL_POST_DRAFT_NOT_FOUND로 즉시 실패, 실
Meta API 호출 0)하던 결함을 여기서 같이 고친다 — 그 워커가 실제로 캠페인/
광고세트/광고를 만들고 그 외부 id를 저장할 자리가 필요하다. gate 행 자신에는
안 쓴다(sealed_* 불변성 보존, 이 파일 상단 모델 docstring 참고) — 1 gate =
1 run(UNIQUE(gate_id))."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0364"
down_revision = "0363"
branch_labels = None
depends_on = None

_OLD_CHECK_SQL = "content_kind IN ('channel_post', 'site_post', 'comment_reply')"
_NEW_CHECK_SQL = "content_kind IN ('channel_post', 'site_post', 'comment_reply', 'ads_boost')"


def upgrade() -> None:
    op.add_column(
        "publication_commands",
        sa.Column("toggle_seq", sa.Integer(), nullable=False, server_default="0"),
    )
    op.drop_constraint("uq_publication_commands_idempotency", "publication_commands", type_="unique")
    op.create_unique_constraint(
        "uq_publication_commands_idempotency",
        "publication_commands",
        ["org_id", "destination", "approved_version", "operation", "toggle_seq"],
    )
    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.create_check_constraint("ck_publication_commands_content_kind", "publication_commands", _NEW_CHECK_SQL)

    op.create_table(
        "ads_boost_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("gate_id", UUID(as_uuid=True), nullable=False),
        sa.Column("campaign_id", sa.Text(), nullable=True),
        sa.Column("adset_id", sa.Text(), nullable=True),
        sa.Column("ad_id", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
            onupdate=sa.func.now(), nullable=False,
        ),
        sa.UniqueConstraint("gate_id", name="uq_ads_boost_runs_gate_id"),
    )
    op.create_index("ix_ads_boost_runs_org_id", "ads_boost_runs", ["org_id"])
    op.create_index("ix_ads_boost_runs_gate_id", "ads_boost_runs", ["gate_id"])


def downgrade() -> None:
    op.drop_table("ads_boost_runs")

    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.create_check_constraint("ck_publication_commands_content_kind", "publication_commands", _OLD_CHECK_SQL)
    op.drop_constraint("uq_publication_commands_idempotency", "publication_commands", type_="unique")
    op.create_unique_constraint(
        "uq_publication_commands_idempotency",
        "publication_commands",
        ["org_id", "destination", "approved_version", "operation"],
    )
    op.drop_column("publication_commands", "toggle_seq")
