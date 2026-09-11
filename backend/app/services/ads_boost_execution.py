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


class AdsBoostAdapterUnavailableError(Exception):
    """워커 실행 시점 재검증 실패 — 게이트가 더는 approved가 아니거나(재오픈됨) ·
    광고 계정 연결이 사라졌거나 active가 아니거나 · 원 발행물을 못 찾음(전부 워커
    자리에서 아예 캠페인 API를 호출하지 않는 「재시도 개념 자체가 안 맞는」 종류,
    site_posts.py::SitePostReapprovalRequiredError류와 동형 판단)."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


async def _resolve_execution_context(db: AsyncSession, command: PublicationCommand) -> dict:
    """워커 처리 직전 재검증 + 실행에 필요한 모든 것을 한 번에 모은다 — gate.status
    재확認(요청 시점과 워커 pickup 시점 사이 재오픈될 수 있다, publish_channel_
    post_draft류 재검증 관례와 동형) · 광고 계정 connection(active) · 원 발행물의
    object_story_id(Meta Page post ad 필수 재료, PR 2 그라운딩 ⑤)."""
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_credential_crypto import decrypt_channel_credential

    gate = (await db.execute(select(Gate).where(Gate.id == command.gate_id))).scalar_one_or_none()
    if gate is None or gate.gate_type != _ADS_BOOST_GATE_TYPE:
        raise AdsBoostAdapterUnavailableError("ADS_BOOST_GATE_MISSING", f"gate not found: {command.gate_id}")
    if gate.status != "approved":
        raise AdsBoostAdapterUnavailableError(
            "ADS_BOOST_GATE_NOT_APPROVED", f"gate no longer approved (status={gate.status}): {gate.id}",
        )

    conn = (await db.execute(
        select(ChannelConnection).where(ChannelConnection.id == gate.sealed_ads_connection_id)
    )).scalar_one_or_none()
    if conn is None or conn.status != "active":
        raise AdsBoostAdapterUnavailableError(
            "ADS_BOOST_CONNECTION_UNAVAILABLE", f"ad connection unavailable: {gate.sealed_ads_connection_id}",
        )

    publication = None
    if gate.scope_key:
        try:
            publication_id = uuid.UUID(gate.scope_key)
        except ValueError:
            publication_id = None
        if publication_id is not None:
            publication = (await db.execute(
                select(ChannelPublication).where(ChannelPublication.id == publication_id)
            )).scalar_one_or_none()
    if publication is None or not publication.external_id:
        raise AdsBoostAdapterUnavailableError(
            "ADS_BOOST_ORIGINAL_PUBLICATION_MISSING", f"original publication missing: {gate.scope_key}",
        )
    origin_conn = (await db.execute(
        select(ChannelConnection).where(ChannelConnection.id == publication.connection_id)
    )).scalar_one_or_none()
    if origin_conn is None:
        raise AdsBoostAdapterUnavailableError(
            "ADS_BOOST_ORIGIN_CONNECTION_MISSING", f"origin connection missing: {publication.connection_id}",
        )

    module_path = "app.services.ads_sandbox_campaign" if conn.channel == "ads_sandbox" else "app.services.meta_ads_campaign"
    import importlib
    module = importlib.import_module(module_path)

    return {
        "gate": gate, "module": module,
        "ad_account_id": conn.account_id, "access_token": decrypt_channel_credential(conn.encrypted_access_token),
        "object_story_id": f"{origin_conn.account_id}_{publication.external_id}",
    }


async def process_one_ads_boost_command(db: AsyncSession, command: PublicationCommand, *, now) -> None:
    """`app/services/publication_command.py::_process_one_command`의 content_kind==
    "ads_boost" 분기가 이 함수로 넘긴다(site_post/comment_reply와 동형 위임 패턴).
    실패 시 `apply_command_failure`(publication_command.py)를 그대로 재사용 —
    백오프·connection 승격 로직 재구현 금지."""
    from app.services.publication_command import (
        STATUS_BLOCKED_UNAPPROVED,
        apply_command_failure,
        record_publication_attempt,
    )

    attempt_started_at = now
    try:
        ctx = await _resolve_execution_context(db, command)
    except AdsBoostAdapterUnavailableError as exc:
        await record_publication_attempt(
            db, command=command, approval_check="missing" if exc.code == "ADS_BOOST_GATE_NOT_APPROVED" else "ok",
            adapter_called=False, started_at=attempt_started_at, finished_at=now, result_code=None,
        )
        command.status = STATUS_BLOCKED_UNAPPROVED
        command.last_error = str(exc)[:2000]
        return

    gate, module = ctx["gate"], ctx["module"]
    run = await _get_or_create_run(db, org_id=command.org_id, gate_id=gate.id)
    is_sandbox = getattr(module, "__name__", "").endswith("ads_sandbox_campaign")

    try:
        import httpx

        async with httpx.AsyncClient(timeout=20) as client:
            if command.operation == OP_BOOST_START:
                result = await module.create_boost_campaign(
                    client, ad_account_id=ctx["ad_account_id"], access_token=ctx["access_token"],
                    object_story_id=ctx["object_story_id"], budget_minor=gate.sealed_ads_budget_minor,
                    currency=gate.sealed_ads_currency, starts_at_iso=gate.sealed_ads_starts_at.isoformat(),
                    ends_at_iso=gate.sealed_ads_ends_at.isoformat(), objective=gate.sealed_ads_objective,
                )
                run.campaign_id, run.adset_id, run.ad_id = result["campaign_id"], result["adset_id"], result["ad_id"]
                await module.set_campaign_status(
                    client, campaign_id=run.campaign_id, access_token=ctx["access_token"], status="ACTIVE",
                )
                run.status = "running"
                run.started_at = now
            elif command.operation == OP_PAUSE:
                if run.campaign_id is None:
                    raise AdsBoostAdapterUnavailableError(
                        "ADS_BOOST_NOT_STARTED_AT_PROVIDER", f"no campaign_id yet: {gate.id}",
                    )
                await module.set_campaign_status(
                    client, campaign_id=run.campaign_id, access_token=ctx["access_token"], status="PAUSED",
                )
                # [sandbox:pause-delayed] — ads_sandbox_campaign.py 모듈 docstring
                # 참고. 그 마커가 objective에 있으면 "접수는 성공했지만 아직 반영
                # 안 됨"을 run.status에 그대로 반영한다(paused로 못 박지 않는다).
                if is_sandbox and "[sandbox:pause-delayed]" in (gate.sealed_ads_objective or ""):
                    run.status = "pause_pending"
                else:
                    run.status = "paused"
                    run.paused_at = now
            else:  # OP_RESUME
                if run.campaign_id is None:
                    raise AdsBoostAdapterUnavailableError(
                        "ADS_BOOST_NOT_STARTED_AT_PROVIDER", f"no campaign_id yet: {gate.id}",
                    )
                await module.set_campaign_status(
                    client, campaign_id=run.campaign_id, access_token=ctx["access_token"], status="ACTIVE",
                )
                run.status = "running"
                run.paused_at = None

        await record_publication_attempt(
            db, command=command, approval_check="ok", adapter_called=True,
            started_at=attempt_started_at, finished_at=now, result_code="completed",
        )
        command.status = "completed"
        command.last_error = None
        command.failure_kind = None
    except Exception as exc:  # noqa: BLE001 — publication_command.py 2중 방어와 동형.
        error_code = getattr(exc, "code", None) or "ADS_BOOST_PROVIDER_ERROR"
        last_error = getattr(exc, "message", None) or str(exc)
        run.last_error = last_error[:2000]
        await record_publication_attempt(
            db, command=command, approval_check="ok", adapter_called=True,
            started_at=attempt_started_at, finished_at=now, result_code=error_code,
        )
        await apply_command_failure(db, command, error_code=error_code, last_error=last_error, now=now)


async def _get_or_create_run(db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID):
    from app.models.ads_boost_run import AdsBoostRun

    run = (await db.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one_or_none()
    if run is not None:
        return run
    run = AdsBoostRun(id=uuid.uuid4(), org_id=org_id, gate_id=gate_id)
    db.add(run)
    await db.flush()
    return run
