"""Shared webhook dispatch utility."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ssrf import validate_webhook_url_async
from app.models.webhook_config import WebhookConfig
# c60dd33c: Discord 페이로드 정규화 공용 헬퍼(채팅 경로와 단일화).
from app.services.discord_webhook import is_discord_url, to_discord_event_payload

logger = logging.getLogger(__name__)


def _build_signature_headers(secret: str | None, body: str) -> dict[str, str]:
    if not secret:
        return {}
    ts = str(int(time.time() * 1000))
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return {
        "X-Sprintable-Signature": f"sha256={sig}",
        "X-Sprintable-Timestamp": ts,
    }


async def fire_webhooks(
    session: AsyncSession,
    org_id: uuid.UUID,
    event: str,
    data: dict[str, Any],
    *,
    recipient_member_ids: set[uuid.UUID] | None = None,
    preserve_broadcast: bool = True,
    via_outbox: bool = False,
) -> None:
    """org webhook 발화 (c60dd33c).

    story #2460(§6 봉합②, PO 스코프 확定 2026-08-05): outbox 경유는 **opt-in**이다
    (``via_outbox=True``) — story_status_events.py 단 한 콜사이트만 켠다. 나머지 호출부
    (file_conflict·assignee_changed·workflow_violation 등)는 기본값 False로 기존과 동일하게
    이 함수 안에서 즉시 POST한다(behavior 무변경). ``via_outbox=True``면 즉시 POST 대신
    `delivery_jobs`에 job row만 insert(caller의 세션·트랜잭션에 그대로 실림 — commit은
    caller 책임, at-least-once) — 실제 HTTP 배달은 `delivery_dispatcher.py` 워커가 자기
    세션으로 `_fire_webhooks_now()`를 부른다(요청 트랜잭션 밖에서 외부 I/O)."""
    if via_outbox:
        from app.models.delivery_job import DeliveryJob

        session.add(
            DeliveryJob(
                org_id=org_id,
                kind="org_webhook",
                payload={
                    "event": event,
                    "data": data,
                    "recipient_member_ids": (
                        [str(m) for m in recipient_member_ids] if recipient_member_ids is not None else None
                    ),
                    "preserve_broadcast": preserve_broadcast,
                },
            )
        )
        return
    await _fire_webhooks_now(
        session, org_id, event, data,
        recipient_member_ids=recipient_member_ids, preserve_broadcast=preserve_broadcast,
    )


async def _fire_webhooks_now(
    session: AsyncSession,
    org_id: uuid.UUID,
    event: str,
    data: dict[str, Any],
    *,
    recipient_member_ids: set[uuid.UUID] | None = None,
    preserve_broadcast: bool = True,
) -> None:
    """org webhook 실배달(c60dd33c) — `delivery_dispatcher.py` 워커 전용, 자기 세션으로 호출.

    **Discord 정규화(AC1)**: discord URL 에는 raw envelope 대신 ``{content|embeds}`` 변환
    (``to_discord_event_payload``)을 보낸다 — 기존엔 raw envelope POST 라 discord 전원 400.
    채팅 경로(conversation_webhook)와 동일 헬퍼·동형 거동. routing/retry/status 는 불변.

    **타겟 게이팅(AC2·opt-in)**: ``recipient_member_ids`` 가 주어지면 member-bound webhook
    (``member_id`` != null)은 그 집합의 멤버만 수신해 story/activity 의 org-wide 과다 fan-out 을
    차단한다. ``member_id IS NULL`` 진짜 activity-feed 브로드캐스트는 ``preserve_broadcast`` 시
    보존. **``recipient_member_ids`` 가 None(기본)이면 게이팅 없음 = 기존 fan-out 동작**.

    story #2460 PO 리뷰(2026-08-05, F1) — 예전엔 이 함수가 ``session.execute`` 조회 直後
    같은 함수 안에서 httpx POST 루프를 돌았다. POST 자체는 session을 안 건드리지만, 호출자
    (`_deliver_one`)가 `async with async_session_factory() as session:` 로 세션을 물고
    이 함수를 부르는 구조라 **세션(커넥션)이 POST 루프 내내 idle-in-transaction으로 열려
    있었다** — 배달 中 트랜잭션을 안 잡는다는 docstring 계약과 실제가 어긋난 한 겹 얕은
    원본. `_fetch_webhook_targets`(세션 필요) / `_send_webhook_targets`(세션 불요, 순수
    httpx)로 쪼개 이 함수는 둘을 순차 호출하는 얇은 래퍼로 남긴다 — 기존 호출부
    (via_outbox=False 12+ 콜사이트)는 시그니처·거동 무변경. 워커는 이제 이 함수를 안 부르고
    fetch/send를 직접 호출해 그 사이에 세션을 반납한다(delivery_dispatcher.py 참조)."""
    targets = await _fetch_webhook_targets(
        session, org_id, event,
        recipient_member_ids=recipient_member_ids, preserve_broadcast=preserve_broadcast, event_data=data,
    )
    await _send_webhook_targets(targets, event, data, org_id)


async def _fetch_webhook_targets(
    session: AsyncSession,
    org_id: uuid.UUID,
    event: str,
    *,
    recipient_member_ids: set[uuid.UUID] | None = None,
    preserve_broadcast: bool = True,
    event_data: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """활성 WebhookConfig를 조회해 이벤트/타겟 게이팅까지 마친 순수 dict 리스트로 반환한다.

    story #4358 — 배달 시점에 설정 주인(`member_id`)의 **지금** 접근을 다시 본다(만들 때 확인한 것으로 끝나지 않게 · outbox는 쌓인 뒤
    배달까지 틈이 있어 여기서): 이벤트 데이터에 project_id가 있으면 주인이 그 프로젝트에 접근할 수 있어야 하고, 없으면(org 수준 이벤트)
    주인이 그 org의 활성 구성원이어야 한다. 막힌 설정은 보내지 않고 사유를 로그로 남긴다(조용히 사라지지 않게 · 설정은 건드리지 않음).
    세션 I/O는 이 함수에서 끝 — 반환 直後 호출자가 세션을 커밋/반납해야 한다(story #2460
    PO 리뷰 F1, 위 `_fire_webhooks_now` docstring 참조)."""
    result = await session.execute(
        select(
            WebhookConfig.url,
            WebhookConfig.secret,
            WebhookConfig.events,
            WebhookConfig.member_id,
        ).where(WebhookConfig.org_id == org_id, WebhookConfig.is_active.is_(True))
    )
    targets: list[dict[str, Any]] = []
    cache: dict = {}  # 주인별 판정(이 배달 한 번 안에서)
    for url, secret, events, member_id in result.all():
        if events and event not in events:
            continue
        # AC2 게이팅(opt-in): recipient_member_ids 주어진 경우만 적용. None=기존 동작.
        if recipient_member_ids is not None:
            if member_id is None:
                if not preserve_broadcast:
                    continue  # broadcast 인데 보존 끄면 drop
            elif member_id not in recipient_member_ids:
                continue  # member-bound 인데 관련자 아님 → drop(과다 fan-out 차단)
        if member_id is not None:
            reason = await _owner_block_reason(session, org_id, member_id, event_data, cache)
            if reason is not None:
                logger.warning(
                    "webhook.dispatch.blocked reason=%s org_id=%s member_id=%s event=%s", reason, org_id, member_id, event,
                )
                continue
        targets.append({"url": url, "secret": secret})
    return targets


def _event_project_id(event_data: dict[str, Any] | None) -> uuid.UUID | None:
    raw = (event_data or {}).get("project_id")
    try:
        return uuid.UUID(str(raw)) if raw else None
    except ValueError:
        return None


async def _owner_block_reason(
    session: AsyncSession, org_id: uuid.UUID, member_id: uuid.UUID, event_data: dict[str, Any] | None, cache: dict,
) -> str | None:
    """story #4358 — 설정 주인이 지금 이 이벤트를 받을 수 있는지. 받을 수 있으면 None, 아니면 막는 사유(로그용 · 고정 낱말).
    주인은 members 행(에이전트 · 사람) 또는 members 행 없는 사람(org_members id)일 수 있다 — 둘 다 본다. 모르면 막는다(fail-closed)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.services.project_auth import accessible_project_ids_in_org

    if member_id not in cache:
        identity: uuid.UUID | None = None
        active = False
        row = (await session.execute(
            select(Member.type, Member.user_id, Member.is_active, Member.deleted_at, Member.org_id).where(Member.id == member_id)
        )).first()
        if row is not None:
            mtype, user_id, is_active, deleted_at, m_org = row
            active = bool(is_active) and deleted_at is None and m_org == org_id
            identity = member_id if mtype == "agent" else user_id
        else:
            om = (await session.execute(
                select(OrgMember.user_id, OrgMember.deleted_at).where(OrgMember.id == member_id, OrgMember.org_id == org_id)
            )).first()
            if om is not None:
                active = om[1] is None
                identity = om[0]
        accessible = (
            set(await accessible_project_ids_in_org(session, identity, org_id)) if (active and identity is not None) else set()
        )
        cache[member_id] = (row is not None or identity is not None, active, accessible)
    known, active, accessible = cache[member_id]
    if not known:
        return "owner_not_found"
    if not active:
        return "owner_inactive"
    project_id = _event_project_id(event_data)
    if project_id is not None and project_id not in accessible:
        return "owner_no_project_access"
    return None


