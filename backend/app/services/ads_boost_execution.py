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

# publication_command.py::BATCH_SIZE·channel_post_comments.py::BATCH_SIZE와 동형 값
# (신규 상수 발명 0 — 그 둘을 import하면 이 모듈의 gate_type 무관 워커 배치와
# 우연히 같은 상수를 공유하게 돼 오히려 결합이 생긴다, 여기선 리터럴로 동형만).
_DUE_STARTS_BATCH_SIZE = 50


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


# story #3806(Phase3·3-2 PR 6, 페드루 PO 確定 2026-09-11 13:27Z) — 봉인 starts_at 자동
# 실행 워커. AC2 "[제품] 상한 내 실행"의 원래 뜻은 승인 뒤 `sealed_ads_starts_at`에
# 도달하면 제품이 자동으로 `request_ads_boost_start`를 부르는 것인데, PR3엔 그
# 자동발화 지점이 0건이었다(디디 실측·PO 콜①) — PR5가 사람이 누르는 「홍보 시작」
# 버튼(`start_ads_boost_endpoint`)으로 루프를 닫은 임시 지름길이었고, 이 워커가
# "안 눌렀을 때의 안전망"으로 겹쳐 놓는 진짜 자동화다.
#
# 멱등: `request_ads_boost_start`→`create_or_get_publication_command`가 이미 그
# 자체로 (org_id, destination, approved_version, operation="boost_start",
# toggle_seq=0) 키의 upsert라 두 번 불러도 새 command가 안 생긴다(먼저 된 사람
# 클릭과 겹쳐도 안전). 아래 SQL 필터(`ads_boost_runs` 행 부재)는 그 위에 얹는 효율
# 축 — `AdsBoostRun`은 실행 단계(`_process_one_command`의 ads_boost 분기)에서야
# 지연 생성되므로, 이미 실행까지 끝난 gate를 매 tick 재선택하지 않게 거른다(아직
# enqueue만 되고 실행 전인 gate는 이 필터를 통과해도 위 멱등 upsert가 안전망).
#
# requester_member_id = `gate.resolver_id`(그 게이트를 승인한 휴먼) — 이 코드베이스에
# "시스템/스케줄러 행위자" sentinel 관례가 없고 `PublicationCommand.requested_by_
# member_id`가 NOT NULL이라, "승인이 이미 이 실행을 허가했다"는 뜻으로 승인자
# 귀속이 유일하게 지어내지 않는 선택지다(worker는 승인된 gate만 골라 status=
# "approved" 조건상 resolver_id가 항상 채워져 있다).
async def process_due_ads_boost_starts(db: AsyncSession, *, now=None) -> dict[str, int]:
    """`sealed_ads_starts_at`이 도래한 승인 게이트를 찾아 `request_ads_boost_start`를
    자동 호출한다. `process_due_publication_commands`류 기존 due-date 워커와 동형
    패턴(SKIP LOCKED 배치)이나, 클레임 대상이 PublicationCommand가 아니라 Gate라
    "처리 중" 표시 컬럼이 없다 — 대신 각 건을 개별 트랜잭션(gate별 committed 여부가
    `request_ads_boost_start`의 자체 upsert로 이미 안전)으로 처리해 겹친 tick이
    있어도 중복 command가 안 생긴다(멱등이 배치 락 대신 이 축의 안전망)."""
    from datetime import datetime, timezone

    from app.models.ads_boost_run import AdsBoostRun

    now = now or datetime.now(timezone.utc)
    rows = (await db.execute(
        select(Gate.id, Gate.org_id, Gate.resolver_id)
        .where(
            Gate.gate_type == _ADS_BOOST_GATE_TYPE,
            Gate.status == "approved",
            Gate.sealed_ads_starts_at.isnot(None),
            Gate.sealed_ads_starts_at <= now,
            ~select(AdsBoostRun.id).where(AdsBoostRun.gate_id == Gate.id).exists(),
        )
        .order_by(Gate.sealed_ads_starts_at.asc())
        .limit(_DUE_STARTS_BATCH_SIZE)
    )).all()

    counts = {"started": 0, "error": 0}
    for gate_id, org_id, resolver_id in rows:
        if resolver_id is None:
            # 승인됐는데 resolver_id가 없는 상태는 이론상 불가(approve 경로가 항상
            # 채운다) — 지어내지 않고 이 건만 건너뛴다(카운트로 드러남, 침묵 금지).
            counts["error"] += 1
            continue
        try:
            await request_ads_boost_start(
                db, org_id=org_id, gate_id=gate_id, requester_member_id=resolver_id,
            )
            counts["started"] += 1
        except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError):
            # 이 tick과 다른 tick(또는 사람 클릭)이 경합해 그 사이 상태가 바뀐 경우
            # (예: 재봉인으로 pending 재오픈) — 그 자체가 이 워커의 실패가 아니다.
            counts["error"] += 1
        except Exception:  # noqa: BLE001 — publication_command.py의 배치 격리와 동형.
            await db.rollback()
            counts["error"] += 1
    return counts


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
        "publication_id": publication.id, "ad_channel": conn.channel,
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
                # story #3806(Phase3·3-2 PR4, 페드루 PO 確定 2026-09-11) — boost_start
                # 성공 즉시 paid 지출 +1d/+7d 스냅샷 예약(insight_snapshots.py의
                # publish 성공 시 스케줄링과 동형 시점 — "그 사건이 확정된 순간").
                from app.services.ads_spend_snapshots import schedule_ads_spend_snapshots

                await schedule_ads_spend_snapshots(
                    db, org_id=command.org_id, work_item_id=gate.work_item_id,
                    publication_id=ctx["publication_id"], channel=ctx["ad_channel"], anchor_at=now,
                )
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
