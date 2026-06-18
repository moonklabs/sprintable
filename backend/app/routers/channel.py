"""E-FAKECHAT-INTEG:S2 — fakechat 호환 HTTP 채널 API.

POST /api/v2/channel/deliver  — 텍스트 메시지 → WS 허브 브로드캐스트
POST /api/v2/channel/upload   — 파일 업로드 + 메시지 전달
GET  /api/v2/channel/files/{name} — 첨부 파일 서빙
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.core.database import async_session_factory
from app.models.conversation import ConversationMessage
from app.models.team import TeamMember
from app.routers.ws_chat import _authenticate, _broadcast, _get_or_create_conversation

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v2/channel", tags=["channel"])

_FILES_DIR = Path(os.getenv("CHANNEL_FILES_DIR", "/tmp/sprintable_files"))


async def _require_caller(api_key: str | None, token: str | None) -> TeamMember:
    caller = await _authenticate(api_key, token)
    if caller is None:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return caller


async def _resolve_agent(agent_id: uuid.UUID, caller: TeamMember) -> TeamMember:
    async with async_session_factory() as db:
        # team_members 는 projection VIEW — org-agent 멀티프로젝트 grant 면 같은 id 가 N 행이라 무필터
        # scalar_one_or_none 은 MultipleResultsFound. 이 결과의 .org_id(동형)뿐 아니라 .project_id 도
        # _persist_and_broadcast → _get_or_create_conversation 에서 DM room 스코프에 소비되므로 임의
        # .limit(1)(틀린 프로젝트 위험) 대신 deterministic grant-pick(order_by(project_id).limit(1))으로
        # 크래시를 막고 안정적 default project 로 라우팅한다(ws_chat/agent_inbox Ⓑ stopgap 동형).
        # ⚠️ known-limitation: 멀티프로젝트 agent 의 DM room 은 default(최저 project_id) project 로 스코프.
        #   진짜 라우팅(기존 (agent,caller) DM 우선조회→그 conversation 의 project)은 follow-up story.
        agent = (await db.execute(
            select(TeamMember).where(
                TeamMember.id == agent_id,
                TeamMember.type == "agent",
            ).order_by(TeamMember.project_id).limit(1)
        )).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.org_id != caller.org_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    return agent


async def _persist_and_broadcast(
    agent_id: uuid.UUID,
    agent: TeamMember,
    caller: TeamMember,
    content: str,
    file_url: str | None = None,
) -> None:
    # ws_chat._get_or_create_conversation 시그니처 = (agent_id, caller_id, org_id, project_id) 4인자.
    # 과거 caller_id 추가 전환 시 이 호출부 미갱신(한쪽만 전환)으로 3인자 → caller_id 누락 + 인자
    # 미스얼라인(org_id↔caller_id·project_id↔org_id) → /deliver·/upload 호출 시 TypeError. caller.id 보강.
    conv_id = await _get_or_create_conversation(agent_id, caller.id, agent.org_id, agent.project_id)

    msg_content = content
    if file_url:
        msg_content = (content + "\n" + file_url).strip() if content else file_url

    async with async_session_factory() as db:
        msg = ConversationMessage(
            conversation_id=conv_id,
            sender_id=caller.id,
            content=msg_content,
            mentioned_ids=[],
        )
        db.add(msg)
        await db.commit()
        await db.refresh(msg)

    payload_dict: dict = {
        "id": str(msg.id),
        "conversation_id": str(conv_id),
        "sender_id": str(caller.id),
        "sender_name": caller.name,
        "content": msg_content,
        "ts": msg.created_at.isoformat(),
    }
    if file_url:
        payload_dict["file_url"] = file_url

    await _broadcast(str(agent_id), json.dumps(payload_dict))


class DeliverBody(BaseModel):
    agent_id: uuid.UUID
    content: str


@router.post("/deliver", status_code=204)
async def channel_deliver(
    body: DeliverBody,
    api_key: str | None = Query(default=None),
    token: str | None = Query(default=None),
) -> None:
    """텍스트 메시지를 특정 에이전트 WS room으로 브로드캐스트."""
    caller = await _require_caller(api_key, token)
    agent = await _resolve_agent(body.agent_id, caller)
    await _persist_and_broadcast(body.agent_id, agent, caller, body.content)


@router.post("/upload", status_code=204)
async def channel_upload(
    agent_id: uuid.UUID = Form(...),
    content: str = Form(default=""),
    file: UploadFile | None = None,
    api_key: str | None = Query(default=None),
    token: str | None = Query(default=None),
) -> None:
    """파일 업로드 + 메시지 전달 → WS room 브로드캐스트."""
    caller = await _require_caller(api_key, token)
    agent = await _resolve_agent(agent_id, caller)

    file_url: str | None = None
    if file and file.filename:
        data = await file.read()
        if data:
            _FILES_DIR.mkdir(parents=True, exist_ok=True)
            suffix = Path(file.filename).suffix.lower() or ".bin"
            filename = f"{uuid.uuid4().hex}{suffix}"
            (_FILES_DIR / filename).write_bytes(data)
            file_url = f"/api/v2/channel/files/{filename}"

    await _persist_and_broadcast(agent_id, agent, caller, content, file_url)


@router.get("/files/{name}")
async def channel_files(name: str) -> FileResponse:
    """첨부 파일 서빙. 경로 탈출 방지."""
    if "/" in name or "\\" in name or ".." in name or name.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = _FILES_DIR / name
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    media_type, _ = mimetypes.guess_type(name)
    return FileResponse(path, media_type=media_type or "application/octet-stream")
