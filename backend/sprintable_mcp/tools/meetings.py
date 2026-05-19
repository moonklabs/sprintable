"""미팅 관련 MCP 도구 (6개)."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput

MeetingType = Literal["standup", "retro", "general", "review"]


class ListMeetingsInput(SprintableInput):
    meeting_type: MeetingType | None = None
    date_from: str | None = None
    date_to: str | None = None
    limit: int | None = None


class MeetingIdInput(SprintableInput):
    meeting_id: str


class CreateMeetingInput(SprintableInput):
    title: str
    meeting_type: MeetingType | None = None
    date: str | None = None
    duration_min: int | None = None
    participants: list[dict] | None = None
    created_by: str | None = None


class UpdateMeetingInput(SprintableInput):
    meeting_id: str
    title: str | None = None
    meeting_type: MeetingType | None = None
    date: str | None = None
    duration_min: int | None = None
    participants: list[dict] | None = None
    raw_transcript: str | None = None
    ai_summary: str | None = None
    decisions: list[dict] | None = None
    action_items: list[dict] | None = None


async def list_meetings(args: ListMeetingsInput) -> list[TextContent]:
    """프로젝트 미팅 목록 조회."""
    params: dict = {"project_id": client.project_id}
    if args.meeting_type:
        params["meeting_type"] = args.meeting_type
    if args.date_from:
        params["date_from"] = args.date_from
    if args.date_to:
        params["date_to"] = args.date_to
    if args.limit is not None:
        params["limit"] = str(args.limit)
    try:
        return ok(await client.get("/api/v2/meetings", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_meeting(args: MeetingIdInput) -> list[TextContent]:
    """미팅 상세 조회."""
    try:
        return ok(await client.get(f"/api/v2/meetings/{args.meeting_id}"))
    except Exception as exc:
        return err(str(exc))


async def create_meeting(args: CreateMeetingInput) -> list[TextContent]:
    """미팅 생성."""
    body: dict = {"title": args.title, "project_id": client.project_id}
    for field in ("meeting_type", "date", "duration_min", "participants", "created_by"):
        val = getattr(args, field)
        if val is not None:
            body[field] = val
    try:
        return ok(await client.post("/api/v2/meetings", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_meeting(args: UpdateMeetingInput) -> list[TextContent]:
    """미팅 수정."""
    updates: dict = {}
    for field in ("title", "meeting_type", "date", "duration_min", "participants",
                  "raw_transcript", "ai_summary", "decisions", "action_items"):
        val = getattr(args, field)
        if val is not None:
            updates[field] = val
    try:
        return ok(await client.put(f"/api/v2/meetings/{args.meeting_id}", json=updates))
    except Exception as exc:
        return err(str(exc))


async def delete_meeting(args: MeetingIdInput) -> list[TextContent]:
    """미팅 소프트 삭제."""
    try:
        return ok(await client.delete(f"/api/v2/meetings/{args.meeting_id}"))
    except Exception as exc:
        return err(str(exc))


async def trigger_ai_summary(args: MeetingIdInput) -> list[TextContent]:
    """미팅 AI 요약 생성 트리거."""
    try:
        return ok(await client.post(f"/api/v2/meetings/{args.meeting_id}/summary", json={}))
    except Exception as exc:
        return err(str(exc))
