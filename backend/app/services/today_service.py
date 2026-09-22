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

# story #3815류와 동일 선례 — 오늘은 youtube/youtube_sandbox만 「사용량」 개념이
# 있다(channel_adapters.py의 quota_reset_timezone 선언 채널). 다른 채널(wordpress·
# ghost·threads 등)은 이 개념 자체가 BE에 없다(디디 그라운딩 2026-09-13, story
# #3821 카드) — 지어내지 않고 이 목록에 없는 채널은 usage.platform에서 빠진다.
_QUOTA_CHANNELS = frozenset({"youtube", "youtube_sandbox"})

# story #3821 그라운딩 — AgentRun.status(agent_runs.py::_AGENT_RUN_STATUS_VALUES
# SSOT: queued|held|running|hitl_pending|completed|failed|abandoned)의 "진행 中"
# 부분집합 = 아직 끝나지 않은 전부(completed/failed/abandoned만 종결).
_AGENT_RUN_IN_PROGRESS_STATUSES = frozenset({"queued", "held", "running", "hitl_pending"})

# story #3833 — agent_runs.py::_TERMINAL_STATUSES와 같은 값(SSOT는 그 파일).
# "오늘 끝난 위임"의 「끝남」 = 이 세 상태로의 전이(그 라우터가 finished_at을
# 서버가 채우는 것도 보장하는 바로 그 집합).
_TERMINAL_STATUSES = frozenset({"completed", "failed", "abandoned"})

# story #3833 — completed_today 최신순 상한(카드 규격 그대로).
_COMPLETED_TODAY_LIMIT = 20

# story #3821 그라운딩 — PublicationCommand.status='completed'만 "나갔다"로 센다
# (pending/in_progress/failed/dead_letter/voided/blocked는 아직 안 나갔거나 실패).
_PUBLISHED_STATUS = "completed"


def _dedupe_key(work_item_type: str, work_item_id: uuid.UUID, gate_type: str | None, kind: str) -> tuple:
    """페드루 PO 리뷰 정정 1(PR #4250) — HitlRequest의 work_type("merge"|"done")을
    gate_type 축으로 흡수하다 보니, 같은 story에 merge gate(kind=approval)와
    merge 단계 HITL 질문(kind=answer)이 함께 있으면 (work_item_type, id, "merge")
    한 키로 접혀 둘 중 하나가 사라졌다 — 승인과 답은 다른 사람 손이라 한 행이
    아니다. story #3821의 dedupe 규칙("같은 게이트 종류의 재게시=1행")은 **같은
    kind끼리**에만 적용돼야 한다 — kind를 키에 더해 승인/답변 축을 분리한다."""
    return (work_item_type, work_item_id, gate_type, kind)


