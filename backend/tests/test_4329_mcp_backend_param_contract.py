"""story #4329 AC2 · AC3 — MCP 도구가 보내는 파라미터를 백엔드 라우트가 실제로 받는지 전수 대조하는 가드.

실사고: `list_meetings`의 `date_from` · `date_to`, `get_wallet`의 `balance`, `get_leaderboard_v2`의 `type` 등 — MCP가 보내는데 라우트가
모르는 파라미터를 FastAPI가 오류 없이 버려, 에이전트는 거른(또는 다른) 결과인 줄 알고 틀린 결과를 받았다.

방법(정적 소스 파싱이 아니라 실제 호출):
1. `_TOOL_DEFS`의 도구 핸들러를 **입력 필드를 전부 채워** 부른다 — `client.request`를 기록기로 바꿔 HTTP는 안 나간다.
2. 기록된 요청(메서드 · 경로)을 FastAPI 앱의 라우트에 starlette 매칭으로 **실제로** 맞춘다.
3. 라우트가 받는 쿼리 파라미터(하위 의존성까지 펼친 `get_flat_dependant`) · 본문 모델 필드와 대조 — 보냈는데 안 받는 것 → RED.

한계(PR 본문에도 적음): 입력을 다 채운 **한 갈래**만 돈다. 입력에 따라 다른 엔드포인트로 가는 분기는 이 테스트가 못 본다 —
그런 도구는 `EXTRA_SCENARIOS`에 입력을 더 적어 갈래를 늘린다.
"""
from __future__ import annotations

import enum
import inspect
import types
import typing
from dataclasses import dataclass, field

import httpx
import pytest
from pydantic import BaseModel

U = "11111111-1111-4111-8111-111111111111"

# 입력을 다 채우면 도구 자체 검증에 걸려 요청 전에 멈추는 도구 — 그 필드만 비우거나 바꾼다(각 이유).
INPUT_OVERRIDES: dict[str, dict[str, typing.Any]] = {
    # attachments는 {content_base64, name, content_type} 구조 검증 + 별도 업로드 경로 — 대조 대상(본문 필드)과 무관
    "sprintable_update_story": {"attachments": None},
    "sprintable_update_doc": {"attachments": None},
    "sprintable_send_chat_message": {"attachments": None},
    # image_base64 · image_path 중 정확히 하나
    "sprintable_import_image_artifact": {"image_path": None, "image_base64": "iVBORw0KGgo="},
    # type 거름은 서버 미지원이라 도구가 스스로 막는다(조용한 전체 읽음 처리 방지 — 이 가드와 같은 취지의 선례)
    "sprintable_mark_all_notifications_read": {"type": None},
}

# 입력에 따라 다른 요청을 내는 도구의 추가 갈래(도구 이름 → 입력 덮어쓰기 목록).
EXTRA_SCENARIOS: dict[str, list[dict[str, typing.Any]]] = {}

# 라우트가 `Request`를 직접 받아 본문을 손으로 검증하는 자리 → 그 모델. 코드 대조 근거는 아래 테스트가 매번 확인한다
# (라우트에 body_field가 없고 · 라우트 함수 소스가 그 모델의 model_validate를 부른다).
MANUAL_BODY_MODELS: dict[tuple[str, str], str] = {
    # story #3767 — 비-JSON 바이트가 FastAPI 기본 검증 오류 인코더에서 500으로 죽는 길을 피하려 Request로 받는다
    ("POST", "/api/v2/visual-artifacts/import-image"): "app.schemas.visual_artifact.ImportImageArtifactRequest",
}

