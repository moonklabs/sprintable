"""story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송
명령 요청+실행. ads_boost_execution.py(story #3806)와 동형 위임 패턴 — 단
newsletter_send는 pause/resume 같은 토글이 없는 1회성 명령(OP_BOOST_START와
동형, toggle_seq는 항상 0)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_connection import ChannelConnection
from app.models.channel_publication import ChannelPublication
from app.models.gate import Gate
from app.models.publication_command import PublicationCommand
from app.services.publication_command import create_or_get_publication_command

_NEWSLETTER_SEND_GATE_TYPE = "newsletter_send"
_NEWSLETTER_SEND_CONTENT_KIND = "newsletter_send"
OP_SEND = "send"
_SANDBOX_CHANNEL = "stibee_sandbox"


class NewsletterSendAdapterUnavailableError(Exception):
    """ads_boost_execution.py::AdsBoostAdapterUnavailableError와 동형 — 실행 재검증
    실패는 전부 이 예외 하나로 모아 호출부가 STATUS_BLOCKED_UNAPPROVED로 접는다."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


async def request_newsletter_send_command(
    db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID, requester_member_id: uuid.UUID,
) -> PublicationCommand:
    gate = (await db.execute(select(Gate).where(Gate.id == gate_id))).scalar_one_or_none()
    if gate is None or gate.org_id != org_id or gate.gate_type != _NEWSLETTER_SEND_GATE_TYPE:
        raise NewsletterSendAdapterUnavailableError("NEWSLETTER_SEND_GATE_MISSING", f"gate not found: {gate_id}")
    if gate.status != "approved":
        raise NewsletterSendAdapterUnavailableError(
            "NEWSLETTER_SEND_GATE_NOT_APPROVED", f"gate not approved (status={gate.status}): {gate.id}",
        )

    publication = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == uuid.UUID(gate.scope_key))
    )).scalar_one_or_none()
    if publication is None:
        raise NewsletterSendAdapterUnavailableError(
            "NEWSLETTER_SEND_PUBLICATION_MISSING", f"publication missing: {gate.scope_key}",
        )

    command, _ = await create_or_get_publication_command(
        db, org_id=org_id, gate_id=gate.id, destination=publication.connection_id,
        approved_version=gate.sealed_newsletter_version_id, requested_by_member_id=requester_member_id,
        scheduled_at=gate.sealed_newsletter_scheduled_at, operation=OP_SEND,
        content_kind=_NEWSLETTER_SEND_CONTENT_KIND, toggle_seq=0,
    )
    await db.commit()
    return command


_DUE_SENDS_BATCH_SIZE = 50


