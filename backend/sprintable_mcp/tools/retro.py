"""레트로스펙티브 세션 MCP 도구 (7개).

story #4329 — 세션 id로 부르는 도구(투표 · 액션 · 단계 · 아이템 · 내보내기)는 쿼리 `project_id`를 싣지 않는다: 서버가 그 값을 읽지 않고
회고 세션에서 프로젝트를 정해 접근권을 확인한다(보내던 값은 조용히 버려졌다 · MCP↔BE 파라미터 대조 가드)."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok, ok_paginated
from ..schemas import SprintableInput
from .stories import _has_more_from_headers

# 백엔드 `app/models/retro.py` RETRO_PHASES와 같은 넷 — 예전 여섯(group · discuss 포함)은 서버가 400으로 거절했다(story #4329 까디르).
# 둘의 동일성은 tests/test_mcp_retro_paths.py가 고정한다(한쪽만 늘면 RED).
RetroPhase = Literal["collect", "vote", "action", "closed"]
RetroCategory = Literal["good", "bad", "improve"]


class ListRetroSessionsInput(SprintableInput):
    limit: int | None = None
    cursor: str | None = None  # 이전 호출의 X-Next-Cursor 헤더 값을 그대로 넘기면 다음 페이지.


class CreateRetroSessionInput(SprintableInput):
    title: str
    sprint_id: str | None = None
    created_by: str | None = None


class VoteRetroItemInput(SprintableInput):
    session_id: str
    item_id: str
    # story #4329 — `voter_id`는 뺐다: 서버는 투표자를 호출자 인증에서 정하고(P0 9f27af8f · 대리 투표 차단) 본문을 받지 않아 조용히 버려졌다.


class AddRetroActionInput(SprintableInput):
    session_id: str
    title: str
    assignee_id: str | None = None


class ChangeRetroPhaseInput(SprintableInput):
    session_id: str
    phase: RetroPhase


class AddRetroItemInput(SprintableInput):
    session_id: str
    category: RetroCategory
    text: str
    # story #4329 — `author_id`는 뺐다: 서버는 작성자를 호출자 인증에서 정하고(P0 9f27af8f) 본문 값을 버렸다(voter_id와 같은 자리).


class ExportRetroInput(SprintableInput):
    session_id: str


async def list_retro_sessions(args: ListRetroSessionsInput) -> list[TextContent]:
    """레트로 세션 목록 조회."""
    try:
        params: dict = {"project_id": client.require_project_id()}
        if args.limit:
            params["limit"] = args.limit
        if args.cursor:
            params["cursor"] = args.cursor
        items, headers = await client.get_with_headers("/api/v2/retros", params=params)
        has_more, next_cursor = _has_more_from_headers(headers, items)
        return ok_paginated(items, has_more=has_more, next_cursor=next_cursor, tool_name="sprintable_list_retro_sessions")
    except Exception as exc:
        return err(exc)


async def create_retro_session(args: CreateRetroSessionInput) -> list[TextContent]:
    """레트로 세션 생성."""
    try:
        body: dict = {
            "title": args.title,
            "project_id": client.require_project_id(),
            "org_id": client.org_id,
            "created_by": args.created_by or client.member_id,
        }
        if args.sprint_id:
            body["sprint_id"] = args.sprint_id
        return ok(await client.post("/api/v2/retros", json=body))
    except Exception as exc:
        return err(exc)


async def vote_retro_item(args: VoteRetroItemInput) -> list[TextContent]:
    """레트로 아이템 투표."""
    try:
        return ok(await client.request(
            "POST",
            f"/api/v2/retros/{args.session_id}/items/{args.item_id}/vote",
        ))
    except Exception as exc:
        return err(exc)


async def add_retro_action(args: AddRetroActionInput) -> list[TextContent]:
    """레트로 액션 아이템 추가."""
    body: dict = {"title": args.title}
    if args.assignee_id:
        body["assignee_id"] = args.assignee_id
    try:
        return ok(await client.request(
            "POST",
            f"/api/v2/retros/{args.session_id}/actions",
            json=body,
        ))
    except Exception as exc:
        return err(exc)


async def change_retro_phase(args: ChangeRetroPhaseInput) -> list[TextContent]:
    """레트로 세션 단계 변경."""
    try:
        return ok(await client.request(
            "PATCH",
            f"/api/v2/retros/{args.session_id}/phase",
            json={"phase": args.phase},
        ))
    except Exception as exc:
        return err(exc)


async def add_retro_item(args: AddRetroItemInput) -> list[TextContent]:
    """레트로 아이템 추가 (good/bad/improve)."""
    try:
        return ok(await client.request(
            "POST",
            f"/api/v2/retros/{args.session_id}/items",
            json={"category": args.category, "text": args.text},
        ))
    except Exception as exc:
        return err(exc)


async def export_retro(args: ExportRetroInput) -> list[TextContent]:
    """레트로 마크다운 내보내기."""
    try:
        return ok(await client.get(f"/api/v2/retros/{args.session_id}/export"))
    except Exception as exc:
        return err(exc)
