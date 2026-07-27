"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5·doc §9.1·산티아고 §9 코드 보안계약 2026-07-15):
네이티브 부트스트랩 단회코드. `code_hash`만 저장 — raw code는 발급 응답으로만 반환되고 DB엔
절대 남지 않는다.

story cbd578d4(C4·§7.0/§7.5): `device_binding_hash`(문자열 비교, S5 임시 스킴) 완전 삭제 —
`installation_id`+`key_version`+`redeem_challenge_id`로 대체. 코드는 이제 등록된 설치의
암호학적 challenge-assertion에 정확히 바인딩된다."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AuthNativeBootstrapCode(Base):
    __tablename__ = "auth_native_bootstrap_codes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    firebase_uid: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(Text, nullable=False)
    code_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    installation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("device_installations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    key_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    redeem_challenge_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("device_proof_challenges.id", ondelete="CASCADE"), nullable=True
    )
    # story bea25062(§17d-1 BLOCKER 2): 이 코드 발급의 근거가 된 원본 Firebase ID token의
    # auth_time — created_at(코드 발급 시각)과 다르다. cutover 재검증은 항상 이 값을 기준으로
    # 한다(revoke 이후 예전 ID token으로 새 코드를 발급받는 우회 차단).
    auth_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
