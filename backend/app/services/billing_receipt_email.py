"""story #3209(PR-2) — 결제 완료 안내 메일. billing_charge.py(순수 확정/원장 메커니즘)와
분리해 이메일 발송 관심사만 여기 둔다(cron.py의 storage/AU 경고 메일과 동일 역할분리
관례 — 원장 로직 파일이 SMTP/Resend 세부를 몰라도 되게).

`_confirm_with_ledger`가 order를 confirmed로 **처음** 전이시켰을 때만 호출한다(그 함수의
UPDATE rowcount==1 가드 — 재시도/이미-confirmed 재진입에서 중복 발송 안 함). receipt_url이
없으면(Toss 응답에 receipt 필드 자체가 없는 극히 드문 케이스) 조용히 skip — CTA 없는
메일을 지어내지 않는다(발명 금지, PO 안 §2 "«영수증 보기» 버튼 CTA" 그대로).

이메일 발송 실패는 결제 확정 자체를 되돌리지 않는다(호출자가 try/except로 감싸 로그만
남긴다 — 돈은 이미 실제로 움직였고, 안내 메일 실패로 그 사실을 무효화할 이유가 없다)."""
from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import OrgMember
from app.models.user import User
from app.services.agent_onboarding_config import resolve_locale
from app.services.email import render_action_email, send_email
from app.services.email_copy import TRANSACTIONAL_COPY

logger = logging.getLogger(__name__)


def _format_krw(amount_minor: int, locale: str) -> str:
    # KRW는 무소수 통화라 amount_minor가 곧 원 단위 정수(toss_adapter.py의 기존 규율과 동형).
    formatted = f"{amount_minor:,}"
    return f"{formatted}원" if locale == "ko" else f"₩{formatted}"


async def send_payment_receipt_email(
    session: AsyncSession, *, org_id: uuid.UUID, receipt_url: str | None,
    amount_minor: int, currency: str,
) -> None:
    """cron.py의 STORAGE_WARN_COPY/AU_WARN_COPY 발송 패턴과 동형 — 수신자=org owner/admin
    전원(OrgMember JOIN User, 개별 locale), 발송 실패는 개별 로그만(다른 수신자 발송을
    막지 않음). 결제는 KRW 고정(Toss 원화 정기결제 전제, toss_adapter.py §0)이라 currency
    파라미터는 현재 이 함수 안에서 미사용(향후 통화 확장 대비 시그니처만 보존)."""
    if receipt_url is None:
        logger.info("payment receipt email skip — no receipt_url (order org_id=%s)", org_id)
        return

    recipients = (
        await session.execute(
            select(User.email, User.locale)
            .join(OrgMember, User.id == OrgMember.user_id)
            .where(
                OrgMember.org_id == org_id,
                OrgMember.role.in_(["owner", "admin"]),
                OrgMember.deleted_at.is_(None),
            )
        )
    ).all()

    for email, locale_value in recipients:
        locale = resolve_locale(locale_value)
        copy = TRANSACTIONAL_COPY["payment_receipt"][locale]
        amount_display = _format_krw(amount_minor, locale)
        intro_lines = [line.format(amount=amount_display) for line in copy["intro_lines"]]
        html_body = render_action_email(
            intro_lines=intro_lines,
            cta_label=copy["cta_label"],
            cta_url=receipt_url,
            expiry_note=copy["expiry_note"],
            security_note=copy["security_note"],
            fallback_label=copy["fallback_label"],
            locale=locale,
        )
        try:
            await asyncio.to_thread(send_email, email, copy["subject"], html_body)
        except Exception:
            logger.exception("payment receipt email failed — org_id=%s to=%s", org_id, email)
