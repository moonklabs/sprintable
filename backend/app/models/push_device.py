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
        UniqueConstraint("apns_device_token", name="uq_push_devices_apns_device_token"),
        # story 1935: v0.2.4 앱이 platform 없이 register해 422→row 미생성이던 실 갭 수정 —
        # NULL 허용(미보고=아직 모름, fake default 아님). Expo Push API 자체가 platform을
        # 안 쓰므로(expo_push.py) 발송기 영향 없음.
        CheckConstraint(
            "platform IS NULL OR platform IN ('ios', 'android', 'macos')",
            name="push_devices_platform_check",
        ),
        # story #3064: macOS(Tauri)는 Expo 런타임이 아니라 Expo push 토큰을 만들 수 없음 —
        # 플랫폼별 토큰 컬럼 상호배타(0278 마이그 참고, dev GROUP BY 스캔으로 기존 행 전부
        # 우변 충족 확認 후 1단계로 올림 — prod는 승격 前 재스캔 필수).
        CheckConstraint(
            "(platform = 'macos' AND apns_device_token IS NOT NULL AND expo_push_token IS NULL) "
            "OR (platform IS DISTINCT FROM 'macos' AND expo_push_token IS NOT NULL)",
            name="push_devices_token_platform_exclusive_check",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # webhook_configs(0079) 선례: member_id FK 완화(grant-only write 500 해소). 소유 스코프는 쿼리시점
    # org_id AND member_id 필터로 강제(repo list/get_owned/delete).
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    expo_push_token: Mapped[str | None] = mapped_column(Text, nullable=True)  # ExponentPushToken[...] (UNIQUE, ios/android)
    apns_device_token: Mapped[str | None] = mapped_column(Text, nullable=True)  # raw hex APNs 토큰(UNIQUE, macos)
    platform: Mapped[str | None] = mapped_column(Text, nullable=True)  # ios | android | macos | 미보고(CHECK)
    device_id: Mapped[str | None] = mapped_column(Text, nullable=True)  # 앱 설치 단위 식별(관측용, 선택)
    app_version: Mapped[str | None] = mapped_column(Text, nullable=True)  # 관측용
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)  # DeviceNotRegistered→false(S3)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
