import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(Text, nullable=False)
    # story #3247 — migration 0295. totp/disable password 재검증 우회체인 차단용(그 비밀번호가
    # 현재 세션 토큰보다 먼저 존재했는지 판별). NULL=제약 신설 이전 기존 유저(무제약, 0290
    # locale과 동형 논지).
    password_set_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    login_fail_count: Mapped[int] = mapped_column(nullable=False, default=0)
    login_locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tos_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    totp_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    totp_last_timestep: Mapped[int | None] = mapped_column(nullable=True)
    totp_fail_count: Mapped[int] = mapped_column(nullable=False, default=0)
    totp_locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #3205 — 발송 메일 로케일 분기 판별원. FE 라이브 렌더링 locale은 여전히 쿠키
    # 전용(story 11f1087c 크루스 무회귀) — 이건 요청 밖(cron 등)에서도 읽을 수 있는
    # 발송 전용 신호. nullable, 가입 시 Accept-Language로 1회 포착. None이면
    # resolve_locale()이 DEFAULT_LOCALE("ko")로 폴백한다(추측 백필 없음).
    locale: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #3204(acquisition 계측) — 가입 시점 1회 포착(locale과 동형 패턴, 재작성 없음).
    # proxy.ts의 first-touch 쿠키(첫 랜딩의 utm_*/referrer, 재방문 덮어쓰기 안 함)를
    # register()/oauth_callback() 신규 유저 생성 시점에 그대로 옮겨 담는다. 코호트별
    # 채널 분석이 목적이라 반복 이벤트가 아닌 1회성 불변 속성 — event meta가 아니라
    # 이 테이블의 직접 컬럼으로 둔다(PO 확定, doc story #3204).
    signup_utm_source: Mapped[str | None] = mapped_column(Text, nullable=True)
    signup_utm_medium: Mapped[str | None] = mapped_column(Text, nullable=True)
    signup_utm_campaign: Mapped[str | None] = mapped_column(Text, nullable=True)
    signup_referrer: Mapped[str | None] = mapped_column(Text, nullable=True)
    google_id: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True, index=True)
    # story #2155(2026-07-23): GitHub 로그인 자체를 제거했다(app/routers/auth.py — provider
    # dispatch에서 "github" 삭제). 이 컬럼은 로그인 외 용도가 0곳(PO grep 확認 — 커밋 귀속·
    # PR 매핑 어디에도 미사용)이라 지금 당장은 죽은 컬럼이지만, 컬럼 드롭은 되돌릴 수 없고
    # prod 실측상 이 값이 채워진 사용자가 이미 0명이라 급하지도 않다 — 드롭은 별도 정리로
    # 미룬다(의도적 보존, 누락 아님).
    github_id: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True, index=True)
    # story #3118(Sign in with Apple, App Store Guideline 4.8) — google_id/github_id와 동형
    # 패턴(providerId=Apple의 sub 클레임, oauth_callback()의 getattr(User, f"{provider}_id")
    # 이 이 이름 규칙에 의존한다 — "apple_id" 외 다른 이름이면 그 조회가 AttributeError).
    apple_id: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True, index=True)
    last_project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    # 0746 후속: 현재 org source-of-truth. refresh가 org 컨텍스트 없을 때 _build_app_metadata가
    # 이 값으로 스코프해 cross-org 옛 프로젝트 재주입(0-project org leak)을 차단한다.
    last_org_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # story #3159(retention·최소층) — 미완주 리마인드 메일 중복방지(발송 이력) + 1-클릭 수신거부.
    onboarding_reminder_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    marketing_email_opt_out: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #2449: 원자 rotation 승자 경로에서, 새 row가 실제로 INSERT+commit된 «後» 별개
    # UPDATE로 old row에 그 새 row의 id를 기록 — winner rotation 계보 추적/향후 family-revoke
    # 훅용. NULL=아직 회전 안 됐거나 logout 등 dead-end(승계자 없는 명시적 종료).
    #
    # ⛔v1 설계(폐기, 카디르 QA REQUEST_CHANGES 2026-08-04)는 이 id를 원자 revoke UPDATE와
    # «같은» 문장에 미리 얹었다 — revoke 성공 直後 user 조회가 실패(예: 그새 계정 비활성화)해
    # 새 row INSERT 前에 401로 조기반환하면, deferred FK가 커밋 시점에 위반돼 트랜잭션 전체
    # (방금 성공한 revoke 포함)가 롤백되는 회귀였다(e5225c0a P0 single-use 불변식 재파손).
    # 지금은 별도 post-INSERT UPDATE라 그 결합 자체가 없다 — deferrable=True/initially=
    # "DEFERRED"는 이제 판정에 필수는 아니지만(참조 대상이 이미 커밋된 뒤에만 이 UPDATE가
    # 실행됨) 방어적으로 유지한다(카디르 확認, 마이그 0226 무접촉이 더 안전).
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("refresh_tokens.id", ondelete="SET NULL", deferrable=True, initially="DEFERRED"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