async def _send_webhook_targets(
    targets: list[dict[str, Any]], event: str, data: dict[str, Any], org_id: uuid.UUID | None = None,
) -> None:
    """세션 없이 순수 HTTP POST만(story #2460 PO 리뷰 F1) — SSRF 재검증도 이 자리(발송
    직전 재검증이 목적이라 fetch 단계로 옮기면 안 됨 — DNS rebinding 방지 의도가 죽는다).

    story #3173(결제②-B) — doc `pricing-policy-proposal-v1` §4.5 "성공한 외부 웹훅 전달 =
    전달 1건당 1 AU". `org_id`는 하위호환 위해 선택 인자(기존 호출부 무회귀) — None이면
    계측 생략(값을 지어내지 않음, 과소계상 방향 안전측). 계측은 기존 예외-삼킴 제어흐름을
    안 건드리고 완전 별도 try/except로 감싼다(fail-open, 계측 실패가 배달을 막으면 안 됨)."""
    if not targets:
        return
    envelope_body = json.dumps({"event": event, "data": data})
    discord_body = json.dumps(to_discord_event_payload(event, data))

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
        for t in targets:
            url, secret = t["url"], t["secret"]
            # dispatch 시 IP 재검증 (DNS rebinding 방지)
            try:
                await validate_webhook_url_async(url)
            except ValueError:
                continue
            if is_discord_url(url):
                # AC1: Discord 는 {content|embeds} 필수 + 서명 헤더 없음(채팅 경로와 동형).
                body = discord_body
                headers = {"Content-Type": "application/json"}
            else:
                body = envelope_body
                headers = {"Content-Type": "application/json", **_build_signature_headers(secret, body)}
            try:
                resp = await client.post(url, content=body, headers=headers)
            except Exception:
                continue
            if org_id is not None and 200 <= resp.status_code < 300:
                try:
                    from app.services.au_metering import record_au_usage

                    await record_au_usage(org_id, 1)
                except Exception:
                    logger.error("AU metering(webhook) failed org_id=%s", org_id, exc_info=True)


