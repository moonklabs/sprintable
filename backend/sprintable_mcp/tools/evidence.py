"""Evidence 자기증명 MCP 도구(1개) — E-VERIFY V0-S1(story 5a5ba27b)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class AddEvidenceInput(SprintableInput):
    work_item_id: str
    work_item_type: str  # "story" | "task"
    type: str  # url | file | pr | deploy | metric | report (gate_approval은 시스템 전용)
    ref: str
    source: str | None = None
    note: str | None = None


async def add_evidence(args: AddEvidenceInput) -> list[TextContent]:
    """done을 스스로 증명하는 자기 서명 첨부(검사지 아님) — story/task에 evidence(PR·배포·지표·
    발행물 링크 등)를 남긴다. 강제 아닌 선택제(경고나 낙인은 없음, 없으면 현행과 동일)."""
    try:
        payload = {
            "work_item_id": args.work_item_id,
            "work_item_type": args.work_item_type,
            "type": args.type,
            "ref": args.ref,
        }
        if args.source is not None:
            payload["source"] = args.source
        if args.note is not None:
            payload["note"] = args.note
        result = await client.post("/api/v2/evidence", json=payload)
        return ok(result)
    except Exception as exc:
        return err(str(exc))
