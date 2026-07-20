import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PushDevice(Base):
    """모바일 푸시 디바이스 등록 (E-MOBILE M0·S2).

    webhook_configs 동형 패턴(멤버-소유·org/project 무관 member-global). 공식 앱(EE)이 Expo push
    토큰을 등록하고, 발송기(S3)가 이 테이블을 대상 디바이스 목록으로 쓴다. crux §3 스키마.
    """

    __tablename__ = "push_devices"
    __table_args__ = (
        # 재등록(같은 디바이스 토큰) = upsert 자연 멱등 — on_conflict 타깃.
        UniqueConstraint("expo_push_token", name="uq_push_devices_expo_push_token"),
        # story 1935: v0.2.4 앱이 platform 없이 register해 422→row 미생성이던 실 갭 수정 —
        # NULL 허용(미보고=아직 모름, fake default 아님). Expo Push API 자체가 platform을
        # 안 쓰므로(expo_push.py) 발송기 영향 없음.
        CheckConstraint(
            "platform IS NULL OR platform IN ('ios', 'android')", name="push_devices_platform_check"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # webhook_configs(0079) 선례: member_id FK 완화(grant-only write 500 해소). 소유 스코프는 쿼리시점
    # org_id AND member_id 필터로 강제(repo list/get_owned/delete).
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    expo_push_token: Mapped[str] = mapped_column(Text, nullable=False)  # ExponentPushToken[...] (UNIQUE)
    platform: Mapped[str | None] = mapped_column(Text, nullable=True)  # ios | android | 미보고(CHECK)
    device_id: Mapped[str | None] = mapped_column(Text, nullable=True)  # 앱 설치 단위 식별(관측용, 선택)
    app_version: Mapped[str | None] = mapped_column(Text, nullable=True)  # 관측용
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)  # DeviceNotRegistered→false(S3)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