async def deliver_test_webhook(url: str, secret: str | None) -> tuple[bool, str | None]:
    """0a6487c6-BE: 단일 합성 'TEST' webhook 1발 → ``(reached, reason)``.

    사용자 제공 URL 이라 **SSRF 재검증 필수**(DNS rebinding). 실 알림 오인 방지 — event=``webhook.test``·
    ``label='TEST'`` 명시. Discord URL 은 ``{content|embeds}`` 로 정규화(c60dd33c·아니면 Discord 400).
    ``reached`` = 목적지 2xx 응답. fire_webhooks 의 서명/검증 경로와 동형(거동 불변).
    """
    from datetime import datetime, timezone
    data = {
        "label": "TEST",
        "message": "Sprintable 알림 목적지 연결 테스트 — 이 메시지가 보이면 정상 연결입니다.",
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await validate_webhook_url_async(url)
    except ValueError:
        return False, "unsafe or invalid url"
    if is_discord_url(url):
        # 범용 포매터는 event 명만 싣어(label 누락) TEST 임을 못 알림 — 자가진단용은 명시 TEST 문구.
        body = json.dumps({"content": f"🔔 **[TEST]** {data['message']}"})
        headers = {"Content-Type": "application/json"}
    else:
        body = json.dumps({"event": "webhook.test", "data": data})
        headers = {"Content-Type": "application/json", **_build_signature_headers(secret, body)}
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            resp = await client.post(url, content=body, headers=headers)
    except Exception as exc:
        return False, f"delivery error: {type(exc).__name__}"
    if 200 <= resp.status_code < 300:
        return True, None
    return False, f"HTTP {resp.status_code}"
