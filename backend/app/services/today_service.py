"""story #3823(UX-v3·오늘·BE 1, 페드루 PO 確定 2026-09-13) — 「오늘」 화면 4구역
집계(읽기 전용·스키마 0). PO 결정(갈림 ①, 디디 그라운딩 2026-09-13 01:34Z 기반):
Gate·HitlRequest(agent_hitl_requests, request_type="gate_approval")·
WorkflowLineStepApproval 3계는 **데이터 모델로 합치지 않는다** — 이 서비스가
읽기 전용 read-model로만 세 출처를 한 응답에 합류시킨다. 기존 route(gates.py의
``list_gate_inbox``/``list_gates``, command_center.py의 ``my_actions``)는 무변 —
이 파일이 그 함수·쿼리 패턴을 재사용하되 새 코드로 감싼다.

⚠️gates.py는 3821 PR B(#4249) 착지 前까지 손대지 않는다(페드루 PO 지시, rebase
충돌 회피) — 그래서 여기서는 ``list_gate_inbox``를 **직접 함수 호출**로만
재사용한다(이미 그 함수 자신이 ``list_gates``를 직접 호출하는 것과 동일한
기존 관례 — Annotated 파라미터가 이 direct-call 경로를 위해 이미 마련돼 있다).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext
from app.models.channel_connection import ChannelConnection
from app.models.hitl import HitlRequest
from app.models.pm import Story
from app.models.publication_command import PublicationCommand
from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRun
from app.services.member_resolver import lookup_members_by_ids, resolve_member
from app.services.org_time import org_midnight_utc

# story #3821(PR B) 규칙 재사용 — 같은 (work_item_type, work_item_id, gate_type)는
# 3계 어디서 왔든 1행으로 접는다. gate_type이 없는 소스(HitlRequest의 work_type)도
# 이 축에 흡수한다(아래 _dedupe_key 참고).
_EXTERNAL_PUBLISH_GATE_TYPE = "external_publish"

# story #3815류와 동일 선례 — 오늘은 youtube/youtube_sandbox만 「사용량」 개념이
# 있다(channel_adapters.py의 quota_reset_timezone 선언 채널). 다른 채널(wordpress·
# ghost·threads 등)은 이 개념 자체가 BE에 없다(디디 그라운딩 2026-09-13, story
# #3821 카드) — 지어내지 않고 이 목록에 없는 채널은 usage.platform에서 빠진다.
_QUOTA_CHANNELS = frozenset({"youtube", "youtube_sandbox"})

# story #3821 그라운딩 — AgentRun.status(agent_runs.py::_AGENT_RUN_STATUS_VALUES
# SSOT: queued|held|running|hitl_pending|completed|failed|abandoned)의 "진행 中"
# 부분집합 = 아직 끝나지 않은 전부(completed/failed/abandoned만 종결).
_AGENT_RUN_IN_PROGRESS_STATUSES = frozenset({"queued", "held", "running", "hitl_pending"})

# story #3821 그라운딩 — PublicationCommand.status='completed'만 "나갔다"로 센다
# (pending/in_progress/failed/dead_letter/voided/blocked는 아직 안 나갔거나 실패).
_PUBLISHED_STATUS = "completed"


def _dedupe_key(work_item_type: str, work_item_id: uuid.UUID, gate_type: str | None) -> tuple:
    return (work_item_type, work_item_id, gate_type)


async def _needs_me_from_gate_inbox(
    session: AsyncSession, org_id: uuid.UUID, auth: AuthContext,
) -> list[dict[str, Any]]:
    """Gate(pending·assigned_to_me)∪HitlRequest(gate_approval park) — gates.py의
    ``list_gate_inbox``를 직접 함수 호출로 재사용(그 파일 무변경). urgency 정렬
    = SLA overdue 우선·age(created_at) 오래된 순(그 파일 §1973 로직 그대로) —
    이 서비스가 최종적으로 재-정렬(전체 3계 병합 뒤 created_at asc)하므로 여기
    정렬은 「pending 것 우선」 신호로만 쓰인다.
    """
    from app.routers.gates import list_gate_inbox  # 순환 최소화 위해 지역 import(established 관례).

    rows = await list_gate_inbox(
        status="pending", sort="urgency", assigned_to_me=True,
        session=session, org_id=org_id, auth=auth,
    )
    items: list[dict[str, Any]] = []
    for r in rows:
        if r.source == "gate":
            gate_type = r.gate_type
            is_signature = gate_type == _EXTERNAL_PUBLISH_GATE_TYPE
            title = r.work_item_summary.title if r.work_item_summary is not None else None
            items.append({
                "kind": "signature" if is_signature else "approval",
                "risk": "high" if is_signature else "low",
                "source": "gate",
                "source_id": str(r.id),
                "work_item_type": r.work_item_type,
                "work_item_id": r.work_item_id,
                "gate_type": gate_type,
                "title": title,
                "requested_by": None,  # Gate엔 requester 필드 자체가 없다(지어내지 않음).
                "reason": None,
                "created_at": r.created_at,
                "actions": ["approve", "request_changes", "hold"],
            })
        else:  # r.source == "hitl"
            # HitlRequest.work_item_id는 실무상 항상 Story(gates.py 기존 주석 근거).
            # work_type("merge"|"done" 등 라이프사이클 단계)을 이 소스의 gate_type
            # 축으로 흡수 — 그 값 자체가 "어느 ask-level 게이트에서 parking됐는지"의
            # 유일한 식별자이기 때문(HitlRequest 모델엔 gate_type 컬럼이 없다).
            if r.work_item_id is None:
                continue
            items.append({
                "kind": "answer",
                "risk": "low",  # HitlRequest는 risk 표시가 없다(지어내지 않음, 기본 low).
                "source": "hitl",
                "source_id": str(r.id),
                "work_item_type": "story",
                "work_item_id": r.work_item_id,
                "gate_type": r.work_type,
                "title": None,
                "requested_by": None,
                "reason": r.prompt,
                "created_at": r.created_at,
                "actions": ["answer"],
            })
    return items


async def _needs_me_from_workflow_steps(
    session: AsyncSession, org_id: uuid.UUID, member_id: uuid.UUID,
) -> list[dict[str, Any]]:
    """command_center.py::my_actions의 ``gate_approval`` 축과 동일 쿼리 모양(그
    파일 무변경 — 여기 새로 연다). 고위험 판정은 workflow_sla_processor.py::
    _auto_approve_allowed와 동일 신호(risk_snapshot.high_risk/prod_touch) 재사용
    (새 판정 기준을 짓지 않는다)."""
    rows = (await session.execute(
        select(WorkflowLineStepApproval, WorkflowLineStepRun)
        .join(WorkflowLineStepRun, WorkflowLineStepRun.id == WorkflowLineStepApproval.step_run_id)
        .where(
            WorkflowLineStepApproval.org_id == org_id,
            WorkflowLineStepApproval.approver_member_id == member_id,
            WorkflowLineStepApproval.status == "pending",
            WorkflowLineStepApproval.blocking.is_(True),
        )
    )).all()
    items: list[dict[str, Any]] = []
    for a, sr in rows:
        risk = sr.risk_snapshot or {}
        is_high = risk.get("high_risk") is True or risk.get("prod_touch") is True
        items.append({
            "kind": "approval",
            "risk": "high" if is_high else "low",
            "source": "workflow_step",
            "source_id": str(a.id),
            "work_item_type": sr.entity_type,
            "work_item_id": sr.entity_id,
            "gate_type": sr.effective_gate_type,
            "title": None,
            "requested_by_member_id": a.requested_by_member_id,
            "reason": None,
            "created_at": a.created_at,
            "actions": ["approve", "request_changes", "hold"],
        })
    return items


async def _resolve_needs_me(
    session: AsyncSession, org_id: uuid.UUID, auth: AuthContext,
) -> tuple[list[dict[str, Any]], int]:
    member = await resolve_member(auth, org_id, session)
    raw = (
        await _needs_me_from_gate_inbox(session, org_id, auth)
        + await _needs_me_from_workflow_steps(session, org_id, member.id)
    )

    # story #3821 규칙 재사용 — 같은 (work_item_type, work_item_id, gate_type) 1행.
    # 여러 소스가 같은 일을 가리키면 **가장 오래된(created_at 최소)** 행을 대표로
    # 남긴다 — "언제부터 사람 손을 기다렸나"가 「오래된 순」 정렬의 근거라, 더 늦게
    # 생긴 중복(예: 재평가로 새로 열린 워크플로 단계)이 대표가 되면 대기 시간이
    # 짧게 보이는 거짓 신호가 된다.
    collapsed: dict[tuple, dict[str, Any]] = {}
    for it in raw:
        key = _dedupe_key(it["work_item_type"], it["work_item_id"], it["gate_type"])
        existing = collapsed.get(key)
        if existing is None or it["created_at"] < existing["created_at"]:
            collapsed[key] = it

    items = list(collapsed.values())

    # title 배치 채움(N+1 0) — story #3821 그라운딩 AC4: merge gate 등 work_item_
    # summary가 안 채워진 항목은 story 제목을 별도 배치 조회로 채운다(gates.py의
    # work_item_summary는 doc gate만 채운다 — 그 gap의 처방).
    missing_story_ids = {
        it["work_item_id"] for it in items
        if it["title"] is None and it["work_item_type"] == "story"
    }
    story_titles: dict[uuid.UUID, str] = {}
    if missing_story_ids:
        rows = (await session.execute(
            select(Story.id, Story.title).where(Story.id.in_(missing_story_ids))
        )).all()
        story_titles = {sid: title for sid, title in rows}

    # requested_by 배치 채움(workflow_step 소스만 — requested_by_member_id 보유).
    requester_ids = {
        it["requested_by_member_id"] for it in items
        if it.get("requested_by_member_id") is not None
    }
    requesters = await lookup_members_by_ids(requester_ids, session) if requester_ids else {}

    for it in items:
        if it["title"] is None:
            it["title"] = story_titles.get(it["work_item_id"], "")
        rb_id = it.pop("requested_by_member_id", None)
        if rb_id is not None:
            rm = requesters.get(rb_id)
            it["requested_by"] = {"id": rb_id, "name": rm.name} if rm and rm.name else None
        else:
            it.setdefault("requested_by", None)
        # TodayResponse 계약(story #3823 카드) — work_item은 중첩 객체다. 내부적으로는
        # 평평한 키(work_item_type/id/gate_type/title)로 dedupe·enrich하는 편이
        # 간단해 여기서만 마지막에 조립한다.
        it["work_item"] = {"type": it.pop("work_item_type"), "id": it.pop("work_item_id"), "title": it.pop("title")}
        it.pop("gate_type", None)

    items.sort(key=lambda it: it["created_at"])
    return items, len(items)


async def _resolve_agent_progress(
    session: AsyncSession, org_id: uuid.UUID, auth: AuthContext,
) -> list[dict[str, Any]]:
    """story #3821 AC5 — 「위임/참여」는 Story.assignee_id(위임 대상 — human/agent
    혼용 컬럼)==caller 또는 Story.human_owner_member_id(위임한 사람)==caller로
    잡는다(둘 다 pm.py의 실 컬럼 — 새 축을 짓지 않는다). 다건 assignee(story_
    assignees류) 조인은 스코프 밖(이 카드는 read-model 1차, 그라운딩 노트 참고)."""
    from app.models.agent_run import AgentRun

    member = await resolve_member(auth, org_id, session)
    rows = (await session.execute(
        select(AgentRun, Story.id, Story.title)
        .join(Story, Story.id == AgentRun.story_id, isouter=True)
        .where(
            AgentRun.org_id == org_id,
            AgentRun.status.in_(_AGENT_RUN_IN_PROGRESS_STATUSES),
            (Story.assignee_id == member.id) | (Story.human_owner_member_id == member.id),
        )
    )).all()

    agent_ids = {run.agent_id for run, _sid, _stitle in rows}
    agents = await lookup_members_by_ids(agent_ids, session) if agent_ids else {}

    items: list[dict[str, Any]] = []
    for run, story_id, story_title in rows:
        agent = agents.get(run.agent_id)
        items.append({
            "run_id": run.id,
            "agent": {"id": run.agent_id, "name": agent.name if agent and agent.name else ""},
            "work_item": {"type": "story", "id": story_id, "title": story_title or ""} if story_id else None,
            "status": run.status,
            "current_step": None,  # AgentRun엔 "현재 단계" 개념이 없다(지어내지 않음).
            # AgentRun엔 updated_at이 없다(started_at/finished_at뿐) — 진행 中(finished_at
            # 아직 null) 필터라 started_at이 "마지막으로 확인된 행동 시각"의 유일한 근거.
            "last_action_at": run.started_at,
        })
    return items


async def _resolve_published_today(
    session: AsyncSession, org_id: uuid.UUID, tz: str,
) -> dict[str, Any]:
    """story #3821 AC6 — org_time.py::org_midnight_utc 재사용(query param tz를
    그대로 「경계 시간대」로 사용 — org 설정이 아니라 요청 tz, 카드 규격 그대로).
    PublicationCommand엔 완료 시각 컬럼이 없어(status만 'completed') updated_at을
    "완료된 시각"으로 쓴다 — completed로의 전이가 그 행의 마지막 갱신이라는
    전제(재시도 워커의 흔한 관례, apply_command_failure류와 동일 갱신축)."""
    since = org_midnight_utc(tz)
    rows = (await session.execute(
        select(ChannelConnection.channel, func.count(PublicationCommand.id))
        .join(ChannelConnection, ChannelConnection.id == PublicationCommand.destination)
        .where(
            PublicationCommand.org_id == org_id,
            PublicationCommand.status == _PUBLISHED_STATUS,
            PublicationCommand.updated_at >= since,
        )
        .group_by(ChannelConnection.channel)
    )).all()
    by_channel = [{"channel_kind": kind, "count": cnt} for kind, cnt in rows]
    total = sum(c["count"] for c in by_channel)
    return {"count": total, "by_channel": by_channel, "since": since}


async def _resolve_usage(session: AsyncSession, org_id: uuid.UUID) -> dict[str, Any]:
    """story #3821 AC7 — 연결 N개에 쿼리 수 고정. `get_platform_youtube_quota_
    spent_units`는 채널 종류(youtube/youtube_sandbox) 단위 플랫폼 전체 합산이라
    (org_id 필터조차 없다 — youtube_quota.py 근거) N개 연결이 아니라 **이 org에
    실제로 등장하는 distinct 채널 종류 수**만큼만 조회한다(최대 2 — _QUOTA_
    CHANNELS 크기, org의 connection 개수와 무관하게 상한 고정)."""
    from app.services.channel_adapters import get_channel_adapter
    from app.services.youtube_quota import _platform_quota_day_window, get_platform_youtube_quota_spent_units

    connections = (await session.execute(
        select(ChannelConnection.id, ChannelConnection.channel).where(ChannelConnection.org_id == org_id)
    )).all()

    now = datetime.now(timezone.utc)
    limit_units = settings.youtube_quota_daily_limit_units
    quota_cache: dict[str, tuple[int, datetime]] = {}
    platform_items: list[dict[str, Any]] = []
    for conn_id, channel in connections:
        if channel not in _QUOTA_CHANNELS:
            continue
        if channel not in quota_cache:
            spent = await get_platform_youtube_quota_spent_units(session, channel=channel, now=now)
            adapter = get_channel_adapter(channel)
            tz_name = adapter.quota_reset_timezone if adapter is not None else "UTC"
            _, reset_at = _platform_quota_day_window(now, tz_name)
            quota_cache[channel] = (spent, reset_at)
        spent, reset_at = quota_cache[channel]
        platform_items.append({
            "connection_id": conn_id, "channel_kind": channel,
            "used": spent, "limit": limit_units, "reset_at": reset_at,
        })

    return {"platform": platform_items, "ad_spend": {"measured": False}}


async def build_today_snapshot(
    session: AsyncSession, *, org_id: uuid.UUID, auth: AuthContext, tz: str,
) -> dict[str, Any]:
    needs_me, needs_me_count = await _resolve_needs_me(session, org_id, auth)
    agent_progress = await _resolve_agent_progress(session, org_id, auth)
    published_today = await _resolve_published_today(session, org_id, tz)
    usage = await _resolve_usage(session, org_id)
    return {
        "needs_me": needs_me,
        "needs_me_count": needs_me_count,
        "agent_progress": agent_progress,
        "published_today": published_today,
        "usage": usage,
    }
