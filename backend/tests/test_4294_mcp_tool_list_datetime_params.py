"""story #4294 AC3 — 에이전트가 실제로 보는 MCP 도구 목록(설명 문자열)에 «기간 파라미터는 오프셋 필수»가 있어야 한다.

PO 배포 30 판정: API는 오프셋 없는 일시에 422 `DATETIME_OFFSET_REQUIRED`를 잘 주는데, 규칙이 파이썬 docstring · 필드 주석에만 있어
도구 목록에 안 닿았다(`_flat()`이 입력 모델 필드를 설명 없이 시그니처로 옮기므로 필드 주석은 스키마에도 없다).

세 가드:
1. 스냅샷 — 도구 목록에서 일시처럼 생긴 파라미터 전부를 분류와 함께 고정. 새 일시 파라미터가 생기면 분류하라고 RED.
2. 설명 — «오프셋 필수»로 분류된 파라미터는 그 도구 설명에 `offset_required_note`(파라미터 이름 포함)가 있다.
3. 층 대조 — BE가 `aware_datetime_query` · `require_aware`로 오프셋을 요구하는 쿼리 파라미터에 MCP 도구 핸들러가 값을 넘기면,
   그 도구 파라미터는 «오프셋 필수»로 분류돼 있어야 한다(분류를 잘못 적어 2를 피하는 길을 막는다).
"""
from __future__ import annotations

import inspect
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, ".")

BACKEND = Path(__file__).resolve().parents[1]

# 일시처럼 생긴 파라미터 이름(도구 목록 스캔용).
TIME_LIKE = re.compile(r"^(since|until|from_?|to|start|end|before|after|date|date_[a-z]+|[a-z_]*_(at|date|from|to|since|until|timestamp|before|after))$")

OFFSET_REQUIRED = "offset_required"  # BE 기간 쿼리 — 오프셋 없으면 422
DATE_ONLY = "date_only"  # YYYY-MM-DD(시각 없음)
CURSOR = "cursor"  # 서버가 발급한 값을 그대로 돌려줌
CONCURRENCY_TOKEN = "concurrency_token"  # 서버가 준 updated_at을 그대로 돌려줌(낙관적 잠금)
WRITE_TIMESTAMP = "write_timestamp"  # 기간 질의가 아니라 기록하는 값(본문) — 4294 범위 밖
NOT_APPLIED_BY_SERVER = "not_applied_by_server"  # 서버가 읽지 않는 파라미터(별도 결함으로 PO 보고)

SNAPSHOT: dict[str, dict[str, str]] = {
    "sprintable_get_session_context": {"since": OFFSET_REQUIRED},
    "sprintable_add_goal": {"target_date": DATE_ONLY},
    "sprintable_update_goal": {"target_date": DATE_ONLY, "measure_after": WRITE_TIMESTAMP},
    "sprintable_add_epic": {"target_date": DATE_ONLY},
    "sprintable_update_epic": {"target_date": DATE_ONLY, "measure_after": WRITE_TIMESTAMP},
    "sprintable_create_sprint": {"start_date": DATE_ONLY, "end_date": DATE_ONLY},
    "sprintable_update_sprint": {"start_date": DATE_ONLY, "end_date": DATE_ONLY},
    "sprintable_standup_missing": {"date": DATE_ONLY},
    "sprintable_get_standup": {"date": DATE_ONLY},
    "sprintable_save_standup": {"date": DATE_ONLY},
    "sprintable_list_standup_entries": {"date": DATE_ONLY},
    "sprintable_checkin_sprint": {"date": DATE_ONLY},
    "sprintable_list_chat_messages": {"before": CURSOR},
    "sprintable_check_notifications": {"before": CURSOR},
    "sprintable_update_doc": {"expected_updated_at": CONCURRENCY_TOKEN},
    "sprintable_create_meeting": {"date": WRITE_TIMESTAMP},
    "sprintable_update_meeting": {"date": WRITE_TIMESTAMP},
    "sprintable_emit_event": {"started_at": WRITE_TIMESTAMP, "finished_at": WRITE_TIMESTAMP},
    "sprintable_update_run_status": {"started_at": WRITE_TIMESTAMP, "finished_at": WRITE_TIMESTAMP},
    # measure_after — 결과를 잴 시각(본문 datetime · 기록하는 값).
    "sprintable_create_hypothesis": {"measure_after": WRITE_TIMESTAMP},
    "sprintable_update_hypothesis": {"measure_after": WRITE_TIMESTAMP},
    "sprintable_update_story": {"measure_after": WRITE_TIMESTAMP},
    # GET /api/v2/meetings는 date_from · date_to를 읽지 않는다(필터가 조용히 무시됨) — 4294 범위 밖, PO에 별도 보고.
    "sprintable_list_meetings": {"date_from": NOT_APPLIED_BY_SERVER, "date_to": NOT_APPLIED_BY_SERVER},
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _tool_list(monkeypatch) -> dict[str, tuple[str, set[str]]]:
    from sprintable_mcp import server as srv

    monkeypatch.setattr(srv.settings, "mcp_transport", "stdio")  # stdio = 범위 거름 없이 등록 도구 전부
    tools = await srv.mcp.list_tools()
    return {t.name: (t.description or "", set((t.input_schema or {}).get("properties", {}))) for t in tools}


def time_like_params(tools: dict[str, tuple[str, set[str]]]) -> dict[str, set[str]]:
    out = {name: {p for p in props if TIME_LIKE.match(p)} for name, (_desc, props) in tools.items()}
    return {name: params for name, params in out.items() if params}


def missing_notes(tools: dict[str, tuple[str, set[str]]], snapshot: dict[str, dict[str, str]]) -> list[str]:
    from sprintable_mcp.datetime_params import offset_required_note

    missing = []
    for name, params in snapshot.items():
        required = sorted(p for p, kind in params.items() if kind == OFFSET_REQUIRED)
        if required and offset_required_note(*required) not in tools.get(name, ("", set()))[0]:
            missing.append(f"{name}:{','.join(required)}")
    return missing


def guarded_be_queries() -> dict[str, set[str]]:
    """BE 라우터 prefix → 오프셋을 요구하는 쿼리 파라미터 이름."""
    out: dict[str, set[str]] = {}
    for path in (BACKEND / "app" / "routers").glob("*.py"):
        src = path.read_text(encoding="utf-8")
        params = set(re.findall(r'aware_datetime_query\(\s*"([^"]+)"', src)) | set(re.findall(r'require_aware\([^)]*param="([^"]+)"', src))
        prefix = re.search(r'APIRouter\(\s*prefix="([^"]+)"', src)
        if params and prefix:
            out.setdefault(prefix.group(1), set()).update(params)
    return out


def handler_forwards(src: str, guarded: dict[str, set[str]]) -> set[str]:
    """핸들러 소스가 오프셋 요구 BE 쿼리로 넘기는 MCP 인자 이름(`params["k"] = args.x` → x)."""
    paths = [m.group(1).split("{")[0] for m in re.finditer(r'client\.(?:get|get_with_headers)\(\s*f?"([^"]+)"', src)]
    forwarded = {k: a for k, a in re.findall(r'params\["(\w+)"\]\s*=\s*args\.(\w+)', src)}
    out: set[str] = set()
    for prefix, params in guarded.items():
        if any(p.startswith(prefix) for p in paths):
            out |= {arg for key, arg in forwarded.items() if key in params}
    return out


# ── 1. 스냅샷 ──────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_tool_list_time_like_params_match_snapshot(monkeypatch):
    actual = time_like_params(await _tool_list(monkeypatch))
    expected = {name: set(params) for name, params in SNAPSHOT.items()}
    assert actual == expected, "일시 파라미터가 바뀌었다 — SNAPSHOT에 분류(오프셋 필수 · 날짜만 · 커서 …)를 적고, 오프셋 필수면 도구 설명에 offset_required_note를 붙인다"


# ── 2. 설명 ────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_offset_required_params_are_named_in_the_tool_description(monkeypatch):
    tools = await _tool_list(monkeypatch)
    assert missing_notes(tools, SNAPSHOT) == []
    desc = tools["sprintable_get_session_context"][0]
    assert "`since`" in desc and "DATETIME_OFFSET_REQUIRED" in desc and "Z`" in desc and "+09:00" in desc


def test_mcp_code_string_matches_backend():
    from app.core.datetime_query import DATETIME_OFFSET_REQUIRED as BE_CODE
    from sprintable_mcp.datetime_params import DATETIME_OFFSET_REQUIRED as MCP_CODE

    assert MCP_CODE == BE_CODE


# ── 3. 층 대조 ─────────────────────────────────────────────────────────────
def test_every_mcp_arg_reaching_a_guarded_be_query_is_classified_offset_required():
    from sprintable_mcp.server import _TOOL_DEFS

    guarded = guarded_be_queries()
    assert guarded.get("/api/v2/session-context") == {"since"}, guarded  # 스캔이 실제로 BE를 읽는지(공허 통과 방지)
    wrong = []
    for name, _doc, _cls, fn in _TOOL_DEFS:
        for arg in handler_forwards(inspect.getsource(fn), guarded):
            if SNAPSHOT.get(name, {}).get(arg) != OFFSET_REQUIRED:
                wrong.append(f"{name}:{arg}")
    assert wrong == []


# ── 양성 대조 ───────────────────────────────────────────────────────────────
def test_controls_catch_missing_note_new_param_and_misclassification():
    from sprintable_mcp.datetime_params import offset_required_note

    with_note = {"t": ("설명." + offset_required_note("since"), {"since"})}
    without_note = {"t": ("설명.", {"since"})}
    snap = {"t": {"since": OFFSET_REQUIRED}}
    assert missing_notes(with_note, snap) == []
    assert missing_notes(without_note, snap) == ["t:since"]
    assert missing_notes({"t": ("설명." + offset_required_note("until"), {"since"})}, snap) == ["t:since"]  # 다른 파라미터 이름이면 안 됨

    assert time_like_params({"t": ("", {"since", "limit", "created_before", "window_start_at", "offset"})}) == {"t": {"since", "created_before", "window_start_at"}}

    guarded = {"/api/v2/activity-logs": {"from", "to"}}
    src = 'params = {}\n    if args.from_:\n        params["from"] = args.from_\n    return await client.get("/api/v2/activity-logs", params=params)'
    assert handler_forwards(src, guarded) == {"from_"}
    assert handler_forwards(src.replace("activity-logs", "stories"), guarded) == set()
