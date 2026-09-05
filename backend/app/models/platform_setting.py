"""story #2728(P0·과금) — 플랫폼 전역 가변값(선생님 결정③: 하드코딩·env var 금지, 어드민 관리).

release_notes(app/models/release_note.py)와 동일 원칙 — **제품 전역**(org 무관) 글로벌 테이블.
설계 불변식: 이 테이블은 정확히 1행(싱글턴)만 갖는다 — 조회는 항상 그 1행. `id`는 마이그가
고정 UUID로 시드하며, 애플리케이션 코드는 새 행을 만들지 않는다(UPDATE만).

DDL owner = 이 OSS 백엔드 단독(sprintable-admin/internal-api README.md 경계 원칙). write는
공개 API에 없다 — release_notes가 겪은 실사고(라우터 docstring 참고: 공개 write가 org-owner
게이트라 아무 고객 org owner가 전역 설정을 편집할 수 있었던 EXPLOITABLE 사고)와 동일 클래스를
원천 차단한다. mutation은 sprintable-admin/internal-api(require_operator, IAP+SA allowlist)
에서만.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class PlatformSetting(Base, TimestampMixin):
    __tablename__ = "platform_settings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    # 가격 "표시"(정보 노출) — 실제 결제 처리와 별개 축(story #2728③).
    billing_price_public: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    # 결제 "진입"(실제 처리) — checkout 엔드포인트가 매 요청 이 값을 읽어 서버측에서 거부한다
    # (FE 숨김만으로는 반쪽 — 선생님 결정② 집행의 핵심).
    billing_checkout_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    updated_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #2907(선생님 확定 2026-08-21) — dunning grace 기간(일). 재시도 창=D+1..
    # D+dunning_grace_days, downgrade 트리거일=D+dunning_grace_days+1. 하드코딩 금지
    # 원칙(AC6)에 따라 어드민 관리값으로 — 기본 7일(마이그 0270 시드).
    dunning_grace_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("7"))
    # story #3097(선생님 결정 2026-08-26) — 청구 시점 VAT 가산율(basis points, 1bp=0.01%).
    # v2.3 확정가=공급가라 charge_org로 넘어가는 최종 amount_minor는 이 값으로 가산된
    # 금액이어야 한다(billing_charge_amount.py/billing_pack.py 참고). 기본 1000(10%,
    # 마이그 0282 시드) — 하드코딩 금지 원칙(dunning_grace_days와 동일 선례).
    vat_rate_bp: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1000"))
    # story #3373(Phase1·마케팅운영, 페드루 PO 정정 2026-09-03 08:40Z) — SaaS 기본 제공되는
    # «공용 Threads(Meta) 앱» 자격. 블루프린트 §8: 조직별 자격(channel_app_credentials)은
    # 옵션이고, 공용 앱이 기본 경로다. env var(threads_app_id/secret 설정값)로 두지 않는다
    # (이 파일 모듈 docstring의 선생님 결정③ — 코드 배포 없이 바뀌어야 하는 값은 어드민
    # 관리, env var는 재배포가 있어야 바뀜). 둘 다 nullable — 미설정이면(NULL) 공용 앱
    # fallback도 없다는 뜻(app/services/channel_app_credentials.py의 3단 우선순위:
    # 조직 자격 → 이 값 → 없음=409). secret은 channel_credential_crypto.py로 암호화
    # (channel_app_credentials.encrypted_app_secret과 동일 키·동일 함수 재사용).
    threads_platform_app_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    threads_platform_encrypted_app_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #3475(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 발행 계측 API
    # 「정시」 정의(published_at - scheduled_at <= tolerance)의 허용오차(초). cron
    # 1분 tick + 워커 처리 여유 감안 기본 120초(마이그 0328 시드) — 하드코딩 금지
    # 원칙(dunning_grace_days/vat_rate_bp와 동일 선례).
    on_time_tolerance_seconds: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("120"))
