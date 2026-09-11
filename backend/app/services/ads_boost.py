"""story #3806(Phase3·3-2 PR2, 페드루 PO 確定 2026-09-11) — Meta Ads boost 요청.
승인된 발행물(현재는 `ChannelPublication`만 — hosted_site/blog는 boost 대상이 아니다,
그라운딩 확認)에 총예산·통화·기간·목표를 실어 `ads_boost` 게이트를 연다.

## 「변경=재승인」 규칙(카드 PO 確定, 3367 봉인 규칙 동형)
같은 publication에 이 함수를 다시 부르면(work_item_id가 같아 create_gate가 기존
게이트를 그대로 반환하는 멱등 경로):
- 게이트가 아직 `pending`이면 — 그대로 재봉인(값만 덮어씀, 상태 전이 없음).
- 게이트가 `approved`였으면 — `pending`으로 재오픈 + `reapproval_required=True` +
  그 게이트에 걸린 대기 중(pending) 명령 voided(channel_posts.py::submit·
  doc.py::_reseal_concept_approval_gate_on_doc_update와 동형 3단 조합).
- **예외**: 새 예산이 기존 봉인 예산보다 크면(증액) — 위 재봉인/재오픈 전부를 타지
  않고 `AdsBudgetExceedsSealError` 즉시 raise(422 `ADS_BUDGET_EXCEEDS_SEAL`, 봉인값
  무변경). 블루프린트 §7 Phase 3 AC 본문 "자동 증액 불가"가 봉인 규칙보다 우선하는
  별도 축이라는 판단(PO 재확認 대상 — 이 해석이 카드 문면의 유일한 자기일관 독법이라
  판단해 착수, 다르면 정정 요청)."""
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

_ADS_BOOST_GATE_TYPE = "ads_boost"
_VOID_REASON_ADS_BOOST_CHANGED = "ADS_BOOST_TERMS_CHANGED"


class AdsBoostPublicationNotFoundError(Exception):
    """story #3796(insight_snapshots.py::resolve_publication_org_id)와 동형 원칙 —
    애초에 미존재·타 org 소유 둘 다 이 예외 하나(존재 자체 비노출, 라우터가 동일
    404로 접는다)."""

    def __init__(self, publication_id: uuid.UUID):
        # 영문 고정 — 개발자 대상 내부 진단(사용자 비노출, 라우터가 i18n_catalog로
        # 재번역해 응답). verify_no_new_korean_user_strings.py 가드가 app/ 전체를
        # 스캔하므로 여기 한글을 쓰면 그 가드 자체에 걸린다(i18n_catalog.py 모듈
        # docstring과 같은 이유).
        self.publication_id = publication_id
        super().__init__(f"publication not found in this org: {publication_id}")


class AdsBoostApproverRoleMissingError(Exception):
    """channel_posts.py::ChannelPostApproverRoleMissingError와 동형 — org에 기본
    승인자 역할이 없으면 게이트를 열 수 없다."""

    def __init__(self, org_id: uuid.UUID):
        # 영문 고정 — 위 AdsBoostPublicationNotFoundError와 동일 이유(내부 진단 전용).
        self.org_id = org_id
        super().__init__(f"org has no default approver role: {org_id}")


class AdsBudgetExceedsSealError(Exception):
    """모듈 docstring 「예외」절 — 기존 봉인 예산보다 큰 값으로 재요청하면 봉인을
    절대 안 건드리고 여기서 멈춘다(자동 증액 경로 0)."""

    def __init__(self, *, gate_id: uuid.UUID, sealed_budget_minor: int, requested_budget_minor: int):
        # 영문 고정 — 위 두 예외와 동일 이유(내부 진단 전용, 사용자 문장은
        # 라우터가 i18n_catalog["ads_boost.budget_exceeds_seal"]로 별도 구성).
        self.gate_id = gate_id
        self.sealed_budget_minor = sealed_budget_minor
        self.requested_budget_minor = requested_budget_minor
        super().__init__(
            f"requested budget ({requested_budget_minor}) exceeds sealed budget "
            f"({sealed_budget_minor}) — increase not supported (gate_id={gate_id})."
        )


