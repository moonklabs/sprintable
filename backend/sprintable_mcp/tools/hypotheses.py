"""Hypothesis 관련 MCP 도구 (6개) — 블루프린트 §4.

v2 /api/v2/hypotheses API의 얇은 HTTP 래퍼. 권한(agent 호출=proposed 강제·active 확정=
휴먼만)은 백엔드 API가 SSOT로 강제하므로 도구는 통과만 한다. list는 agent context 비용을
줄이기 위해 compact 필드만 반환하고, get은 source_snapshot을 truncate한다.
"""
from __future__ import annotations

import json

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import HypothesisConfirmStatus, HypothesisStatus, SprintableInput

_SNAPSHOT_MAX = 1024


class ListHypothesesInput(SprintableInput):
    epic_id: str | None = None
    story_id: str | None = None
    status: HypothesisStatus | None = None
    owner_member_id: str | None = None
    limit: int | None = None


class GetHypothesisInput(SprintableInput):
    hypothesis_id: str


class CreateHypothesisInput(SprintableInput):
    statement: str
    metric_definition: dict
    measure_after: str
    owner_member_id: str | None = None
    epic_ids: list[str] | None = None
    story_ids: list[str] | None = None
    source_type: str | None = None
    source_id: str | None = None


class UpdateHypothesisInput(SprintableInput):
    hypothesis_id: str
    statement: str | None = None
    metric_definition: dict | None = None
    measure_after: str | None = None
    owner_member_id: str | None = None


class LinkHypothesisInput(SprintableInput):
    hypothesis_id: str
    epic_ids: list[str] | None = None
    story_ids: list[str] | None = None
    link_type: str | None = None


class ConfirmHypothesisInput(SprintableInput):
    hypothesis_id: str
    status: HypothesisConfirmStatus
    note: str | None = None


def _compact(h: dict) -> dict:
    """§4.1.1 compact list 항목 — outcome_result/source_snapshot/긴 metadata 제외."""
    md = h.get("metric_definition") or {}
    return {
        "id": h.get("id"),
        "status": h.get("status"),
        "statement": h.get("statement"),
        "metric": md.get("metric"),
        "target": md.get("target"),
        "direction": md.get("direction"),
        "measure_after": h.get("measure_after"),
        "epic_ids": h.get("epic_ids", []),
        "story_ids": h.get("story_ids", []),
    }


async def list_hypotheses(args: ListHypothesesInput) -> list[TextContent]:
    """가설 목록(compact). epic_id/story_id/status/owner_member_id/limit 필터."""
    params: dict = {"project_id": client.project_id}
    if args.epic_id:
        params["epic_id"] = args.epic_id
    if args.story_id:
        params["story_id"] = args.story_id
    if args.status is not None:
        params["status"] = args.status.value
    if args.owner_member_id:
        params["owner_member_id"] = args.owner_member_id
    if args.limit is not None:
        params["limit"] = args.limit
    try:
        rows = await client.get("/api/v2/hypotheses", params=params)
        return ok([_compact(h) for h in (rows or [])])
    except Exception as exc:
        return err(str(exc))


async def get_hypothesis(args: GetHypothesisInput) -> list[TextContent]:
    """가설 단건(full). source_snapshot은 1KB로 truncate."""
    try:
        h = await client.get(f"/api/v2/hypotheses/{args.hypothesis_id}")
        snap = h.get("source_snapshot") if isinstance(h, dict) else None
        if snap is not None:
            text = json.dumps(snap, ensure_ascii=False)
            if len(text) > _SNAPSHOT_MAX:
                h["source_snapshot"] = {"_truncated": text[:_SNAPSHOT_MAX]}
        return ok(h)
    except Exception as exc:
        return err(str(exc))


async def create_hypothesis(args: CreateHypothesisInput) -> list[TextContent]:
    """가설 생성. agent/API key 호출은 서버가 status='proposed'로 강제한다(§4.1.3).

    metric_definition(dict) 계약(backend _validate_metric_definition·검증 SSOT):
      필수: metric(str), source(ga4|internal_ops|manual), target(number), direction(up|down).
      source='ga4'이면 추가 필수: property_id, ga4_metric, date_range_days(양의 정수).

    owner_member_id(휴먼 멤버) — agent 호출은 명시 필수다. 백엔드(services/hypothesis.create_hypothesis)는
    휴먼 caller만 self를 owner로 기본 적용하고, agent caller가 생략하면 400 HUMAN_OWNER_REQUIRED를 낸다.
    MCP auth context의 member_id는 *에이전트* 멤버라 휴먼 default로 쓸 수 없고(다시 같은 400),
    임의 휴먼을 추측-주입하는 것은 owner 의미를 왜곡한다. 따라서 여기서는 default를 만들지 않고,
    개선된 에러 표면화(api_client._extract_error_message)로 사유를 명확히 전달하는 쪽을 택한다.
    """
    body: dict = {
        "project_id": client.project_id,
        "statement": args.statement,
        "metric_definition": args.metric_definition,
        "measure_after": args.measure_after,
    }
    for field in ("owner_member_id", "epic_ids", "story_ids", "source_type", "source_id"):
        val = getattr(args, field)
        if val is not None:
            body[field] = val
    try:
        return ok(await client.post("/api/v2/hypotheses", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_hypothesis(args: UpdateHypothesisInput) -> list[TextContent]:
    """가설 수정(문장/지표/측정일/owner). status 전이는 confirm 도구로(§4.1.4)."""
    updates: dict = {}
    for field in ("statement", "metric_definition", "measure_after", "owner_member_id"):
        val = getattr(args, field)
        if val is not None:
            updates[field] = val
    try:
        return ok(await client.patch(f"/api/v2/hypotheses/{args.hypothesis_id}", json=updates))
    except Exception as exc:
        return err(str(exc))


async def link_hypothesis(args: LinkHypothesisInput) -> list[TextContent]:
    """가설↔epic/story 연결/재연결(§4.1.5). 별도 story update 확장 없이 이 도구로."""
    body: dict = {}
    if args.epic_ids is not None:
        body["epic_ids"] = args.epic_ids
    if args.story_ids is not None:
        body["story_ids"] = args.story_ids
    if args.link_type is not None:
        body["link_type"] = args.link_type
    try:
        return ok(await client.post(f"/api/v2/hypotheses/{args.hypothesis_id}/links", json=body))
    except Exception as exc:
        return err(str(exc))


async def confirm_hypothesis(args: ConfirmHypothesisInput) -> list[TextContent]:
    """가설 확정(active) 또는 폐기(killed). active 확정은 휴먼 경로만 허용(서버 강제·§4.1.6)."""
    body: dict = {"status": args.status.value}
    if args.note is not None:
        body["note"] = args.note
    try:
        return ok(await client.post(f"/api/v2/hypotheses/{args.hypothesis_id}/transition", json=body))
    except Exception as exc:
        return err(str(exc))
