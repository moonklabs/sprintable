"""story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 발행 명령 원장.

블루프린트 v3 §3 그대로: 휴먼의 발행/예약 요청(POST .../publish)이 이 행을
만든다(PO 確定 (B) — 승인 자체는 트리거가 아니다, "승인 없는 명령이 없다"일
뿐). `UNIQUE(org_id, destination, approved_version, operation)` — 블루프린트
멱등키. `scheduled_at`은 요청 시점 gate.sealed_scheduled_at을 그대로 옮긴
값(null=즉시) — command 자체는 그 뒤 gate가 재봉인돼도 안 따라간다(불변,
`approved_version` 고정과 같은 사상 — "그 순간 승인된 것"의 스냅샷).

`gate_id`는 FK 없음(channel_connections·channel_post_drafts와 동일 관례,
그라운딩 §9) — 승인 뒤 편집으로 이 gate가 pending 복귀할 때 이 gate에 걸린
pending 명령을 voided로 무효화하는 조회(`void_pending_commands_for_gate`)의
유일한 키.

`failure_kind`는 유나 design §11-5 정본 3값(`connection`/`needs_check`/
`transient`) — 화면이 실패를 조립하지 않도록 서버가 값으로 낸다. 매핑을 모르는
error_code는 `needs_check`로 fail-closed(임의로 transient=재시도 가능이라
단정하지 않는다)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PublicationCommand(Base):
    __tablename__ = "publication_commands"
    __table_args__ = (
        # story #3806(Phase3·3-2 PR3, 페드루 PO 追加 確定 2026-09-11) — toggle_seq를
        # 키에 포함(0364 마이그가 정본, 여기는 미러 — 이름을 맞춰 둬 grep 한 번으로
        # 짝이 맞는지 확인 가능, 0340의 CHECK 관례와 동일 원칙). ads_boost의 pause/
        # resume은 같은 승인주기(같은 approved_version) 안에서 여러 번 토글될 수
        # 있어 옛 4열 키(그 조합 평생 한 번)로는 표현 못 한다 — toggle_seq가 "그
        # 승인주기의 N번째 토글"을 구분한다. 다른 content_kind는 이 열이 항상 0이라
        # 기존 의미가 안 바뀐다.
        UniqueConstraint(
            "org_id", "destination", "approved_version", "operation", "toggle_seq",
            name="uq_publication_commands_idempotency",
        ),
        # story #3516 조각② 라이브 핫픽스(마이그 0340, 2026-09-05) — 0323이 이 CHECK를
        # raw SQL로만 걸고 여기 모델에 미러를 안 남겨(뿌리 원인) 로컬 create_all() 기반
        # 테스트가 이 제약 자체를 못 보고 죄다 그린으로 통과했다(실 마이그된 dev DB에서만
        # content_kind="comment_reply" INSERT가 IntegrityError→500). 마이그(0323→0340)가
        # 정본, 이건 그 정본의 미러 — 이름을 반드시 같게 유지할 것(`ck_publication_
        # commands_content_kind`), 새 값을 추가할 땐 이 두 곳을 항상 같이 고칠 것.
        CheckConstraint(
            "content_kind IN ('channel_post', 'site_post', 'comment_reply', 'ads_boost', 'newsletter_send')",
            name="ck_publication_commands_content_kind",
        ),
        # story #3806(Phase3·3-2 PR 6 정정, 페드루 PO 定 2026-09-11 13:42Z) — 0367
        # 마이그의 정본 미러(위 content_kind 관례와 동형 — 이름 `ck_publication_
        # commands_initiated_by` 반드시 일치 유지, create_all() 기반 로컬 테스트가
        # 이 제약을 보게 하는 목적).
        CheckConstraint(
            "initiated_by IS NULL OR initiated_by IN ('scheduler', 'human')",
            name="ck_publication_commands_initiated_by",
        ),
        # story #4258(까디르 4621 codex P2 · PO 12:38Z) — 0405 마이그의 정본 미러(이름 일치 유지 · create_all 기반 테스트가
        # 이 제약 · 인덱스를 보게).
        CheckConstraint(
            "stop_notice_state IS NULL OR stop_notice_state IN ('pending', 'sent')",
            name="ck_publication_commands_stop_notice_state",
        ),
        Index(
            "ix_publication_commands_stop_notice_pending", "id",
            postgresql_where=text("stop_notice_state = 'pending'"),
        ),
        # story #4287 — 0408 마이그의 정본 미러. 멈춘 in_progress 회수 쓸기(틱마다)가 in_progress 행만 집어 본다.
        Index(
            "ix_publication_commands_in_progress_claimed", "claimed_at",
            postgresql_where=text("status = 'in_progress'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    gate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    destination: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    approved_version: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    operation: Mapped[str] = mapped_column(Text, nullable=False, server_default="publish")
    # story #3806(Phase3·3-2 PR3, 페드루 PO 追加 確定 2026-09-11) — 위 UniqueConstraint
    # 참조. channel_post/site_post/comment_reply는 항상 0(그 조합 평생 한 번인
    # 기존 의미 그대로). ads_boost의 pause/resume만 0을 벗어나며 "그 승인주기의
    # N번째 토글"을 센다(app/services/ads_boost_execution.py::_resolve_toggle_seq가
    # 유일한 채움 경로 — boost_start는 항상 0 고정으로 명시 전달).
    toggle_seq: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # story e4fc29fa(조각③c) — 'channel_post'|'site_post'. approved_version이 어느
    # 테이블(ChannelPostVersion|SitePostVersion)을 가리키는지의 유일한 판별축(워커
    # 분기) — FK 없음 관례라 이 컬럼 없이는 워커가 두 도메인을 못 구분한다.
    content_kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="channel_post")
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 'pending'|'in_progress'|'completed'|'failed'|'dead_letter'|'voided'|'blocked'
    # (blocked=connection 복구 대기, PO 정정2 추가② — 일반 재시도 큐 밖).
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # voided 전이 사유('CONTENT_CHANGED'|'SCHEDULE_CHANGED') — PO 確定3.
    reason_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #3815(배포 82 라이브 회차 실 결함, 페드루 PO 確定 2026-09-12) — reason_code가
    # 'YOUTUBE_QUOTA_EXCEEDED'일 때만 채워진다("언제 풀리는지"가 확定적으로 알려진
    # 사유만 — 그 외 reason_code는 계속 null, 지어내지 않는다). apply_command_failure()
    # 참고.
    reason_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 'connection'|'needs_check'|'transient' — 유나 design §11-5.
    failure_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    dead_letter_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    requested_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # story #3806(Phase3·3-2 PR 6 정정, 페드루 PO 定 2026-09-11 13:42Z) — 「누가
    # 시작했나」 두 세계 처방(0367). `requested_by_member_id`만으로는 자동 워커와
    # 사람 클릭을 구분 못 한다(승인자 본인이 직접 누르면 둘 다 같은 member_id).
    # null=이 정보를 모르는 기존 행(이 컬럼 도입 전 데이터·다른 content_kind는
    # 채울 이유가 없어 계속 null로 둔다 — ads_boost의 boost_start만 채움).
    initiated_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4258(까디르 4621 codex P2 · PO 12:38Z) — 레시피 멈춤 통지 표식. `apply_command_failure`가 dead_letter · 연결
    # blocked로 **전이하는 같은 트랜잭션**에서 `pending`을 세우고, 워커가 행마다 자기 트랜잭션에서 «통지 발행 + `sent`»를 한
    # 커밋으로 한다(사라짐 0 · 같은 멈춤 중복 0). 사람 재시도가 NULL로 되돌려, 다시 멈추면 새 통지다. NULL = 보낼 것 없음(이
    # 컬럼 전의 옛 멈춤도 NULL — 소급하지 않는다).
    stop_notice_state: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4287(PO 00:16Z) — 워커가 in_progress로 집은 시각. 회수 쓸기가 «상한 시간 넘게 집힌 채»를 이 값으로 잰다. NULL인
    # in_progress는 이 칸이 생기기 전에 집힌 옛 행이라 «호출 전 확실»로 읽지 않는다(needs_check).
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #4287 — 공급자 쓰기에 들어가기 직전 서비스 코드가 쓰고 **커밋**하는 영속 표식(집을 때 비운다). 워커가 도중에 죽어도
    # 남아서, 회수가 «나갔는지 모름»(있음 → needs_check)과 «호출 전 확실»(없음 → 자동 재시도)을 가른다. 메모리 표시
    # (`provider_call_mark`)는 프로세스와 함께 사라져 이 판정에 못 쓴다.
    provider_call_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )
