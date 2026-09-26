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
    "sprintable_update_doc": {"attachments": None},
    "sprintable_send_chat_message": {"attachments": None},
    # image_base64 · image_path 중 정확히 하나
    "sprintable_import_image_artifact": {"image_path": None, "image_base64": "iVBORw0KGgo="},
    # type 거름은 서버 미지원이라 도구가 스스로 막는다(조용한 전체 읽음 처리 방지 — 이 가드와 같은 취지의 선례)
    "sprintable_mark_all_notifications_read": {"type": None},
    # 구조 검증이 있는 dict(가드 대상은 이름 · 타입 · enum이지 이 자유 구조가 아니다) — 서버 검증을 통과하는 최소 모양.
    "sprintable_create_hypothesis": {"metric_definition": {"metric": "m", "source": "manual", "target": 1, "direction": "up"}},
    "sprintable_update_hypothesis": {"metric_definition": {"metric": "m", "source": "manual", "target": 1, "direction": "up"}},
    "sprintable_update_story": {"attachments": None, "metric_definition": {"metric": "m", "source": "manual", "target": 1, "direction": "up"}},
    # 서버: name은 key와 같으면 안 된다.
    "sprintable_register_event_definition": {"key": "org.slug.domain.act", "name": "Human name"},
    # 서버 교차 규칙: coord 핀은 node_id 없이 · node 핀은 좌표 없이(node 갈래는 아래 EXTRA_SCENARIOS).
    "sprintable_create_spec_pin": {"anchor_type": "coord", "node_id": None},
}

# 입력에 따라 다른 요청을 내는 도구의 추가 갈래(도구 이름 → 입력 덮어쓰기 목록).
EXTRA_SCENARIOS: dict[str, list[dict[str, typing.Any]]] = {
    "sprintable_create_spec_pin": [{"anchor_type": "node", "node_id": U, "anchor_x": None, "anchor_y": None}],
}

# 라우트가 `Request`를 직접 받아 본문을 손으로 검증하는 자리 → 그 모델. 코드 대조 근거는 아래 테스트가 매번 확인한다
# (라우트에 body_field가 없고 · 라우트 함수 소스가 그 모델의 model_validate를 부른다).
MANUAL_BODY_MODELS: dict[tuple[str, str], str] = {
    # story #3767 — 비-JSON 바이트가 FastAPI 기본 검증 오류 인코더에서 500으로 죽는 길을 피하려 Request로 받는다
    ("POST", "/api/v2/visual-artifacts/import-image"): "app.schemas.visual_artifact.ImportImageArtifactRequest",
}

# 백엔드 구현이 아직 안 온 자리(보냈는데 안 받음을 잠시 허용). 줄이기만 한다 — 구현되면 여기서 지워야 초록(실제 대조 결과와 정확히
# 같아야 하므로, 구현되고도 남아 있으면 RED). story #4329 PR B가 여섯 줄을 모두 구현해 비었다.
PENDING_BACKEND: set[tuple[str, str, str]] = set()


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
    if name.endswith("_id") or name == "id" or name.endswith("_by"):
        return U
    if "date" in name or name.endswith(("_at", "_after", "_before")) or name in ("since", "until", "before"):
        return "2026-09-25T00:00:00Z"
    if "url" in name:
        return "https://example.com/hook"
    return "x"


@dataclass
class Sent:
    tool: str
    method: str
    path: str
    query: set[str]
    body: set[str] | None
    # story #4329(까디르 ①) — 이름뿐 아니라 값도 대조한다(필수 · 타입 · enum).
    query_values: dict[str, typing.Any] = field(default_factory=dict)
    body_values: dict[str, typing.Any] | None = None


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
        # 실 `client.request`가 쓰기 본문에 채우는 문맥 필드(api_client.py «context 필드 자동 주입»)를 그대로 — 안 채우면
        # 백엔드 필수 org_id 등이 «안 보냄»으로 거짓 RED(까디르 ① 값 대조).
        # 이름 대조(`body`)는 도구가 직접 실은 것만 — 채워 넣는 문맥 필드는 도구 계약이 아니라 클라이언트 전역 동작이다.
        body = set(json) if isinstance(json, dict) else None
        if method.upper() in ("POST", "PUT", "PATCH") and json is not None:
            for key, value in (("project_id", U), ("org_id", U), ("created_by", U)):
                if not json.get(key):
                    json = {**json, key: value}
        out.sent.append(Sent(
            current[0], method.upper(), path.split("?")[0], set(params or {}), body,
            query_values=dict(params or {}), body_values=dict(json) if isinstance(json, dict) else None,
        ))
        return ([], httpx.Headers()) if return_headers else {}

    monkeypatch.setattr(client, "request", record)
    for name, _doc, cls, fn in tool_defs:
        hints = typing.get_type_hints(cls)
        base = {f: dummy(f, hints.get(f, str)) for f in cls.model_fields}
        # 까디르 ① — MCP가 허용하는 enum(Literal) 값마다 한 갈래 더: 백엔드가 받지 않는 값을 MCP가 허용하면 여기서 드러난다.
        # 교차 규칙 때문에 손으로 적은 갈래(EXTRA_SCENARIOS)가 이미 그 필드를 다루면 자동 갈래는 건너뛴다.
        covered = {f for extra in EXTRA_SCENARIOS.get(name, []) for f in extra}
        literal_scenarios = [
            {f: v} for f in cls.model_fields if f not in covered for v in _literal_values(hints.get(f, str))[1:]
        ]
        for overrides in [INPUT_OVERRIDES.get(name, {}), *EXTRA_SCENARIOS.get(name, []), *literal_scenarios]:
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


def _literal_values(ann: typing.Any) -> list[typing.Any]:
    """`Literal[...]`(Optional 안쪽 포함)의 값들 — 아니면 빈 목록."""
    origin, args = typing.get_origin(ann), typing.get_args(ann)
    if origin in (typing.Union, types.UnionType):
        return [v for a in args for v in _literal_values(a)]
    if origin is typing.Literal:
        return list(args)
    return []


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


def _body_model(route, method: str):
    if route.body_field is not None:
        return route.body_field.field_info.annotation
    if (method, route.path) in MANUAL_BODY_MODELS:
        return _import(MANUAL_BODY_MODELS[(method, route.path)])
    return None


def _as_sent_on_the_wire(value: typing.Any) -> typing.Any:
    """httpx가 쿼리로 실어 보내는 모양(문자열 · 목록이면 문자열 목록) — 백엔드는 이것을 받는다."""
    encoded = httpx.QueryParams({"v": value})
    many = encoded.get_list("v")
    return many if isinstance(value, (list, tuple)) else (many[0] if many else "")


def contract_errors(app, sent: list[Sent]) -> set[tuple[str, str, str, str]]:
    """story #4329(까디르 ①) — (도구, 'query'|'body', 이름, 사유): 백엔드가 **필수**인데 안 보냄 · 보낸 값이 백엔드 **타입/enum**을 통과 못 함.
    이름 대조(`unread`)는 «안 받는 것»만 봤다 — 이쪽은 반대 방향(요구하는데 안 보냄)과 값."""
    from fastapi.dependencies.utils import get_flat_dependant
    from pydantic import TypeAdapter, ValidationError

    out: set[tuple[str, str, str, str]] = set()
    for s in sent:
        route = route_for(app, s.method, s.path)
        if route is None:
            continue
        for p in get_flat_dependant(route.dependant).query_params:
            if p.alias not in s.query_values:
                if p.field_info.is_required():
                    out.add((s.tool, "query", p.alias, "required but not sent"))
                continue
            try:
                TypeAdapter(p.field_info.annotation).validate_python(_as_sent_on_the_wire(s.query_values[p.alias]))
            except ValidationError as exc:
                out.add((s.tool, "query", p.alias, exc.errors()[0]["type"]))
        model = _body_model(route, s.method)
        if model is None or s.body_values is None:
            continue
        try:
            model.model_validate(s.body_values)
        except ValidationError as exc:
            for err in exc.errors():
                if err["type"] == "extra_forbidden":
                    continue  # 안 받는 이름은 `unread`가 본다
                loc = str(err["loc"][0]) if err["loc"] else "?"
                out.add((s.tool, "body", loc, "required but not sent" if err["type"] == "missing" else err["type"]))
    return out


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


@pytest.mark.anyio
async def test_backend_required_parameters_are_sent_and_every_sent_value_passes_backend_validation(monkeypatch):
    """까디르 ①(4689) — 이름 대조는 한 방향(보냈는데 안 받음)만 봤다. 반대 방향과 값: 백엔드 필수인데 안 보냄 · 타입이 안 맞음 ·
    MCP가 허용하는 enum 값을 백엔드가 거절(예: 회고 단계 group · discuss → 400). 각 enum 값은 한 갈래씩 따로 돈다."""
    from app.main import app
    from sprintable_mcp.server import _TOOL_DEFS

    probe = await probe_tools(monkeypatch, _TOOL_DEFS)
    assert probe.input_errors == []
    assert contract_errors(app, probe.sent) == set()


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

    # 까디르 ① 양성 대조 — 필수 안 보냄 · 타입 어긋남 · enum 밖 값(MCP Literal의 두 번째 값) 셋 다 잡힌다.
    class _KindIn(BaseModel):
        meeting_type: typing.Literal["standup", "planning"]

    async def phase_without_required(args):  # 필수 본문 phase를 빼고 보냄
        await client.request("PATCH", f"/api/v2/retros/{U}/phase", json={})

    async def kind_enum(args):  # MCP가 planning까지 허용 — 백엔드 MeetingType(Literal)은 모름
        await client.get("/api/v2/meetings", params={"project_id": U, "meeting_type": args.meeting_type})

    async def by_work_item_without_required(args):  # 필수 쿼리 work_item_id를 빼고 보냄
        await client.get("/api/v2/conversations/by-work-item", params={"work_item_type": "story"})

    async def leaderboard_bad_type(args):  # limit에 숫자 아닌 값
        await client.get("/api/v2/rewards/leaderboard", params={"project_id": U, "limit": "many"})

    probe3 = await probe_tools(monkeypatch, [
        ("phase_without_required", "", _ProbeIn, phase_without_required),
        ("kind_enum", "", _KindIn, kind_enum),
        ("leaderboard_bad_type", "", _ProbeIn, leaderboard_bad_type),
        ("by_work_item_without_required", "", _ProbeIn, by_work_item_without_required),
    ])
    errors = contract_errors(app, probe3.sent)
    assert ("phase_without_required", "body", "phase", "required but not sent") in errors
    assert ("by_work_item_without_required", "query", "work_item_id", "required but not sent") in errors
    assert any(e[:3] == ("kind_enum", "query", "meeting_type") for e in errors), errors
    assert sum(1 for e in errors if e[0] == "kind_enum") == 1, "standup은 통과 · planning 갈래만 RED(값마다 한 갈래)"
    assert any(e[:3] == ("leaderboard_bad_type", "query", "limit") for e in errors), errors

    async def silent(args):
        return None

    probe2 = await probe_tools(monkeypatch, [("silent", "", _ProbeIn, silent)])
    assert probe2.no_call == ["silent"], "요청 없는 도구는 대조 공백으로 드러난다"


# ── 뺀 인자 거절 문구(PO 요청: 이유 + 대안을 말해 에이전트가 스스로 고친다) ─────────────────────────────────
@pytest.mark.anyio
@pytest.mark.parametrize(
    ("tool_name", "args", "hint"),
    [
        ("sprintable_vote_retro_item", {"session_id": U, "item_id": U, "voter_id": U}, "대리 투표 없음"),
        ("sprintable_send_chat_message", {"conversation_id": U, "content": "x", "message_type": "report"}, "`message_kind`"),
        ("sprintable_send_chat_message", {"conversation_id": U, "content": "x", "review_type": "design"}, "`message_kind`"),
        ("sprintable_send_chat_message", {"conversation_id": U, "content": "x", "metadata": {"k": "v"}}, "`message_kind`"),
    ],
)
async def test_a_removed_argument_is_refused_with_the_reason_and_what_to_do_instead(tool_name, args, hint):
    from mcp.server.mcpserver import Context
    from sprintable_mcp import server as srv

    tool = srv.mcp._tool_manager.get_tool(tool_name)
    with pytest.raises(Exception) as ei:
        await tool.run(args, Context())
    msg = str(ei.value)
    removed = next(k for k in args if k in {"voter_id", "message_type", "review_type", "metadata"})
    assert f"`{removed}`" in msg and hint in msg and "accepted arguments" in msg, msg
    assert "다시 부르세요" in msg, msg


def test_removed_arg_table_names_only_arguments_the_tool_no_longer_accepts():
    """표의 인자가 도구에 다시 생기면(살아 있는 인자에 «빼세요» 안내가 붙으면) RED · 없는 도구 이름도 RED."""
    from sprintable_mcp import server as srv
    from sprintable_mcp.removed_args import REMOVED_ARGS

    for tool_name, hints in REMOVED_ARGS.items():
        tool = srv.mcp._tool_manager.get_tool(tool_name)
        assert tool is not None, tool_name
        assert set(hints) & set(tool.fn_metadata.arg_model.model_fields) == set(), tool_name


@pytest.mark.anyio
async def test_an_unrelated_unknown_argument_gets_no_removed_arg_hint():
    from mcp.server.mcpserver import Context
    from sprintable_mcp import server as srv

    tool = srv.mcp._tool_manager.get_tool("sprintable_vote_retro_item")
    with pytest.raises(Exception) as ei:
        await tool.run({"session_id": U, "item_id": U, "bogus": 1}, Context())
    msg = str(ei.value)
    assert "bogus" in msg and "accepted arguments" in msg and "다시 부르세요" not in msg, msg


def test_mcp_enums_equal_the_backend_value_sets():
    """까디르 ①(4689) — MCP가 str로 받던 값 중 백엔드가 고정 집합으로 거르는 자리는 MCP도 같은 Literal로. 한쪽만 바뀌면 RED."""
    from app.models.evidence import _CLIENT_CREATABLE_TYPES
    from app.routers.evidence import _WORK_ITEM_TYPES
    from app.schemas.visual_artifact import _SPEC_PIN_ANCHOR_TYPES
    from sprintable_mcp.tools.evidence import AddEvidenceInput
    from sprintable_mcp.tools.visual_artifacts import CreateSpecPinInput

    def values(model, field_name):
        return set(_literal_values(typing.get_type_hints(model)[field_name]))

    assert values(AddEvidenceInput, "work_item_type") == set(_WORK_ITEM_TYPES)
    assert values(AddEvidenceInput, "type") == set(_CLIENT_CREATABLE_TYPES)
    assert values(CreateSpecPinInput, "anchor_type") == set(_SPEC_PIN_ANCHOR_TYPES)