async def _resolve_publication_and_work_item(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID,
) -> tuple[ChannelPublication, uuid.UUID]:
    """publication_id → (ChannelPublication 행, work_item_id). #3796과 같은 소유
    가름선(org_id 불일치=존재 비노출 404) — 단 이 함수는 폴리모픽이 아니다(hosted_
    site/SitePost는 boost 대상이 아니므로 그 갈래를 아예 열지 않는다, 그라운딩 明示)."""
    publication = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == publication_id)
    )).scalar_one_or_none()
    if publication is None or publication.org_id != org_id:
        raise AdsBoostPublicationNotFoundError(publication_id)

    draft_id = (await db.execute(
        select(ChannelPostVersion.draft_id).where(ChannelPostVersion.id == publication.version_id)
    )).scalar_one_or_none()
    work_item_id = None
    if draft_id is not None:
        work_item_id = (await db.execute(
            select(ChannelPostDraft.work_item_id).where(ChannelPostDraft.id == draft_id)
        )).scalar_one_or_none()
    if work_item_id is None:
        # 이론상 FK가 있어 항상 있어야 하지만(draft_id/work_item_id 둘 다 NOT NULL),
        # 지어내지 않고 같은 not-found로 접는다 — 「이 발행물의 근거 work item을
        # 못 찾았다」도 결국 boost 대상으로 못 쓴다는 사실은 같다.
        raise AdsBoostPublicationNotFoundError(publication_id)
    return publication, work_item_id


async def request_ads_boost(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, budget_minor: int, currency: str,
    starts_at: datetime, ends_at: datetime, objective: str, requester_member_id: uuid.UUID,
) -> Gate:
    publication, work_item_id = await _resolve_publication_and_work_item(
        db, org_id=org_id, publication_id=publication_id,
    )

    role_id = await _default_role_id(db, org_id)
    if role_id is None:
        raise AdsBoostApproverRoleMissingError(org_id)

    # scope_key: story #3478(0328) 관례 — publication_id로 스코프해 같은 work_item의
    # 서로 다른 발행물(예: 여러 채널에 각각 발행된 경우)이 독립 ads_boost 게이트를
    # 갖는다(external_publish의 connection_id 스코프와 동형 이유).
    gate = await create_gate(
        db, org_id, work_item_id, "story", _ADS_BOOST_GATE_TYPE,
        requester_member_id, role_id, scope_key=str(publication_id),
    )

    now = datetime.now(timezone.utc)
    # 「이 게이트가 이전에 한 번이라도 봉인된 적 있나」 — sealed_ads_budget_minor
    # 자체가 유일하게 믿을 신호다(gate.status는 이 함수 호출 前에 이미 pending/
    # approved/rejected 등 다양할 수 있어 "fresh"의 판별원이 못 된다).
    is_fresh = gate.sealed_ads_budget_minor is None
    if not is_fresh and budget_minor > gate.sealed_ads_budget_minor:
        raise AdsBudgetExceedsSealError(
            gate_id=gate.id, sealed_budget_minor=gate.sealed_ads_budget_minor or 0,
            requested_budget_minor=budget_minor,
        )

    was_approved = gate.status == "approved"
    if gate.status != "pending":
        set_gate_status(gate, "pending", now=now)
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
    if was_approved:
        gate.reapproval_required = True
        await void_pending_commands_for_gate(db, gate_id=gate.id, reason_code=_VOID_REASON_ADS_BOOST_CHANGED)
    else:
        gate.reapproval_required = False

    gate.sealed_ads_budget_minor = budget_minor
    gate.sealed_ads_currency = currency
    gate.sealed_ads_starts_at = starts_at
    gate.sealed_ads_ends_at = ends_at
    gate.sealed_ads_objective = objective

    await db.flush()
    return gate
