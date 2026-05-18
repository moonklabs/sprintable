"""레트로스펙티브 세션 MCP 도구 (7개)."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput

RetroPhase = Literal["collect", "group", "vote", "discuss", "action", "closed"]
RetroCategory = Literal["good", "bad", "improve"]


class ListRetroSessionsInput(SprintableInput):
    pass


class CreateRetroSessionInput(SprintableInput):
    title: str
    sprint_id: str | None = None
    created_by: str | None = None


class VoteRetroItemInput(SprintableInput):
    session_id: str
    item_id: str
    voter_id: str


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
    author_id: str


class ExportRetroInput(SprintableInput):
    session_id: str


async def list_retro_sessions(args: ListRetroSessionsInput) -> list[TextContent]:
    """레트로 세션 목록 조회."""
    try:
        return ok(await client.get("/api/v2/retro-sessions", params={"project_id": client.project_id}))
    except Exception as exc:
        return err(str(exc))


async def create_retro_session(args: CreateRetroSessionInput) -> list[TextContent]:
    """레트로 세션 생성."""
    body: dict = {
        "title": args.title,
        "project_id": client.project_id,
        "org_id": client.org_id,
        "created_by": args.created_by or client.member_id,
    }
    if args.sprint_id:
        body["sprint_id"] = args.sprint_id
    try:
        return ok(await client.post("/api/v2/retro-sessions", json=body))
    except Exception as exc:
        return err(str(exc))


async def vote_retro_item(args: VoteRetroItemInput) -> list[TextContent]:
    """레트로 아이템 투표."""
    try:
        return ok(await client.request(
            "POST",
            f"/api/v2/retro-sessions/{args.session_id}/items/{args.item_id}/vote",
            json={"voter_id": args.voter_id},
            params={"project_id": client.project_id},
        ))
    except Exception as exc:
        return err(str(exc))


async def add_retro_action(args: AddRetroActionInput) -> list[TextContent]:
    """레트로 액션 아이템 추가."""
    body: dict = {"title": args.title}
    if args.assignee_id:
        body["assignee_id"] = args.assignee_id
    try:
        return ok(await client.request(
            "POST",
            f"/api/v2/retro-sessions/{args.session_id}/actions",
            json=body,
            params={"project_id": client.project_id},
        ))
    except Exception as exc:
        return err(str(exc))


async def change_retro_phase(args: ChangeRetroPhaseInput) -> list[TextContent]:
    """레트로 세션 단계 변경."""
    try:
        return ok(await client.request(
            "PATCH",
            f"/api/v2/retro-sessions/{args.session_id}",
            json={"phase": args.phase},
            params={"project_id": client.project_id},
        ))
    except Exception as exc:
        return err(str(exc))


async def add_retro_item(args: AddRetroItemInput) -> list[TextContent]:
    """레트로 아이템 추가 (good/bad/improve)."""
    try:
        return ok(await client.request(
            "POST",
            f"/api/v2/retro-sessions/{args.session_id}/items",
            json={"category": args.category, "text": args.text, "author_id": args.author_id},
            params={"project_id": client.project_id},
        ))
    except Exception as exc:
        return err(str(exc))


async def export_retro(args: ExportRetroInput) -> list[TextContent]:
    """레트로 마크다운 내보내기."""
    try:
        return ok(await client.get(f"/api/v2/retro-sessions/{args.session_id}/export", params={"project_id": client.project_id}))
    except Exception as exc:
        return err(str(exc))
