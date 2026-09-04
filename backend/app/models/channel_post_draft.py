"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널(Threads 등) 포스트
초안 원장. `SitePostDraft`(site_post_draft.py)와 구조가 미러(초안→버전→external_publish
게이트→봉인)이지만 페이로드가 달라(단일 text·link_url·대상 channel/connection) **별도
테이블**로 연다(PO 결정 — 억지 일반화 금지).

`channel`은 `connection_id`의 파생값이다(채널 연결 서비스 골격, story #3373 — 한 채널에
여러 계정이 있을 수 있어 `channel` 자체는 독립 식별축이 아니다) — 그래서 유니크 제약은
`(org_id, work_item_id, channel)`이 아니라 `(org_id, work_item_id, connection_id)`(PO
정정, 제안 당시 스냅샷과 다름). `channel` 컬럼은 초안 생성 시 `connection_id`로 조회한
`ChannelConnection.channel`을 그대로 복사해 둔 것 — 목록·필터가 매번 조인하지 않아도 되게
하는 denormalize다(connection 삭제 후에도 "무슨 채널이었는지"가 남는다).

`source_content_item_id`(story #3437, 페드루 PO 確定 2026-09-04) — 이 채널 변형이 파생된
content_item(=SitePostDraft.id). FK 없음(이 도메인 전체 관례) — org 일치는 서비스 계층이
초안 생성 시 검증한다(다른 조직 원문 참조는 422). nullable — 소스 없는 단독 채널 초안도
기존처럼 허용(회귀, AC6)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChannelPostDraft(Base):
    __tablename__ = "channel_post_drafts"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "work_item_id", "connection_id", name="uq_channel_post_drafts_org_work_item_connection",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    # FK 없음 — channel_connections도 FK 없음 관례(그라운딩 6766a399 §9). 존재+status=active
    # 검증은 서비스 층에서 매번(초안 생성·상신 시점) 한다.
    connection_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    source_content_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    # story #3437(후속 묶음, 페드루 PO 確定 2026-09-05) — source_content_item_id가 «어느
    # draft에서 파생됐나»(draft 축)만 가리키는 것과 달리, 이 컬럼은 «그 draft의 몇 번
    # 버전에서 파생됐나»(버전 축)를 초안 생성 시점에 고정한다. 원문이 그 뒤 새 버전을
    # 내도 이 값은 안 바뀐다 — staleness("원문이 파생 이후 개정됨") 판별의 기준점.
    # FK 없음(source_content_item_id와 같은 이유) — nullable(source_content_item_id가
    # null이면 이것도 항상 null).
    source_site_post_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    # story #3471(페드루 PO 確定 2026-09-05) — 마지막 버전 생성 시점의 lint 결과
    # 스냅샷(`{rules_version, violations[]}`). 실시간 재계산 아님 — 규칙이 그 뒤 바뀌어도
    # 이 값은 다음 create/update(새 버전 생성)까지 그대로(AC "과거 evidence 보존").
    # 비차단(create/update는 저장만, 거부는 submit()만) — content_rules.py::lint_content
    # 참고.
    lint_result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
