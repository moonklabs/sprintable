"""E-EVENTBUS P3 S8/S27: 이벤트→알림 설정 필터 엔진.

notification_settings 조회 후 enabled인 member에게만 Notification INSERT.
설정 없으면 기본 enabled (opt-out 방식).

S27: agent type 멤버는 Notification 대신 events 테이블 INSERT (dispatched, pending).
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.notification import Notification, NotificationSetting
from app.models.team import TeamMember
from app.models.webhook_config import WebhookConfig
from app.services.webhook_targeting import active_webhook_member_ids

logger = logging.getLogger(__name__)


async def _query_muted_member_ids(
    db: AsyncSession, member_ids: list[uuid.UUID],
) -> set[uuid.UUID]:
    """story 75570ab8: global mute(채널 막론) 멤버 집합 — 단일 조회로 SSOT화(이전엔
    `_deliver_personal_webhooks`만 알고 있어서, mute+webhook 동시보유 에이전트가 Event-skip
    판정(webhook이 커버한다고 가정)과 webhook mute-skip 둘 다에 걸려 **총 무전달**이었다).
    호출자가 이 결과를 Event-skip 판정에도 반영해야 무음 조합이 사라진다."""
    if not member_ids:
        return set()
    from app.models.notification_preference import NotificationPreference

    rows = await db.execute(
        select(NotificationPreference.member_id).where(
            NotificationPreference.member_id.in_(member_ids),
            NotificationPreference.scope_type == "global",
            NotificationPreference.scope_id.is_(None),
            NotificationPreference.level == "mute",
        )
    )
    return {m for m in rows.scalars().all()}


async def _deliver_personal_webhooks(
    db: AsyncSession,
    org_id: uuid.UUID,
    member_ids: list[uuid.UUID],
    *,
    title: str,
    body: str | None,
    event_type: str,
    reference_type: str | None = None,
    reference_id: uuid.UUID | None = None,
    context: dict | None = None,
    muted_member_ids: set[uuid.UUID] | None = None,
) -> None:
    """96af343e: 활성 개인(member-scoped) WebhookConfig 보유 휴먼에게 알림 webhook POST.

    in-app Notification 과 동일 flush 타이밍(best-effort·옵션 C). global mute 멤버는 skip
    (채널 막론 mute 우선). SSRF 검증·HMAC 서명·Discord URL 포맷·retry 는
    dispatch_router._post_with_retry / app.core.ssrf 재사용. agent SSE 경로
    (route_dispatch_event)는 미변경(무회귀). 개별 POST 실패는 swallow → in-app 무영향.

    muted_member_ids: story 75570ab8 — 호출자(dispatch_notification)가 이미 계산한 mute
    집합을 넘기면 재조회 생략(Event-skip 판정과 동일 SSOT 재사용, 드리프트 방지). None이면
    이 함수가 자체 조회(단독 호출 하위호환).
    """
    if not member_ids:
        return
    from app.core.ssrf import validate_webhook_url_async
    from app.services.dispatch_router import _post_with_retry

    wh_rows = await db.execute(
        select(WebhookConfig).where(
            WebhookConfig.org_id == org_id,
            WebhookConfig.member_id.in_(member_ids),
            WebhookConfig.is_active.is_(True),
            WebhookConfig.member_id.isnot(None),
        )
    )
    configs = list(wh_rows.scalars().all())
    if not configs:
        return

    # global mute 멤버 skip (CP②: 채널 막론 mute 우선)
    if muted_member_ids is None:
        muted = await _query_muted_member_ids(db, [c.member_id for c in configs])
    else:
        muted = muted_member_ids

    for cfg in configs:
        if cfg.member_id in muted:
            continue
        # SSRF 재검증 (저장 후 DNS rebinding 방지)
        try:
            await validate_webhook_url_async(cfg.url)
        except Exception:
            logger.warning("personal webhook SSRF reject member=%s", cfg.member_id)
            continue
        is_discord = (
            "discord.com/api/webhooks" in cfg.url
            or "discordapp.com/api/webhooks" in cfg.url
        )
        if is_discord:
            text = f"[{event_type}] {title}" + (f"\n{body}" if body else "")
            payload = {"content": text}
            secret = None  # Discord 자체 인증 방식
        else:
            # C0-S2: 에이전트가 payload만 보고 반응(답글)할 수 있도록 반응 맥락을 실는다 —
            # reference(story 등) + context(comment_id·content·author). Discord(휴먼)는 content
            # 텍스트 제약이라 위 분기 유지·structured 맥락은 generic(에이전트 런타임 endpoint) payload.
            payload = {
                "event": event_type,
                "title": title,
                "body": body,
                "reference_type": reference_type,
                "reference_id": str(reference_id) if reference_id else None,
                "context": context or {},
            }
            secret = cfg.secret
        try:
            await _post_with_retry(cfg.url, payload, secret, str(cfg.member_id))
        except Exception:
            logger.warning("personal webhook POST failed (swallowed) member=%s", cfg.member_id)


async def dispatch_notification(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    event_type: str,
    target_member_ids: list[uuid.UUID],
    title: str,
    body: str | None = None,
    reference_type: str | None = None,
    reference_id: uuid.UUID | None = None,
    source_project_id: uuid.UUID | None = None,
    context: dict | None = None,
) -> None:
    """notification_settings 필터 후 enabled member에게 알림 발송.

    human 멤버: Notification 테이블 INSERT (in-app 알림)
    agent 멤버: events 테이블 INSERT (event_type=dispatched, status=pending)
               → poll_events / SSE 브릿지로 에이전트 수신

    설정이 없는 member는 기본 enabled (opt-out).
    channel 기준: 'in_app'.

    source_project_id: 알림을 촉발한 프로젝트(org-level 멀티프로젝트 에이전트 대응). team_members
    뷰가 멀티프로젝트 멤버를 N행(동일 id)으로 내는데, 주어지면 dedup에서 그 프로젝트 행을 우선
    선택하고 에이전트 Event를 그 프로젝트로 스코프한다 — 임의 first-project로 떨구는 오라우팅 방지.
    미지정 시 기존 거동(첫 행) 유지 → 휴먼 1-알림 dedup 무회귀(additive·하위호환).
    """
    if not target_member_ids:
        return

    try:
        # notification_settings 조회 (해당 member + event_type + in_app)
        settings_result = await db.execute(
            select(NotificationSetting.member_id, NotificationSetting.enabled).where(
                NotificationSetting.org_id == org_id,
                NotificationSetting.member_id.in_(target_member_ids),
                NotificationSetting.event_type == event_type,
                NotificationSetting.channel == "in_app",
            )
        )
        settings = {row.member_id: row.enabled for row in settings_result.all()}

        # 설정 없으면 기본 enabled → enabled인 member만 필터
        enabled_member_ids = [
            mid for mid in target_member_ids
            if settings.get(mid, True)
        ]

        if not enabled_member_ids:
            return

        # 활성 webhook_configs가 있는 멤버 집합 — 웹훅 채널로 전달되므로 내장 알림 스킵.
        # E-EVENT-1CONFIG: 메시지 경로 SSE-skip과 공용 SSOT(active_webhook_member_ids) —
        # member-bound(project-독립) 활성 webhook 보유 멤버. fail-open(조회 실패=빈 집합).
        webhook_member_ids = await active_webhook_member_ids(
            db, org_id, enabled_member_ids
        )
        # story 75570ab8: mute+webhook 동시보유 재판정 — active_webhook_member_ids는 mute를
        # 모른다. 그래서 muted 에이전트가 "webhook이 커버한다"고 오판돼 Event insert도 스킵되고,
        # 뒤이어 _deliver_personal_webhooks 자체 mute 체크로 webhook도 스킵돼 **총 무전달**이었다
        # (그라운딩 0f428e1e 때 확인한 dispatch_notification 경로 지식 재사용). mute의 옳은
        # 의미론 = "능동 push(webhook)만 끔" — 수동 backlog(Event/poll_events로 나중에 발견 가능)
        # 까지 지우면 안 됨(webhook_targeting.py 자체가 명시한 "silent loss 방지" 설계 철학과
        # 정합). 따라서 muted 멤버는 webhook-covered 취급에서 제외해 Event insert 경로로 폴백.
        muted_member_ids = await _query_muted_member_ids(db, list(webhook_member_ids))
        event_skip_member_ids = webhook_member_ids - muted_member_ids

        # BUG-2 수정: user_id.isnot(None) 필터 제거 — agent는 user_id=NULL이므로 제외됐던 문제
        # type 및 project_id도 함께 조회
        members_result = await db.execute(
            select(TeamMember.id, TeamMember.user_id, TeamMember.type, TeamMember.project_id).where(
                TeamMember.id.in_(enabled_member_ids),
                TeamMember.org_id == org_id,
            )
        )
        members = list(members_result.all())

        # E-MEMBER-SSOT AC2-2: grant-only 휴먼(team_member 없음)은 org_member로 해소해
        # in-app Notification 누락(silent drop) 방지. org_member는 project 스코프가 없으므로
        # human Notification만 생성(Event는 project_id 필요 → skip). Notification은 user_id
        # 기반이고 FK가 없어 org_member.id 사용에 제약 없음.
        matched_ids = {m.id for m in members}
        missing_ids = [mid for mid in enabled_member_ids if mid not in matched_ids]
        if missing_ids:
            from types import SimpleNamespace

            from app.models.project import OrgMember
            om_result = await db.execute(
                select(OrgMember.id, OrgMember.user_id).where(
                    OrgMember.id.in_(missing_ids),
                    OrgMember.org_id == org_id,
                    OrgMember.deleted_at.is_(None),
                )
            )
            for om in om_result.all():
                members.append(
                    SimpleNamespace(id=om.id, user_id=om.user_id, type="human", project_id=None)
                )

        # 회귀 버그 fix: team_members는 0088 이후 projection VIEW라 멤버당 **프로젝트별 1행**(동일 id)을
        # 반환한다. dedup 없이 루프하면 멀티프로젝트 멤버에게 알림이 **프로젝트 수만큼 중복 생성**됨
        # (Story Assign 시 Inbox 알림 3개 증상 = 담당자가 3개 프로젝트 소속). member id로 dedup해
        # 멤버당 1 알림/이벤트만 생성. (view-cutover multi-row 트랩)
        # source_project_id 주어지면 그 프로젝트 행을 우선(멀티프로젝트 에이전트 = 트리거 프로젝트로
        # 정확 라우팅). 미지정 시 첫 행(기존 거동). 어느 경우든 member당 정확히 1행 → 휴먼 N-알림 무회귀.
        _picked: dict[uuid.UUID, object] = {}
        for _m in members:
            cur = _picked.get(_m.id)
            if cur is None:
                _picked[_m.id] = _m
            elif source_project_id is not None and getattr(_m, "project_id", None) == source_project_id:
                _picked[_m.id] = _m  # 트리거 프로젝트 행으로 교체
        members = list(_picked.values())

        inserted = False
        created_events: list[Event] = []  # L1 BE-3: fan-out 수렴용 event 수집
        for member_row in members:
            if member_row.type == "agent":
                # 활성 웹훅 있는 에이전트 → 외부 채널로 전달되므로 내장 Event 스킵(단, muted면
                # webhook도 안 나가므로 Event insert로 폴백 — 위 event_skip_member_ids 참고).
                if member_row.id in event_skip_member_ids:
                    logger.debug(
                        "dispatch_notification: skip agent %s — has active webhook", member_row.id
                    )
                    continue
                # BUG-3 수정: agent → Notification 대신 events 테이블 INSERT.
                # 트리거 프로젝트(source_project_id) 우선 — 멀티프로젝트 에이전트가 임의 프로젝트로
                # 이벤트 받는 오라우팅 방지. 미지정 시 뷰 행의 project_id(기존 거동).
                _agent_proj = source_project_id or member_row.project_id
                if _agent_proj:
                    event = Event(
                        project_id=_agent_proj,
                        org_id=org_id,
                        event_type="dispatched",
                        source_entity_type=reference_type,
                        source_entity_id=reference_id,
                        sender_id=None,
                        recipient_id=member_row.id,
                        recipient_type="agent",
                        payload={"title": title, "body": body, "event_type": event_type},
                        status="pending",
                    )
                    db.add(event)
                    created_events.append(event)
                    inserted = True
            elif member_row.user_id:
                # human: Notification + Event 각각 독립 savepoint — 하나 실패해도 다른 쪽 롤백 방지
                try:
                    async with db.begin_nested():
                        notification = Notification(
                            org_id=org_id,
                            user_id=member_row.user_id,
                            type=event_type,
                            title=title,
                            body=body,
                            is_read=False,
                            reference_type=reference_type,
                            reference_id=reference_id,
                        )
                        db.add(notification)
                    inserted = True
                except Exception:
                    logger.warning("Notification INSERT failed member_id=%s event_type=%s", member_row.id, event_type)
                if member_row.project_id:
                    try:
                        async with db.begin_nested():
                            event = Event(
                                project_id=member_row.project_id,
                                org_id=org_id,
                                event_type="dispatched",
                                source_entity_type=reference_type,
                                source_entity_id=reference_id,
                                sender_id=None,
                                recipient_id=member_row.id,
                                recipient_type="human",
                                payload={"title": title, "body": body, "event_type": event_type},
                                status="delivered",
                            )
                            db.add(event)
                        created_events.append(event)
                        inserted = True
                    except Exception:
                        logger.warning("Event INSERT failed member_id=%s event_type=%s", member_row.id, event_type)

        if inserted:
            await db.flush()
            # L1 BE-3: multi-recipient dispatch fan-out N행 → activity_events 1행 수렴
            # (best-effort·savepoint 격리라 추출 실패해도 delivery·Notification 무영향).
            from app.services.activity_stream import extract_activities_best_effort
            await extract_activities_best_effort(db, [e.id for e in created_events])

        # 96af343e(옵션 C) + C0-S2(8bace49e 부활): 개인 webhook 발송 — 휴먼 + agent(활성 webhook).
        # ⭐agent(활성 webhook)는 위에서 Event INSERT를 스킵했다("외부 채널로 전달" 전제). 그런데 그
        # webhook을 여기서 실제로 쏘지 않으면 Event도 스킵·webhook도 미발송 = comment.created가
        # webhook-agent에 미도달(죽은 경로). 이 경로를 부활시켜 에이전트 반응 왕복을 잇는다 —
        # member-bound WebhookConfig·mute(NotificationPreference)·SSRF 재검증 기존 SSOT 재사용·
        # Event-skip 유지라 이중배달 0(webhook 단일 채널).
        webhook_deliver_ids = [
            m.id for m in members
            if (m.type != "agent" and getattr(m, "user_id", None))
            or (m.type == "agent" and m.id in webhook_member_ids)
        ]
        await _deliver_personal_webhooks(
            db, org_id, webhook_deliver_ids, title=title, body=body, event_type=event_type,
            reference_type=reference_type, reference_id=reference_id, context=context,
            muted_member_ids=muted_member_ids,
        )

    except Exception:
        # BUG-1 수정: 에러 삼킴 제거 → 스택 트레이스 로깅
        logger.exception("dispatch_notification failed org_id=%s event_type=%s", org_id, event_type)