async def _needs_me_from_gate_inbox(
    session: AsyncSession, org_id: uuid.UUID, auth: AuthContext,
) -> list[dict[str, Any]]:
    """Gate(pending·assigned_to_me)∪HitlRequest(gate_approval park) — gates.py의
    ``list_gate_inbox``를 직접 함수 호출로 재사용(그 파일 무변경). urgency 정렬
    = SLA overdue 우선·age(created_at) 오래된 순(그 파일 §1973 로직 그대로) —
    이 서비스가 최종적으로 재-정렬(전체 3계 병합 뒤 created_at asc)하므로 여기
    정렬은 「pending 것 우선」 신호로만 쓰인다.

    story #3868(PO 確定 2026-09-14 11:41Z) — kind(signature/approval) 판정을
    ``gate_type == "external_publish"`` 리터럴 비교(예전 방식)가 아니라 gates.py의
    고위험 집행과 같은 SSOT 함수 ``derive_risk_grade(posture, gate_type)``로 낸다.
    external_publish 특례를 삭제한 이유: doc_approval도 _HIGH_RISK_GATE_TYPES
    2차축 멤버라 external_publish와 똑같이 high인데 리터럴 비교는 doc_approval을
    놓쳤고(「오늘」=approval인데 게이트 페이지=signature 갈림의 원인), org posture가
    permissive면 1차축이 이겨 external_publish도 low로 내려가는데 리터럴 비교는
    그 경우도 못 봤다(양방향 오차, AC0 그라운딩 ③). posture는 org당 1쿼리(N+1 0,
    list_gates·gate 승인 집행과 동일 패턴).
    """
    from app.routers.gates import list_gate_inbox  # 순환 최소화 위해 지역 import(established 관례).
    from app.services.gate_service import derive_risk_grade, get_org_posture

    rows = await list_gate_inbox(
        status="pending", sort="urgency", assigned_to_me=True,
        session=session, org_id=org_id, auth=auth,
    )
    _posture = await get_org_posture(session, org_id)
    items: list[dict[str, Any]] = []
    for r in rows:
        if r.source == "gate":
            gate_type = r.gate_type
            risk = derive_risk_grade(_posture, gate_type)
            title = r.work_item_summary.title if r.work_item_summary is not None else None
            items.append({
                "kind": "signature" if risk == "high" else "approval",
                "risk": risk,
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
            # story #3965 — approver row의 대표 Gate(S9 parallel gate). 페드루 PO
            # CHANGES(2026-09-17): 이 값이 없으면 FE가 POST /gates/{id}/approvers/
            # {approval_id}/decision을 needs_me 응답만으로 못 부른다.
            "gate_id": a.gate_id,
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
        key = _dedupe_key(it["work_item_type"], it["work_item_id"], it["gate_type"], it["kind"])
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

    # story #3828(UX-v3·대화·BE 1) — needs_me 행에 "관련 대화"(work_item을 태그한
    # 가장 최근 메시지의 conversation, 있으면 최근 1) 링크. work_item당 개별 쿼리
    # 대신 IN 절 배치 하나로 N+1 없이 구한다(conversations.py::list_conversations_
    # by_work_item과 같은 태그 조회 축 재사용, 그 route를 다시 호출하지는 않는다 —
    # 이미 열린 session 안에서 같은 쿼리 모양을 직접 재현).
    #
    # 페드루 PO 리뷰 CHANGES(PR #4253) — 캐폴러가 참여하지 않은 대화(특히 DM)의
    # id를 "오늘" 행 링크로 내보내면 클릭 시 403 죽은 링크이자 그 DM의 존재
    # 자체를 캐폴러에게 노출한다 — ConversationParticipant.member_id == 캐폴러
    # 조건을 반드시 같이 건다(conversations.py::list_conversations_by_work_item
    # 과 동일 원칙).
    #
    # story #3860 — 이 배치 파생은 이제 work_item_conversation.py의 SSOT 함수다
    # (gates.py/hitl.py의 conversation_id enrich도 같은 함수를 쓴다 — 로직 복제 0).
    work_item_pairs = {(it["work_item_type"], it["work_item_id"]) for it in items}
    from app.services.work_item_conversation import derive_conversation_ids_for_tagged_work_items

    conversation_by_work_item = await derive_conversation_ids_for_tagged_work_items(
        session, org_id=org_id, member_id=member.id, work_item_pairs=work_item_pairs,
    )

    for it in items:
        if it["title"] is None:
            it["title"] = story_titles.get(it["work_item_id"], "")
        rb_id = it.pop("requested_by_member_id", None)
        if rb_id is not None:
            rm = requesters.get(rb_id)
            it["requested_by"] = {"id": rb_id, "name": rm.name} if rm and rm.name else None
        else:
            it.setdefault("requested_by", None)
        it["conversation_id"] = conversation_by_work_item.get((it["work_item_type"], it["work_item_id"]))
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

    # 페드루 PO 리뷰 CHANGES(PR #4253) — run.conversation_id를 캐폴러 참여 검증
    # 없이 그대로 내보내면 클릭 시 403 죽은 링크이자 그 대화(DM 포함)의 존재
    # 자체를 노출한다. 캐폴러가 실제 참여자인 conversation_id만 배치로 골라낸다
    # (list_conversations_by_work_item·needs_me 배치와 동일 원칙).
    #
    # story #3860 — work_item_conversation.py의 SSOT 필터 함수(hitl.py의
    # conversation_id enrich도 같은 함수를 쓴다).
    from app.services.work_item_conversation import filter_participant_conversation_ids

    conv_ids = {run.conversation_id for run, _sid, _stitle in rows if run.conversation_id is not None}
    participant_conv_ids = await filter_participant_conversation_ids(
        session, member_id=member.id, conversation_ids=conv_ids,
    )

    # story #3833 AC1 — 그 run의 "마지막 도구 호출 이름"(agent_run_tool_calls 최신
    # 1건). DISTINCT ON (run_id)로 run 개수와 무관하게 쿼리 1(N+1 0). tool 컬럼은
    # PR2(X-Sprintable-Tool 헤더 배선) 착지 전까진 항상 null이라(그라운딩 참고)
    # 지금은 값이 있어도 null로 보인다 — 그게 정직한 현재 상태다(지어내지 않음).
    from app.models.agent_run_tool_call import AgentRunToolCall

    run_ids = {run.id for run, _sid, _stitle in rows}
    current_steps: dict[uuid.UUID, str | None] = {}
    if run_ids:
        last_call_rows = (await session.execute(
            select(AgentRunToolCall.run_id, AgentRunToolCall.tool)
            .distinct(AgentRunToolCall.run_id)
            .where(AgentRunToolCall.run_id.in_(run_ids))
            .order_by(AgentRunToolCall.run_id, AgentRunToolCall.started_at.desc())
        )).all()
        current_steps = {rid: tool for rid, tool in last_call_rows}

    items: list[dict[str, Any]] = []
    for run, story_id, story_title in rows:
        agent = agents.get(run.agent_id)
        items.append({
            "run_id": run.id,
            "agent": {"id": run.agent_id, "name": agent.name if agent and agent.name else ""},
            "work_item": {"type": "story", "id": story_id, "title": story_title or ""} if story_id else None,
            "status": run.status,
            "current_step": current_steps.get(run.id),
            # 페드루 PO 리뷰 정정 2(PR #4250) — "last_action_at"이라는 이름으로
            # started_at 값을 실으면 오래 도는 run이 "방금 행동했다"는 거짓 신호가
            # 된다(AgentRun엔 "마지막 행동 시각" 개념 자체가 없다 — updated_at도
            # 없음). 필드명을 값의 실제 뜻(시작 시각)에 맞춘다.
            "started_at": run.started_at,
            # story #3828 — 이 실행을 촉발한 대화(agent_runs.conversation_id, 마이그
            # 0374). 캐폴러가 그 대화의 실제 참여자일 때만 노출(위 참여 검증) —
            # 연결 자체가 없거나 캐폴러가 참여자가 아니면 null(지어내지 않는다).
            "conversation_id": run.conversation_id if run.conversation_id in participant_conv_ids else None,
        })
    return items


async def _resolve_completed_today(
    session: AsyncSession, org_id: uuid.UUID, auth: AuthContext, tz: str,
) -> list[dict[str, Any]]:
    """story #3833 AC2/AC3 — 오늘(tz 자정 이후) 종료된 run 중 호출자가 위임/참여한
    것(_resolve_agent_progress와 **같은** 참여 술어 — Story.assignee_id 또는
    Story.human_owner_member_id == caller, PO 判定 2026-09-13 그대로 재사용,
    새 축 0). conversation_id도 그 함수와 동일하게 캐폴러 참여 검증을 거친다
    (죽은 링크·DM 존재 노출 방지 원칙 동일 적용). 최신순(finished_at DESC)·상한
    20."""
    from app.models.agent_run import AgentRun
    from app.models.conversation import ConversationParticipant

    member = await resolve_member(auth, org_id, session)
    since = org_midnight_utc(tz)
    rows = (await session.execute(
        select(AgentRun, Story.id, Story.title)
        .join(Story, Story.id == AgentRun.story_id, isouter=True)
        .where(
            AgentRun.org_id == org_id,
            AgentRun.status.in_(_TERMINAL_STATUSES),
            AgentRun.finished_at.isnot(None),
            AgentRun.finished_at >= since,
            (Story.assignee_id == member.id) | (Story.human_owner_member_id == member.id),
        )
        .order_by(AgentRun.finished_at.desc())
        .limit(_COMPLETED_TODAY_LIMIT)
    )).all()

    agent_ids = {run.agent_id for run, _sid, _stitle in rows}
    agents = await lookup_members_by_ids(agent_ids, session) if agent_ids else {}

    conv_ids = {run.conversation_id for run, _sid, _stitle in rows if run.conversation_id is not None}
    participant_conv_ids: set[uuid.UUID] = set()
    if conv_ids:
        participant_conv_ids = set((await session.execute(
            select(ConversationParticipant.conversation_id).where(
                ConversationParticipant.conversation_id.in_(conv_ids),
                ConversationParticipant.member_id == member.id,
            )
        )).scalars().all())

    items: list[dict[str, Any]] = []
    for run, story_id, story_title in rows:
        agent = agents.get(run.agent_id)
        items.append({
            "run_id": run.id,
            "agent": {"id": run.agent_id, "name": agent.name if agent and agent.name else ""},
            "work_item": {"type": "story", "id": story_id, "title": story_title or ""} if story_id else None,
            "status": run.status,
            "result_summary": run.result_summary,
            "finished_at": run.finished_at,
            "conversation_id": run.conversation_id if run.conversation_id in participant_conv_ids else None,
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


async def _resolve_today_results(
    session: AsyncSession, org_id: uuid.UUID, tz: str,
) -> dict[str, Any]:
    """story #3959(3954 그라운딩 doc 처방 그대로) — 「오늘 결과」 집계 3(4번째
    read-model). 전부 org_midnight_utc(tz) 경계·집계 쿼리 1개씩(루프 0, N+1 0).

    landed_today: story_activities(activity_type="status_changed", new_value="done")
    실측 카운트. 이 행은 story_status_events.py::emit_story_status_changed()가
    ``if actor_id:`` 조건에서만 남긴다 — board PATCH·gate-merge-approve 두 실
    경로 다 actor_id를 갖고 호출하므로, actor 없는 자동 전이는 구조적으로 이
    카운트에 안 잡힌다(근사 0 — PO 確認 2026-09-16, 배제 자체가 계약이라
    approx 플래그를 두지 않는다. 이 배제를 테스트로 고정한다).

    qa_passed_today: gates.status="approved" AND resolved_at 실측 —
    gate_service.py가 상태 전이 시 ``datetime.now(utc)``로 정확히 세팅해
    근사가 불요하다.

    open_defects: verdict(source="qa", result="fail") 테이블은 스키마는 있으나
    이를 채우는 유일한 통로 POST /capture-review(verdict_capture.py)의 실
    호출처가 레포 전체 0(cron·webhook·스크립트 없음, 테스트만 참조) — 지금
    count를 내면 실제 결함이 있어도 거짓 0이 나온다. PO 確定(2026-09-16):
    measured=False 고정·count=None(usage.ad_spend와 동일 관례, 가짜 0 금지).
    """
    from app.models.gate import Gate
    from app.models.pm import StoryActivity

    since = org_midnight_utc(tz)

    landed_today_count = await session.scalar(
        select(func.count(StoryActivity.id)).where(
            StoryActivity.org_id == org_id,
            StoryActivity.activity_type == "status_changed",
            StoryActivity.new_value == "done",
            StoryActivity.created_at >= since,
        )
    )

    qa_passed_today_count = await session.scalar(
        select(func.count(Gate.id)).where(
            Gate.org_id == org_id,
            Gate.status == "approved",
            Gate.resolved_at.isnot(None),
            Gate.resolved_at >= since,
        )
    )

    return {
        "landed_today": {"count": landed_today_count or 0, "since": since},
        "qa_passed_today": {"count": qa_passed_today_count or 0, "since": since},
        "open_defects": {"count": None, "measured": False},
    }


async def build_today_snapshot(
    session: AsyncSession, *, org_id: uuid.UUID, auth: AuthContext, tz: str,
) -> dict[str, Any]:
    needs_me, needs_me_count = await _resolve_needs_me(session, org_id, auth)
    agent_progress = await _resolve_agent_progress(session, org_id, auth)
    completed_today = await _resolve_completed_today(session, org_id, auth, tz)
    published_today = await _resolve_published_today(session, org_id, tz)
    usage = await _resolve_usage(session, org_id)
    today_results = await _resolve_today_results(session, org_id, tz)
    return {
        "needs_me": needs_me,
        "needs_me_count": needs_me_count,
        "agent_progress": agent_progress,
        "completed_today": completed_today,
        "published_today": published_today,
        "usage": usage,
        **today_results,
    }