# 백엔드 구현이 story #4329 PR B로 오는 자리(PO 확정: BE 구현). 줄이기만 한다 — PR B가 구현하면 여기서 지워야 초록
# (실제 대조 결과와 정확히 같아야 하므로, 구현되고도 남아 있으면 RED).
PENDING_BACKEND: set[tuple[str, str, str]] = {
    ("sprintable_list_meetings", "query", "date_from"),
    ("sprintable_list_meetings", "query", "date_to"),
    ("sprintable_list_meetings", "query", "limit"),
    ("sprintable_get_unassigned_stories", "query", "unassigned"),
    ("sprintable_list_stories", "query", "priority"),
    ("sprintable_check_notifications", "query", "type"),
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def dummy(name: str, ann: typing.Any) -> typing.Any:
    """필드 이름 · 타입으로 그럴듯한 값 — 도구 입력 검증을 통과하고 요청까지 가게."""
    origin, args = typing.get_origin(ann), typing.get_args(ann)
    if origin in (typing.Union, types.UnionType):
        non_none = [a for a in args if a is not type(None)]
        return dummy(name, non_none[0]) if non_none else None
    if origin is typing.Literal:
        return args[0]
    if origin is list:
        return [dummy(name[:-1] if name.endswith("_ids") else name, args[0] if args else str)]
    if origin is dict:
        return {"k": "v"}
    if isinstance(ann, type) and issubclass(ann, enum.Enum):
        return next(iter(ann)).value
    if ann is bool:
        return True
    if ann is int:
        return 1
    if ann is float:
        return 1.0
    if isinstance(ann, type) and issubclass(ann, BaseModel):
        return {f: dummy(f, fi.annotation) for f, fi in ann.model_fields.items()}
    if isinstance(ann, type) and issubclass(ann, dict):
        return {"k": "v"}
    if name.endswith("_id") or name == "id":
        return U
    if "date" in name or name.endswith("_at") or name in ("since", "until", "before"):
        return "2026-09-25T00:00:00Z"
    return "x"


@dataclass
class Sent:
    tool: str
    method: str
    path: str
    query: set[str]
    body: set[str] | None


@dataclass
class Probe:
    sent: list[Sent] = field(default_factory=list)
    no_call: list[str] = field(default_factory=list)
    input_errors: list[str] = field(default_factory=list)


async def probe_tools(monkeypatch, tool_defs) -> Probe:
    from sprintable_mcp.api_client import client

    monkeypatch.setattr(client, "_project_id", U)
    monkeypatch.setattr(client, "_org_id", U)
    monkeypatch.setattr(client, "_member_id", U)
    current: list[str] = [""]
    out = Probe()

    async def record(method, path, *, json=None, params=None, unwrap=True, return_headers=False):
        body = set(json) if isinstance(json, dict) else None
        out.sent.append(Sent(current[0], method.upper(), path.split("?")[0], set(params or {}), body))
        return ([], httpx.Headers()) if return_headers else {}

    monkeypatch.setattr(client, "request", record)
    for name, _doc, cls, fn in tool_defs:
        hints = typing.get_type_hints(cls)
        base = {f: dummy(f, hints.get(f, str)) for f in cls.model_fields}
        for overrides in [INPUT_OVERRIDES.get(name, {}), *EXTRA_SCENARIOS.get(name, [])]:
            current[0] = name
            before = len(out.sent)
            try:
                args = cls(**{**base, **INPUT_OVERRIDES.get(name, {}), **overrides})
            except Exception as exc:  # noqa: BLE001 — 입력 생성 실패는 목록으로 드러낸다
                out.input_errors.append(f"{name}: {str(exc)[:160]}")
                continue
            await fn(args)
            if len(out.sent) == before:
                out.no_call.append(name)
    return out


def route_for(app, method: str, path: str):
    from starlette.routing import Match

    for r in app.router.routes:
        if not hasattr(r, "dependant"):
            continue
        match, _ = r.matches({"type": "http", "path": path, "method": method, "root_path": ""})
        if match == Match.FULL:
            return r
    return None


def _import(dotted: str):
    mod, _, attr = dotted.rpartition(".")
    return getattr(__import__(mod, fromlist=[attr]), attr)


def accepted(route, method: str) -> tuple[set[str], set[str] | None]:
    """라우트가 받는 쿼리 이름 · 본문 필드 이름(None = 본문 모델 없음)."""
    from fastapi.dependencies.utils import get_flat_dependant

    flat = get_flat_dependant(route.dependant)
    query = {p.alias for p in flat.query_params}
    body: set[str] | None = None
    if route.body_field is not None:
        model = route.body_field.field_info.annotation
        body = {fi.alias or f for f, fi in model.model_fields.items()}
    elif (method, route.path) in MANUAL_BODY_MODELS:
        model = _import(MANUAL_BODY_MODELS[(method, route.path)])
        body = {fi.alias or f for f, fi in model.model_fields.items()}
    return query, body


def unread(app, sent: list[Sent]) -> tuple[set[tuple[str, str, str]], list[str]]:
    """(도구, 'query'|'body', 이름) — 보냈는데 라우트가 안 받는 것 · 라우트 없는 요청."""
    out: set[tuple[str, str, str]] = set()
    no_route: list[str] = []
    for s in sent:
        route = route_for(app, s.method, s.path)
        if route is None:
            no_route.append(f"{s.tool}: {s.method} {s.path}")
            continue
        query, body = accepted(route, s.method)
        out |= {(s.tool, "query", q) for q in s.query - query}
        if s.body:
            out |= {(s.tool, "body", b) for b in s.body - (body or set())}
    return out, no_route


# ── 가드 ────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_every_parameter_an_mcp_tool_sends_is_read_by_its_backend_route(monkeypatch):
    from app.main import app
    from sprintable_mcp.server import _TOOL_DEFS

    probe = await probe_tools(monkeypatch, _TOOL_DEFS)
    assert probe.input_errors == [], "입력을 못 만든 도구 — dummy/INPUT_OVERRIDES 보강"
    assert probe.no_call == [], "요청을 안 낸 도구 — 대조 공백(INPUT_OVERRIDES로 요청까지 가게)"
    assert {s.tool for s in probe.sent} == {name for name, *_ in _TOOL_DEFS}, "모든 도구가 대조됐다"
    found, no_route = unread(app, probe.sent)
    assert no_route == [], "매칭되는 백엔드 라우트가 없는 요청"
    assert found - PENDING_BACKEND == set(), "MCP가 보내는데 백엔드가 안 받는 파라미터(조용히 버려짐)"
    assert PENDING_BACKEND - found == set(), "구현돼 더는 버려지지 않는 항목 — PENDING_BACKEND에서 지운다(줄이기만)"


def test_manual_body_mappings_match_the_route_code():
    """직접 파싱 매핑은 코드 근거가 있어야 한다 — 라우트에 본문 모델이 없고 · 함수 소스가 그 모델로 검증한다."""
    from app.main import app

    for (method, path), dotted in MANUAL_BODY_MODELS.items():
        route = route_for(app, method, path)
        assert route is not None, path
        assert route.body_field is None, f"{path}는 이제 본문 모델이 있다 — 매핑 지운다"
        assert f"{dotted.rpartition('.')[2]}.model_validate" in inspect.getsource(route.endpoint), path


# ── 양성 대조 ───────────────────────────────────────────────────────────────────────────────────────
class _ProbeIn(BaseModel):
    member_id: str
    limit: int | None = None


@pytest.mark.anyio
async def test_controls_catch_unread_query_unread_body_and_unmapped_manual_parse(monkeypatch):
    from app.main import app
    from sprintable_mcp.api_client import client

    async def old_get_wallet(args):  # 4329 이전 get_wallet 그대로 — 적립 목록 라우트에 balance
        await client.get("/api/v2/rewards", params={"project_id": U, "member_id": args.member_id, "balance": "true"})

    async def fixed_get_wallet(args):
        await client.get("/api/v2/rewards/balance", params={"project_id": U, "member_id": args.member_id})

    async def old_vote(args):  # 4329 이전 vote_retro_item — 본문 없는 라우트에 voter_id
        await client.request("POST", f"/api/v2/retros/{U}/items/{U}/vote", json={"voter_id": args.member_id})

    async def import_image(args):
        await client.post("/api/v2/visual-artifacts/import-image", json={"title": "t", "image_base64": "x", "content_type": "image/png"})

    probe = await probe_tools(monkeypatch, [
        ("old_get_wallet", "", _ProbeIn, old_get_wallet),
        ("fixed_get_wallet", "", _ProbeIn, fixed_get_wallet),
        ("old_vote", "", _ProbeIn, old_vote),
        ("import_image", "", _ProbeIn, import_image),
    ])
    found, no_route = unread(app, probe.sent)
    assert no_route == []
    assert found == {("old_get_wallet", "query", "balance"), ("old_vote", "body", "voter_id")}

    saved = dict(MANUAL_BODY_MODELS)
    MANUAL_BODY_MODELS.clear()
    try:
        found_unmapped, _ = unread(app, probe.sent)
    finally:
        MANUAL_BODY_MODELS.update(saved)
    assert {("import_image", "body", "title"), ("import_image", "body", "image_base64")} <= found_unmapped, "매핑 없으면 직접 파싱 라우트 본문은 안 받는 것으로 잡힌다"

    async def silent(args):
        return None

    probe2 = await probe_tools(monkeypatch, [("silent", "", _ProbeIn, silent)])
    assert probe2.no_call == ["silent"], "요청 없는 도구는 대조 공백으로 드러난다"
