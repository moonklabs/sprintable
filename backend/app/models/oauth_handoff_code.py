"""story 1931(계약 doc `e-mobile-oauth-native-handoff-contract` §4/§7.5(b)·산티아고 §10 MUST
2026-07-16 조건부 GREEN): OAuth 완결 후 웹뷰 세션 핸드오프용 단회 코드. `auth_native_
bootstrap_codes`(attested §7.5)와 물리적으로 분리 — installation/challenge FK가 없고,
대신 PKCE `code_challenge`(S256 base64url)에 바인딩된다. `code_hash`만 저장 — raw code는
issue 응답으로만 반환되고 DB엔 절대 남지 않는다.

§10.1.1/.7: `purpose` discriminator — 이 테이블에 쓰는 모든 행은 항상
`PURPOSE_NATIVE_OAUTH_HANDOFF`(oauth_handoff.py) 고정값. 물리적으로 별도 테이블이라 이미
attested 코드와 섞일 수 없지만, consume 쿼리 자체에도 이 값을 조건으로 넣어 "일반 assertion
consume의 optional 분기로 구현 금지" 요구를 코드 레벨에서 다시 한번 명시적으로 강제한다."""
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
    # §10.1.1: 고정값 PURPOSE_NATIVE_OAUTH_HANDOFF — consume WHERE절에도 명시 포함.
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    # PKCE S256: base64url(SHA256(code_verifier)) — consume 시점에 재계산해 등가 비교.
    code_challenge: Mapped[str] = mapped_column(Text, nullable=False)
    # 원본 OAuth 로그인의 Firebase ID token auth_time — consume 시점 cutover 재검증 기준
    # (auth_native_bootstrap_codes.auth_time과 동일 목적/패턴).
    auth_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
