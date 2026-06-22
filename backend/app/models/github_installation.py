"""E-GHAPP Bot-S: per-org GitHub App installation.

org 가 GitHub App(봇)을 설치하면 GitHub 가 installation_id 를 발급한다. 이 행은 org_id ↔ installation
매핑(설치 사실·account·repo 선택·suspend 상태)만 저장한다. **installation access token 은 단명(~1h)
이라 여기 영속하지 않는다** — 서비스가 app JWT 로 그때그때 mint + 인메모리 캐시(보안모델 lock).

per-org 격리: 모든 read 는 org_id 스코프(anti-IDOR). 한 org 당 한 installation(uq).
"""
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class GithubInstallation(Base):
    __tablename__ = "github_installation"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 한 org 당 한 설치(uq) — 재설치 시 같은 행 갱신(upsert by org_id). FK→organizations(RC: 정합성).
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    # GitHub 가 발급하는 installation 식별자(토큰 mint API 경로 키). 전역 unique.
    installation_id: Mapped[int] = mapped_column(BigInteger, nullable=False, unique=True)
    account_login: Mapped[str | None] = mapped_column(String(255), nullable=True)
    account_type: Mapped[str | None] = mapped_column(String(32), nullable=True)  # Organization | User
    repository_selection: Mapped[str | None] = mapped_column(String(16), nullable=True)  # all | selected
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class GithubInstallNonce(Base):
    """설치 state nonce 서버측 store — **one-time consume**(replay 방어). install/start서 INSERT,
    callback서 atomic DELETE(없으면 재사용/만료=거부). TTL 경과분은 주기/지연 정리(만료 체크로 거부됨).
    """
    __tablename__ = "github_install_nonce"

    jti: Mapped[str] = mapped_column(String(64), primary_key=True)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class GithubWebhookDelivery(Base):
    """Bot-M.2: 웹훅 delivery 멱등 store — **uq(source, delivery_id)**. HMAC 검증 後 dedup insert +
    business side-effect + status 갱신을 **동일 트랜잭션**으로 묶는다 — 실패=rollback→GitHub retry 보존
    (delivery row 도 함께 rollback돼 retry 안 막음). 중복충돌=savepoint rollback + 2xx no-op.
    status: received | processed | ignored | failed | duplicate. (retention/cleanup 은 후속 hygiene.)
    """
    __tablename__ = "github_webhook_delivery"
    __table_args__ = (
        UniqueConstraint("source", "delivery_id", name="uq_github_webhook_delivery_src_delivery"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(16), nullable=False)        # legacy | app (검증된 secret서 결정)
    delivery_id: Mapped[str] = mapped_column(String(128), nullable=False)  # X-GitHub-Delivery
    event: Mapped[str | None] = mapped_column(String(64), nullable=True)
    installation_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="received")
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(512), nullable=True)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
