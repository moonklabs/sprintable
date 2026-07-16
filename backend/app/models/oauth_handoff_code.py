"""story 1931(계약 doc `e-mobile-oauth-native-handoff-contract` §4/§7.5(b)): OAuth 완결
후 웹뷰 세션 핸드오프용 단회 코드. `auth_native_bootstrap_codes`(attested §7.5)와 물리적으로
분리 — installation/challenge FK가 없고, 대신 PKCE `code_challenge`(S256 base64url)에
바인딩된다. `code_hash`만 저장 — raw code는 issue 응답으로만 반환되고 DB엔 절대 남지 않는다."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OAuthHandoffCode(Base):
    __tablename__ = "oauth_handoff_codes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    firebase_uid: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(Text, nullable=False)
    code_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # PKCE S256: base64url(SHA256(code_verifier)) — consume 시점에 재계산해 등가 비교.
    code_challenge: Mapped[str] = mapped_column(Text, nullable=False)
    # 원본 OAuth 로그인의 Firebase ID token auth_time — consume 시점 cutover 재검증 기준
    # (auth_native_bootstrap_codes.auth_time과 동일 목적/패턴).
    auth_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
