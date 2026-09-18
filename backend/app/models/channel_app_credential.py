"""story #3373(Phase1·마케팅운영, 선생님 지적·페드루 PO 정정 2026-09-03 08:29Z) — 조직별
채널 앱 자격(app_id/app_secret). 이전 설계("Threads 앱 id/secret은 Sprintable 공용 시크릿
하나")는 틀린 전제였다 — Meta 앱은 조직마다 자기 것을 등록해 쓴다. `settings.threads_app_*`는
이제 org 자격이 없을 때만 쓰는 «플랫폼 기본값» fallback으로 격하(app/services/
channel_app_credentials.py 참고).

암호화는 `channel_credential_crypto.py`를 그대로 재사용한다(신규 암호화 패턴 발명 0 — 그
모듈은 이미 plaintext-in/out 범용 encrypt/decrypt라 이 테이블 전용 함수가 필요 없다).
channel_connections와 FK로 안 묶는다(그 테이블도 FK 없음 관례, 그라운딩 6766a399 §9와
동일 근거 — 생애주기가 다르다: 앱 자격은 채널당 1행, 연결은 계정당 여러 행)."""
from __future__ import annotations

import uuid

from sqlalchemy import Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class ChannelAppCredentials(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "channel_app_credentials"
    __table_args__ = (
        UniqueConstraint("org_id", "channel", name="uq_channel_app_credentials_org_channel"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    channel: Mapped[str] = mapped_column(Text, nullable=False)  # "threads" (Phase1=threads만)
    app_id: Mapped[str] = mapped_column(Text, nullable=False)  # 비밀 아님 — 응답에 그대로/끝4자리로 노출 가능
    encrypted_app_secret: Mapped[str] = mapped_column(Text, nullable=False)
    updated_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
