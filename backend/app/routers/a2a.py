"""E-A2A-POC S1(story 480e81fb): 최소 A2A 서버 — Agent Card + JSON-RPC(SendMessage/GetTask).

PoC 스코프(선생님 지시 + PO 크럭스 2026-07-06): 인증·멀티tenant·signed Card·push 웹훅 생략
(Phase 3). member_id로만 스코프(org_id 검증 없음) — `public_docs.py` 선례처럼 비인증 라우트.

⚠️ Phase 3 리스크 노트(PO 크럭스): `/rpc`의 `SendMessage`는 실제 task를 생성/트리거하는
action-triggering 엔드포인트다 — PoC는 내부 2에이전트 contained 시나리오라 비인증이 허용되지만
외부 interop 단계에서는 인증이 반드시 필요하다.

spec shape는 `a2aproject/A2A`(GitHub, main) `specification/a2a.proto` + `docs/specification.md`
실측 기준(PascalCase 메소드명·camelCase 필드·`TASK_STATE_`/`ROLE_` enum) — story AC의
`message/send`/`tasks/get` 표기(구초안)가 아니다. PO 크럭스로 확認됨.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.models.a2a_task import A2ATask
from app.models.agent_deployment import AgentPersona
from app.models.team import TeamMember
from app.schemas.a2a import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
    Artifact,
    GetTaskParams,
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    Message,
    Part,
    SendMessageParams,
    Task,
    TaskStatus,
)

router = APIRouter(prefix="/api/v2/a2a", tags=["a2a"])

_METHOD_NOT_FOUND = -32601
_INVALID_PARAMS = -32602
_TASK_NOT_FOUND = -32001  # A2A-specific error range(-32001~-32099)


class _JsonRpcException(Exception):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message


async def _get_agent_member(session: AsyncSession, member_id: uuid.UUID) -> TeamMember:
    result = await session.execute(
        select(TeamMember).where(
            TeamMember.id == member_id, TeamMember.type == "agent", TeamMember.is_active.is_(True)
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return member


async def _build_agent_card(session: AsyncSession, member: TeamMember, base_url: str) -> AgentCard:
    """skills[]는 role_template 능력 반영 — 별도 저장 없이 요청 시 AgentPersona(config.tool_allowlist)
    + role_template slug/name/description에서 동적 조립(SSOT는 role_templates, 문서
    `e-a2a-poc-s1-design-crux` §A 판단)."""
    persona_result = await session.execute(
        select(AgentPersona).where(
            AgentPersona.agent_id == member.id,
            AgentPersona.is_default.is_(True),
            AgentPersona.deleted_at.is_(None),
        )
    )
    persona = persona_result.scalar_one_or_none()

    if persona is not None:
        tool_allowlist = persona.config.get("tool_allowlist", []) if isinstance(persona.config, dict) else []
        skills = [
            AgentSkill(
                id=persona.slug,
                name=persona.name,
                description=persona.description or persona.name,
                tags=list(tool_allowlist),
            )
        ]
    else:
        # 미채용(recruit 이전) 에이전트 — team_members.agent_role만으로 최소 skill 하나.
        skills = [
            AgentSkill(
                id=member.agent_role or "unassigned",
                name=member.agent_role or member.name,
                description=f"{member.name} — role_template 미배정(recruit 이전)",
                tags=[],
            )
        ]

    interface_url = f"{base_url}/api/v2/a2a/members/{member.id}/rpc"
    return AgentCard(
        name=member.name,
        description=f"Sprintable team member — {member.agent_role or 'agent'}",
        supported_interfaces=[
            AgentInterface(
                url=interface_url,
                protocol_binding="JSONRPC",
                protocol_version="1.0",
                tenant=str(member.id),
            )
        ],
        version="0.1.0-poc",
        capabilities=AgentCapabilities(streaming=False, push_notifications=False, extended_agent_card=False),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=skills,
    )


@router.get("/members/{member_id}/agent-card.json")
async def get_agent_card(
    member_id: uuid.UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> AgentCard:
    member = await _get_agent_member(session, member_id)
    card = await _build_agent_card(session, member, str(request.base_url).rstrip("/"))
    return card


def _task_to_dict(task: A2ATask) -> dict:
    return Task(
        id=str(task.id),
        context_id=str(task.context_id),
        status=TaskStatus(
            state=task.state,
            timestamp=task.updated_at.isoformat() if task.updated_at else None,
        ),
        artifacts=[Artifact.model_validate(a) for a in task.artifacts],
        history=[Message.model_validate(m) for m in task.history],
    ).model_dump(by_alias=True, mode="json")


async def _handle_send_message(session: AsyncSession, member: TeamMember, params: dict) -> dict:
    try:
        send_params = SendMessageParams.model_validate(params)
    except Exception as exc:  # noqa: BLE001 — JSON-RPC InvalidParamsError로 매핑
        raise _JsonRpcException(_INVALID_PARAMS, f"Invalid params: {exc}") from exc

    incoming = send_params.message
    context_id = uuid.UUID(incoming.context_id) if incoming.context_id else uuid.uuid4()

    # PoC 스코프: 실 BYOM/오케스트레이션 위임 없음(substrate 실증이 목적, Phase 2가 실제 세션주입).
    # 최소 echo 응답으로 task 생명주기(submitted→working→completed)만 실증.
    echo_text = ""
    for part in incoming.parts:
        if part.text:
            echo_text = part.text
            break

    agent_message = Message(
        message_id=str(uuid.uuid4()),
        context_id=str(context_id),
        role="ROLE_AGENT",
        parts=[Part(text=f"[{member.name}] received: {echo_text}")],
    )

    task = A2ATask(
        id=uuid.uuid4(),
        context_id=context_id,
        member_id=member.id,
        state="TASK_STATE_COMPLETED",
        history=[
            incoming.model_dump(by_alias=True, mode="json"),
            agent_message.model_dump(by_alias=True, mode="json"),
        ],
        artifacts=[
            Artifact(
                artifact_id=str(uuid.uuid4()),
                name="echo-response",
                parts=[Part(text=echo_text)],
            ).model_dump(by_alias=True, mode="json")
        ],
    )
    session.add(task)
    await session.flush()
    await session.commit()
    await session.refresh(task)
    return _task_to_dict(task)


async def _handle_get_task(session: AsyncSession, member: TeamMember, params: dict) -> dict:
    try:
        get_params = GetTaskParams.model_validate(params)
    except Exception as exc:  # noqa: BLE001
        raise _JsonRpcException(_INVALID_PARAMS, f"Invalid params: {exc}") from exc

    result = await session.execute(
        select(A2ATask).where(A2ATask.id == get_params.id, A2ATask.member_id == member.id)
    )
    task = result.scalar_one_or_none()
    if task is None:
        raise _JsonRpcException(_TASK_NOT_FOUND, "Task not found")
    return _task_to_dict(task)


_METHODS = {
    "SendMessage": _handle_send_message,
    "GetTask": _handle_get_task,
}


@router.post("/members/{member_id}/rpc")
async def a2a_rpc(
    member_id: uuid.UUID,
    body: JsonRpcRequest,
    session: AsyncSession = Depends(get_db),
) -> JsonRpcResponse:
    member = await _get_agent_member(session, member_id)

    handler = _METHODS.get(body.method)
    if handler is None:
        return JsonRpcResponse(
            id=body.id,
            error=JsonRpcError(code=_METHOD_NOT_FOUND, message=f"Method not found: {body.method}"),
        )

    try:
        result = await handler(session, member, body.params or {})
    except _JsonRpcException as exc:
        return JsonRpcResponse(id=body.id, error=JsonRpcError(code=exc.code, message=exc.message))

    return JsonRpcResponse(id=body.id, result=result)
