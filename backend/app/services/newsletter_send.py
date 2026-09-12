"""story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송 요청.
승인된 발행물(`ChannelPublication`, channel="stibee"|"stibee_sandbox" — PR1이 연
채널, "발행"=ESP 캠페인 생성이 이미 끝난 상태)에 수신자 세그먼트명·발송 예정시각을
실어 `newsletter_send` 게이트를 연다. `ads_boost.py::request_ads_boost`(story #3806
PR2)와 거의 완전히 같은 구조 — 신규 판정 로직 0, 새 gate_type만 다르다.

## 「변경=재승인」 규칙(ads_boost.py 동형, PO 確定 2026-09-12)
같은 publication에 이 함수를 다시 부르면(work_item_id가 같아 create_gate가 기존
게이트를 그대로 반환하는 멱등 경로):
- 게이트가 아직 `pending`이면 — 그대로 재봉인(값만 덮어씀, 상태 전이 없음).
- 게이트가 `approved`였으면 — `pending`으로 재오픈 + `reapproval_required=True` +
  그 게이트에 걸린 대기 중(pending) 명령 voided.
ads_boost의 "증액 예외"(자동 증액 불가) 같은 별도 예외 축은 없다 — 세그먼트/시각
변경에 "더 큰/작은"의 순서가 없어 이 예외 자체가 성립하지 않는다(그라운딩 확認)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_post_draft import ChannelPostDraft
from app.models.channel_post_version import ChannelPostVersion
from app.models.channel_publication import ChannelPublication
from app.models.gate import Gate, set_gate_status
from app.services.gate_service import create_gate
from app.services.publication_command import void_pending_commands_for_gate
from app.services.workflow_line_config import _default_role_id

_NEWSLETTER_SEND_GATE_TYPE = "newsletter_send"
_VOID_REASON_NEWSLETTER_SEND_CHANGED = "NEWSLETTER_SEND_TERMS_CHANGED"
_NEWSLETTER_CHANNELS = ("stibee", "stibee_sandbox")


class NewsletterPublicationNotFoundError(Exception):
    """story #3796(insight_snapshots.py::resolve_publication_org_id)·ads_boost.py::
    AdsBoostPublicationNotFoundError와 동형 원칙 — 존재 자체 비노출."""

    def __init__(self, publication_id: uuid.UUID):
        self.publication_id = publication_id
        super().__init__(f"publication not found in this org: {publication_id}")


class NewsletterPublicationChannelError(Exception):
    """이 publication이 stibee/stibee_sandbox 채널이 아니면 발송 게이트를 열 수 없다
    (뉴스레터 발송을 아무 채널 발행물에나 붙이면 의미가 없다 — ads_boost가 ad_
    connection_id를 별도 검증하는 것과 다른 축이지만 같은 목적: 대상 자체의 정당성)."""

    def __init__(self, publication_id: uuid.UUID, channel: str):
        self.publication_id = publication_id
        self.channel = channel
        super().__init__(f"publication {publication_id} is channel={channel!r}, not a newsletter channel")


class NewsletterPublicationNotPublishedError(Exception):
    """캠페인(ChannelPublication) 발행 자체가 아직 안 끝났으면(container_created·
    failed) 발송 게이트를 열 수 없다 — "발행"과 "발송"은 순서가 있는 두 단계
    (PO 明示 2026-09-12)."""

    def __init__(self, publication_id: uuid.UUID, status: str):
        self.publication_id = publication_id
        self.status = status
        super().__init__(f"publication {publication_id} is not published yet (status={status!r})")


class NewsletterApproverRoleMissingError(Exception):
    """ads_boost.py::AdsBoostApproverRoleMissingError와 동형."""

    def __init__(self, org_id: uuid.UUID):
        self.org_id = org_id
        super().__init__(f"org has no default approver role: {org_id}")


async def _resolve_publication_and_work_item(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID,
) -> tuple[ChannelPublication, uuid.UUID]:
    """ads_boost.py::_resolve_publication_and_work_item과 동형(같은 판별축) — 단
    이쪽은 channel·status도 같이 검증(위 두 신규 예외)."""
    publication = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == publication_id)
    )).scalar_one_or_none()
    if publication is None or publication.org_id != org_id:
        raise NewsletterPublicationNotFoundError(publication_id)
    if publication.channel not in _NEWSLETTER_CHANNELS:
        raise NewsletterPublicationChannelError(publication_id, publication.channel)
    if publication.status != "published":
        raise NewsletterPublicationNotPublishedError(publication_id, publication.status)

    draft_id = (await db.execute(
        select(ChannelPostVersion.draft_id).where(ChannelPostVersion.id == publication.version_id)
    )).scalar_one_or_none()
    work_item_id = None
    if draft_id is not None:
        work_item_id = (await db.execute(
            select(ChannelPostDraft.work_item_id).where(ChannelPostDraft.id == draft_id)
        )).scalar_one_or_none()
    if work_item_id is None:
        raise NewsletterPublicationNotFoundError(publication_id)
    return publication, work_item_id


async def request_newsletter_send(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, segment_name: str,
    scheduled_at: datetime, requester_member_id: uuid.UUID,
) -> Gate:
    publication, work_item_id = await _resolve_publication_and_work_item(
        db, org_id=org_id, publication_id=publication_id,
    )

    role_id = await _default_role_id(db, org_id)
    if role_id is None:
        raise NewsletterApproverRoleMissingError(org_id)

    # scope_key: story #3478(0328)·ads_boost.py 관례 그대로 — publication_id로
    # 스코프(같은 work_item의 다른 발행물은 독립 게이트를 갖는다).
    gate = await create_gate(
        db, org_id, work_item_id, "story", _NEWSLETTER_SEND_GATE_TYPE,
        requester_member_id, role_id, scope_key=str(publication_id),
    )

    now = datetime.now(timezone.utc)
    was_approved = gate.status == "approved"
    if gate.status != "pending":
        set_gate_status(gate, "pending", now=now)
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
    if was_approved:
        gate.reapproval_required = True
        await void_pending_commands_for_gate(
            db, gate_id=gate.id, reason_code=_VOID_REASON_NEWSLETTER_SEND_CHANGED,
        )
    else:
        gate.reapproval_required = False

    gate.sealed_newsletter_segment_name = segment_name
    gate.sealed_newsletter_scheduled_at = scheduled_at
    # 페드루 PO 確定(2026-09-12) — «재봉인마다 새 UUID»(신규·pending 재봉인·approved
    # 재오픈 전부 포함, ads_boost.py::sealed_ads_boost_version_id와 동형). 이 값이
    # publication_command의 approved_version으로 쓰인다.
    gate.sealed_newsletter_version_id = uuid.uuid4()

    await db.flush()
    return gate