async def process_due_newsletter_sends(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """`sealed_newsletter_scheduled_at`이 도래한 승인 게이트를 찾아
    `request_newsletter_send_command`를 자동 호출한다 — ads_boost_execution.py::
    process_due_ads_boost_starts와 동형 패턴(SKIP LOCKED 대신 gate별 개별 트랜잭션+
    자체 upsert 멱등). 「이미 큐에 넣었나」 판별은 AdsBoostRun류 별도 run 테이블이
    없어(newsletter_send은 1회성이라 run 개념 자체가 불요) 같은 gate_id의 send
    명령 존재 여부로 가른다."""
    now = now or datetime.now(timezone.utc)
    rows = (await db.execute(
        select(Gate.id, Gate.org_id, Gate.resolver_id)
        .where(
            Gate.gate_type == _NEWSLETTER_SEND_GATE_TYPE,
            Gate.status == "approved",
            Gate.sealed_newsletter_scheduled_at.isnot(None),
            Gate.sealed_newsletter_scheduled_at <= now,
            ~select(PublicationCommand.id).where(
                PublicationCommand.gate_id == Gate.id, PublicationCommand.operation == OP_SEND,
            ).exists(),
        )
        .order_by(Gate.sealed_newsletter_scheduled_at.asc())
        .limit(_DUE_SENDS_BATCH_SIZE)
    )).all()

    counts = {"queued": 0, "error": 0}
    for gate_id, org_id, resolver_id in rows:
        if resolver_id is None:
            # 승인됐는데 resolver_id가 없는 상태는 이론상 불가(approve 경로가 항상
            # 채운다) — 지어내지 않고 이 건만 건너뛴다(카운트로 드러남, 침묵 금지).
            counts["error"] += 1
            continue
        try:
            await request_newsletter_send_command(
                db, org_id=org_id, gate_id=gate_id, requester_member_id=resolver_id,
            )
            counts["queued"] += 1
        except Exception:
            await db.rollback()
            counts["error"] += 1
    return counts


async def _resolve_execution_context(db: AsyncSession, command: PublicationCommand) -> dict:
    """ads_boost_execution.py::_resolve_execution_context와 동형 재검증(요청 시점과
    워커 pickup 시점 사이 게이트가 재오픈될 수 있다)."""
    gate = (await db.execute(select(Gate).where(Gate.id == command.gate_id))).scalar_one_or_none()
    if gate is None or gate.gate_type != _NEWSLETTER_SEND_GATE_TYPE:
        raise NewsletterSendAdapterUnavailableError(
            "NEWSLETTER_SEND_GATE_MISSING", f"gate not found: {command.gate_id}",
        )
    if gate.status != "approved":
        raise NewsletterSendAdapterUnavailableError(
            "NEWSLETTER_SEND_GATE_NOT_APPROVED", f"gate no longer approved (status={gate.status}): {gate.id}",
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
        raise NewsletterSendAdapterUnavailableError(
            "NEWSLETTER_SEND_CAMPAIGN_MISSING", f"campaign publication missing: {gate.scope_key}",
        )

    conn = (await db.execute(
        select(ChannelConnection).where(ChannelConnection.id == publication.connection_id)
    )).scalar_one_or_none()
    if conn is None or conn.status != "active":
        raise NewsletterSendAdapterUnavailableError(
            "NEWSLETTER_SEND_CONNECTION_UNAVAILABLE", f"connection unavailable: {publication.connection_id}",
        )

    return {"gate": gate, "publication": publication, "connection": conn}


# story #3806(Phase3·3-2 PR13) — activity log 관례 재사용(GATE_ACTIVITY_LABEL_KEY와
# 1:1 대응, FE PR4가 이 action 키를 쓸 자리).
_ACTIVITY_ACTION_SEND_SUCCEEDED = "newsletter_send_succeeded"
_ACTIVITY_ACTION_SEND_FAILED = "newsletter_send_failed"


async def process_one_newsletter_send_command(db: AsyncSession, command: PublicationCommand, *, now: datetime) -> None:
    """`publication_command.py::_process_one_command`의 content_kind==
    "newsletter_send" 분기가 이 함수로 위임(ads_boost 동형 패턴).

    story #3813 PR5-b(페드루 PO 確定 2026-09-12) — 실 stibee 발송(`stibee_client.
    reserve_email`) 착지(PR2가 "이 PR 범위 밖"이라 미뤘던 자리). `stibee_sandbox`
    는 기존 고정 미러 그대로(회귀 0), 그 둘 외의 채널은 여전히 fail-closed
    (newsletter_send gate 자체가 stibee류에만 나므로 실전 도달 0, 방어선만 유지)."""
    from app.services.activity_log import ActivityLogService
    from app.services.publication_command import (
        STATUS_BLOCKED_UNAPPROVED,
        apply_command_failure,
        record_publication_attempt,
    )

    attempt_started_at = now
    try:
        ctx = await _resolve_execution_context(db, command)
    except NewsletterSendAdapterUnavailableError as exc:
        await record_publication_attempt(
            db, command=command,
            approval_check="missing" if exc.code == "NEWSLETTER_SEND_GATE_NOT_APPROVED" else "ok",
            adapter_called=False, started_at=attempt_started_at, finished_at=now, result_code=None,
        )
        command.status = STATUS_BLOCKED_UNAPPROVED
        command.last_error = str(exc)[:2000]
        return

    gate, publication, conn = ctx["gate"], ctx["publication"], ctx["connection"]

    if conn.channel == _SANDBOX_CHANNEL:
        await _process_sandbox_send(db, command, gate=gate, publication=publication, now=now)
        return
    if conn.channel == "stibee":
        await _process_real_send(db, command, gate=gate, publication=publication, connection=conn, now=now)
        return

    # story #3813 — newsletter_send 게이트는 stibee/stibee_sandbox에만 나는데(다른
    # 채널로 이 명령이 온다는 건 어딘가 오배선), 조용히 완료 처리하지 않고 명시
    # 실패시킨다(기존 채널 오분기 사고 클래스와 동형 fail-closed).
    await record_publication_attempt(
        db, command=command, approval_check="ok", adapter_called=False,
        started_at=attempt_started_at, finished_at=now, result_code="NEWSLETTER_SEND_CHANNEL_UNSUPPORTED",
    )
    await apply_command_failure(
        db, command, error_code="NEWSLETTER_SEND_CHANNEL_UNSUPPORTED",
        last_error=f"newsletter_send에 배선되지 않은 채널입니다(channel={conn.channel!r})", now=now,
    )


async def _process_sandbox_send(db: AsyncSession, command: PublicationCommand, *, gate: Gate, publication: ChannelPublication, now: datetime) -> None:
    from app.services.activity_log import ActivityLogService
    from app.services.publication_command import apply_command_failure, record_publication_attempt
    from app.services.stibee_sandbox_campaign import StibeeSandboxSendError, send_campaign

    try:
        result = await send_campaign(
            campaign_id=publication.external_id, segment_name=gate.sealed_newsletter_segment_name or "",
        )
    except StibeeSandboxSendError as exc:
        await record_publication_attempt(
            db, command=command, approval_check="ok", adapter_called=True,
            started_at=now, finished_at=now, result_code="NEWSLETTER_SEND_PROVIDER_ERROR",
        )
        await apply_command_failure(
            db, command, error_code="NEWSLETTER_SEND_PROVIDER_ERROR", last_error=exc.message, now=now,
        )
        await ActivityLogService(db).record(
            org_id=command.org_id, action=_ACTIVITY_ACTION_SEND_FAILED, actor_id=command.requested_by_member_id,
            actor_type="agent", entity_type="gate", entity_id=gate.id, context={"error": exc.message},
        )
        return

    await record_publication_attempt(
        db, command=command, approval_check="ok", adapter_called=True,
        started_at=now, finished_at=now, result_code="ok",
    )
    command.status = "completed"
    await ActivityLogService(db).record(
        org_id=command.org_id, action=_ACTIVITY_ACTION_SEND_SUCCEEDED, actor_id=command.requested_by_member_id,
        actor_type="agent", entity_type="gate", entity_id=gate.id,
        context={"recipient_count": result["recipient_count"], "segment_name": result["segment_name_confirmed"]},
    )
    await _schedule_snapshots(db, command=command, gate=gate, publication=publication, channel="stibee_sandbox", now=now)


async def _process_real_send(
    db: AsyncSession, command: PublicationCommand, *, gate: Gate, publication: ChannelPublication,
    connection: ChannelConnection, now: datetime,
) -> None:
    """story #3813 PR5-b — 봉인 시각이 항상 있으므로 `reserve_email`만 부른다
    (`send_now`류 즉시발송은 안 쓴다, PO 明示). 요금제 부족·발신자 미인증은
    create_container와 같은 축(둘 다 400+바디 code로 구분, 그라운딩 확認: "요금제
    부족은 reserve에도 동일하게 걸린다") — `StibeeApiError`의 `.is_plan_restricted`
    로 연결 상태도 같이 승격한다(사람이 스티비 요금제를 올려야 풀린다는 신호)."""
    from app.services.activity_log import ActivityLogService
    from app.services.channel_connection import apply_connection_failure, decrypt_for_use
    from app.services.publication_command import apply_command_failure, record_publication_attempt
    from app.services.stibee_client import StibeeApiError, reserve_email

    access_token = decrypt_for_use(connection)
    if access_token is None or gate.sealed_newsletter_scheduled_at is None or not publication.external_id:
        await record_publication_attempt(
            db, command=command, approval_check="ok", adapter_called=False,
            started_at=now, finished_at=now, result_code="NEWSLETTER_SEND_CONNECTION_UNAVAILABLE",
        )
        await apply_command_failure(
            db, command, error_code="NEWSLETTER_SEND_CONNECTION_UNAVAILABLE",
            last_error="연결·봉인 시각·캠페인 id 중 하나가 없습니다", now=now,
        )
        return

    try:
        import httpx

        async with httpx.AsyncClient(timeout=20) as client:
            await reserve_email(
                client, api_key=access_token, email_id=int(publication.external_id),
                scheduled_at_utc=gate.sealed_newsletter_scheduled_at,
            )
    except StibeeApiError as exc:
        error_code = "STIBEE_PLAN_RESTRICTED" if exc.is_plan_restricted else "NEWSLETTER_SEND_PROVIDER_ERROR"
        await record_publication_attempt(
            db, command=command, approval_check="ok", adapter_called=True,
            started_at=now, finished_at=now, result_code=error_code,
        )
        await apply_command_failure(db, command, error_code=error_code, last_error=str(exc)[:2000], now=now)
        if exc.is_plan_restricted:
            await apply_connection_failure(
                db, connection=connection, status="error", error_message=str(exc)[:2000],
                error_code="STIBEE_PLAN_RESTRICTED",
            )
        await ActivityLogService(db).record(
            org_id=command.org_id, action=_ACTIVITY_ACTION_SEND_FAILED, actor_id=command.requested_by_member_id,
            actor_type="agent", entity_type="gate", entity_id=gate.id, context={"error": str(exc)[:2000]},
        )
        return

    await record_publication_attempt(
        db, command=command, approval_check="ok", adapter_called=True,
        started_at=now, finished_at=now, result_code="ok",
    )
    command.status = "completed"
    await ActivityLogService(db).record(
        org_id=command.org_id, action=_ACTIVITY_ACTION_SEND_SUCCEEDED, actor_id=command.requested_by_member_id,
        actor_type="agent", entity_type="gate", entity_id=gate.id,
        # story #3813 PR5-b — 실 reserve는 sandbox의 send_campaign과 달리 수신자 수를
        # 동기 반환하지 않는다(예약만 걸 뿐, 실 발송은 스티비 쪽에서 나중에 일어난다)
        # — recipient_count를 지어내지 않고 None(키는 유지해 sandbox와 같은 스키마).
        context={"recipient_count": None, "segment_name": gate.sealed_newsletter_segment_name},
    )
    await _schedule_snapshots(db, command=command, gate=gate, publication=publication, channel="stibee", now=now)


async def _schedule_snapshots(
    db: AsyncSession, *, command: PublicationCommand, gate: Gate, publication: ChannelPublication,
    channel: str, now: datetime,
) -> None:
    # story #3813(Phase3·3-4 PR3, 페드루 PO 確定 2026-09-12) — 발송 결과(opens/
    # delivered) 캡처. channel_posts.py:1770 부근 발행 콜백과 같은 함수를 같은
    # 모양으로 부르되, 앵커는 «발송 완료 시각»(now) — 이 채널은 그 콜백에서
    # 의도적으로 제외돼 있다(발행≠발송 시각 구분, 위 채널_posts.py 주석 참고).
    # 새 예약 기전 0(기존 1d/7d 관례 재사용) — ads_spend_snapshots의 이어예약
    # 기전은 복제 안 함(뉴스레터는 1회성 이벤트, PO 明示).
    from app.services.insight_snapshots import schedule_insight_snapshots

    await schedule_insight_snapshots(
        db, org_id=command.org_id, work_item_id=gate.work_item_id, publication_id=publication.id,
        publication_kind="channel_publication", channel=channel,
        external_id=publication.external_id, anchor_at=now,
    )
