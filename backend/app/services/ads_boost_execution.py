"""story #3806(Phase3·3-2 PR3, 페드루 PO 確定 2026-09-11) — 승인된 `ads_boost` 게이트의
실행·중지·재개. `publication_command` 원장을 재사용(블루프린트 §3 패턴 그대로) —
`destination=gate.sealed_ads_connection_id`(PR 2가 봉인한 광고 계정) ·
`approved_version=gate.sealed_ads_boost_version_id`(PR 2가 매 재봉인마다 새로 발급한
값, 3367 sealed_content_version 동형 질문에 대한 페드루 「PR 2 실물에 맞춰」 답) ·
`content_kind="ads_boost"`(0364 마이그가 CHECK에 추가) · `operation ∈
{"boost_start","pause","resume"}`.

## 「토글」 설계(페드루 PO 追加 確定, PR 3 착수 직후 — 0364 마이그 docstring과 동형)
`boost_start`는 `site_posts.py`의 publish/unpublish와 동형 1회성 — 그 승인주기
(=그 approved_version)당 정확히 한 번, `toggle_seq=0` 고정.

`pause`/`resume`은 같은 승인주기 안에서 여러 번 토글될 수 있어(중지→재개→중지…)
`toggle_seq`로 "그 승인주기의 N번째 토글"을 구분한다(`_resolve_toggle_seq`).
3-way 판정(페드루 핀 2건 + 이 PR의 追加 해석 1건 — 뒤엣것은 PR 본문에 판단 콜로
명시):
  - 직전 토글 행이 없다 → `pause`는 허용(기본 상태=running에서 전이), `resume`은
    거부(되돌아갈 paused 상태 자체가 없다, `AdsBoostNotPausedError`).
  - 직전 토글 행의 operation이 이번 요청과 **같고** 아직 비종결(pending/
    in_progress/blocked) → 더블클릭으로 판정, **같은 행을 재사용**(페드루 핀:
    「pause 더블클릭 = 행 1·호출 1」).
  - 직전 토글 행의 operation이 이번 요청과 같고 이미 **종결**(completed) → 이미 그
    상태다(재실행 무의미) → 거부(`AdsBoostAlreadyInStateError`, 페드루 핀 밖의
    追加 해석 — "이미 pause 완료된 걸 또 pause"는 하는 것과 "pending 중인 걸
    또 pause"는 달라야 한다는 판단, 다르면 정정 요청).
  - 직전 토글 행의 operation이 이번 요청과 다르다(또는 종결됐고 반대 op) → 새
    토글(`toggle_seq = 직전+1`, 페드루 핀: 「pause→resume→pause = 행 3」)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.publication_command import PublicationCommand
from app.services.publication_command import create_or_get_publication_command

_ADS_BOOST_GATE_TYPE = "ads_boost"
_ADS_BOOST_CONTENT_KIND = "ads_boost"
_NON_TERMINAL_STATUSES = ("pending", "in_progress", "blocked")

OP_BOOST_START = "boost_start"
OP_PAUSE = "pause"
OP_RESUME = "resume"


class AdsBoostGateNotFoundError(Exception):
    """존재 자체 비노출(publication_id 404와 동형 원칙) — 미존재·타 org 소유·
    gate_type이 ads_boost가 아님 셋 다 이 예외 하나로 접는다."""

    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"ads_boost gate not found in this org: {gate_id}")


class AdsBoostGateNotApprovedError(Exception):
    """승인 전(또는 재승인 대기 중)인 게이트는 실행·중지·재개 전부 막는다 —
    「봉인=실행 허가」가 아니라 「승인=실행 허가」."""

    def __init__(self, gate_id: uuid.UUID, status: str):
        self.gate_id = gate_id
        self.status = status
        super().__init__(f"ads_boost gate not approved (status={status}): {gate_id}")


class AdsBoostNotStartedError(Exception):
    """boost_start 행이 아예 없는데 pause를 요청 — 시작한 적 없는 걸 중지할 수 없다."""

    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"ads_boost not started yet, cannot pause: {gate_id}")


class AdsBoostNotPausedError(Exception):
    """되돌아갈 paused 상태가 없는데 resume을 요청(토글 이력 0 또는 최신 토글이 pause가
    아님)."""

    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"ads_boost is not paused, cannot resume: {gate_id}")


class AdsBoostAlreadyInStateError(Exception):
    """직전 토글이 이미 종결(completed) 상태로 같은 operation을 재요청 — 더블클릭
    (비종결 재사용)과 구분되는 별도 거부."""

    def __init__(self, gate_id: uuid.UUID, operation: str):
        self.gate_id = gate_id
        self.operation = operation
        super().__init__(f"ads_boost already in requested state (operation={operation}): {gate_id}")


async def _resolve_gate(db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID) -> Gate:
    gate = (await db.execute(select(Gate).where(Gate.id == gate_id))).scalar_one_or_none()
    if gate is None or gate.org_id != org_id or gate.gate_type != _ADS_BOOST_GATE_TYPE:
        raise AdsBoostGateNotFoundError(gate_id)
    if gate.status != "approved":
        raise AdsBoostGateNotApprovedError(gate_id, gate.status)
    return gate


async def _latest_toggle(
    db: AsyncSession, *, org_id: uuid.UUID, destination: uuid.UUID, approved_version: uuid.UUID,
) -> PublicationCommand | None:
    return (await db.execute(
        select(PublicationCommand)
        .where(
            PublicationCommand.org_id == org_id,
            PublicationCommand.destination == destination,
            PublicationCommand.approved_version == approved_version,
            PublicationCommand.operation.in_((OP_PAUSE, OP_RESUME)),
        )
        .order_by(PublicationCommand.toggle_seq.desc())
        .limit(1)
    )).scalar_one_or_none()


async def request_ads_boost_start(
    db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID, requester_member_id: uuid.UUID,
) -> PublicationCommand:
    gate = await _resolve_gate(db, org_id=org_id, gate_id=gate_id)
    command, _ = await create_or_get_publication_command(
        db, org_id=org_id, gate_id=gate.id, destination=gate.sealed_ads_connection_id,
        approved_version=gate.sealed_ads_boost_version_id, requested_by_member_id=requester_member_id,
        scheduled_at=None, operation=OP_BOOST_START, content_kind=_ADS_BOOST_CONTENT_KIND, toggle_seq=0,
    )
    await db.commit()
    return command


async def _request_toggle(
    db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID, requester_member_id: uuid.UUID,
    operation: str,
) -> PublicationCommand:
    gate = await _resolve_gate(db, org_id=org_id, gate_id=gate_id)
    destination = gate.sealed_ads_connection_id
    approved_version = gate.sealed_ads_boost_version_id

    started = (await db.execute(
        select(PublicationCommand.id).where(
            PublicationCommand.org_id == org_id,
            PublicationCommand.destination == destination,
            PublicationCommand.approved_version == approved_version,
            PublicationCommand.operation == OP_BOOST_START,
        )
    )).scalar_one_or_none()
    if started is None:
        raise AdsBoostNotStartedError(gate.id)

    latest = await _latest_toggle(db, org_id=org_id, destination=destination, approved_version=approved_version)

    if latest is None:
        if operation == OP_RESUME:
            raise AdsBoostNotPausedError(gate.id)
        toggle_seq = 1
    elif latest.operation == operation:
        if latest.status in _NON_TERMINAL_STATUSES:
            toggle_seq = latest.toggle_seq  # 더블클릭 — 같은 행 재사용
        else:
            raise AdsBoostAlreadyInStateError(gate.id, operation)
    else:
        if operation == OP_RESUME and latest.operation != OP_PAUSE:
            raise AdsBoostNotPausedError(gate.id)
        toggle_seq = latest.toggle_seq + 1

    command, _ = await create_or_get_publication_command(
        db, org_id=org_id, gate_id=gate.id, destination=destination, approved_version=approved_version,
        requested_by_member_id=requester_member_id, scheduled_at=None, operation=operation,
        content_kind=_ADS_BOOST_CONTENT_KIND, toggle_seq=toggle_seq,
    )
    await db.commit()
    return command


async def request_ads_boost_pause(
    db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID, requester_member_id: uuid.UUID,
) -> PublicationCommand:
    return await _request_toggle(
        db, org_id=org_id, gate_id=gate_id, requester_member_id=requester_member_id, operation=OP_PAUSE,
    )


async def request_ads_boost_resume(
    db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID, requester_member_id: uuid.UUID,
) -> PublicationCommand:
    return await _request_toggle(
        db, org_id=org_id, gate_id=gate_id, requester_member_id=requester_member_id, operation=OP_RESUME,
    )
