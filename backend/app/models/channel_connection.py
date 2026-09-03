"""story #3373(Phase1·마케팅운영, 그라운딩 doc 6766a399 §7, 선생님 확定 2026-09-03) — 조직이
연결한 외부 채널 계정의 암호화 credential 원장.

`org_connector_registry`(app/models/connector_registry.py)와 의도적으로 별개 테이블이다 —
그 레지스트리는 "시크릿/토큰은 절대 안 온다"는 명시 설계(story #3317)라, credential을 실제로
보관해야 하는 이 테이블은 그 설계를 재사용하지 않고 새로 연다. FK로 묶지 않는다(그라운딩 §9
확定 — 관계 형태는 블루프린트 원문이 정하지 않았고, 두 테이블의 생애주기가 다르다: 레지스트리는
스키마 선언, 이건 개별 계정 연결).

암호화는 `app/services/billing_key_crypto.py`(MultiFernet·Secret Manager 키 회전) 그대로
미러(`channel_credential_crypto.py`) — 신규 암호화 패턴을 발명하지 않는다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class ChannelConnection(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "channel_connections"
    __table_args__ = (
        UniqueConstraint("org_id", "channel", "account_id", name="uq_channel_connections_org_channel_account"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    channel: Mapped[str] = mapped_column(Text, nullable=False)  # "threads" | "instagram" | ... (Phase1=threads만)
    account_id: Mapped[str] = mapped_column(Text, nullable=False)  # 외부 플랫폼 계정/페이지 식별자
    account_label: Mapped[str | None] = mapped_column(Text, nullable=True)  # 화면 표시용(사용자명 등)
    # 유나 화면설계 §8③(PO 채택) — "발급 붙여넣기"형 채널(WordPress Application Password 등)도
    # 같은 테이블 암호 컬럼을 쓴다. oauth=이 파일의 OAuth 흐름으로 채움, pasted_secret=휴먼이
    # 직접 값을 붙여넣음(둘 다 encrypted_access_token에 저장 — 의미만 다름), none=credential
    # 불요 채널(미래 대비, 현재 미사용).
    credential_kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="oauth")
    encrypted_access_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    encrypted_refresh_token: Mapped[str | None] = mapped_column(Text, nullable=True)  # provider가 주는 경우만
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story 본문 명시 — refresh_token 없이 "현재 유효한 access_token으로 재발급"하는 provider
    # (Threads 장기 토큰이 이 방식) 대응. "refresh_token"=표준 grant, "reissue_from_access_token"
    # =Threads류, "manual"=자동 갱신 불가(재인증 유도).
    refresh_mode: Mapped[str] = mapped_column(Text, nullable=False, server_default="manual")
    scopes: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")  # active|expired|revoked|error
    last_refreshed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 유나 화면설계 §8②(PO 채택) — 갱신 실패 사유를 화면이 보여줄 수 있게(토큰 자체는 절대 아님).
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    connected_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
