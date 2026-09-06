"""story #3583-BE(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — GA4 «고객 소유»
측정 연결. `channel_connections`(발행 채널)와 별개 테이블 — GA4는 발행 채널이
아니라 «측정 연결»이라 `channel_adapters`/`ChannelConnection`에 안 얹는다(PO 確定
①, `measurement_connections.py` key="ga4"가 이 행을 읽는 자리). org당 최대 1행
(unique) — 조직이 GA4 속성 하나만 연결한다는 전제(계약에 다건 언급 없음).

`status` 기계값 4(계약 보강 3, 이름에 뜻을 안 싣는다 — "connected+property_id
null"로 상태를 표현하지 않는다):
- "connected": 토큰+property 둘 다 있음.
- "property_pending": 토큰만 있음(콜백 직후, 속성 미선택).
- "disconnected": 연결 자체가 없음(행이 아예 없을 때와 동형 — 이 값은 실제로는
  거의 안 씀, DELETE는 행을 지운다 — 계약 보강 2 "토큰 폐기").
- "needs_reauth": 사람이 다시 연결해야 풀림(refresh invalid_grant/만료/403).

`reason`(계약 보강 4) — needs_reauth일 때만 값: 'expired'|'revoked'|'error'(계약
보강 5, ConnectionRow ReauthNote와 같은 값 집합 재사용 — 새 낱말 0). 429/5xx/
네트워크 등 일시 오류는 이 필드를 안 건드린다(그 회차만 «미제공», status 무변
— 페드루 明示: 사람이 고쳐야 풀리는 것만 연결 상태로 승격)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class GA4Connection(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "ga4_connections"
    __table_args__ = (
        UniqueConstraint("org_id", name="uq_ga4_connections_org_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    encrypted_access_token: Mapped[str] = mapped_column(Text, nullable=False)
    # 덧붙임(a, 페드루 明示 2026-09-06) — authorize에 access_type=offline+prompt=
    # consent를 반드시 실어야 최초 왕복에서 이 값이 온다(안 실으면 1시간 뒤 전부
    # needs_reauth) — AC로 고정(테스트).
    encrypted_refresh_token: Mapped[str] = mapped_column(Text, nullable=False)
    property_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    property_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="property_pending")
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    connected_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    connected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
