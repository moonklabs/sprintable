"""story #2335([클래스 봉인]) — Query(None) 센티널 직접호출 lint(scripts/
lint_query_sentinel_direct_calls.py) 자체를 검증한다. 실PG 불요(순수 AST 정적분석).

⛔영구 양성표본(AC2): 실물 test_2188_no_sprint_alone_contract_pin.py:80이 지금 이 위반을
보여주지만, 그 파일이 언젠가 고쳐지면(boost_candidates_from을 명시로 넘기게 되면) 살아있는
표본이 사라진다 — 그러면 "이 lint가 진짜 잡는가"를 다음에 재확認할 길이 없다(PO 지적,
2026-07-30). 그래서 이 테스트 파일 자체가 고정 fixture(문자열 소스)로 별도의 양성표본을
하나 둔다 — 실물 site가 고쳐져도 이 표본은 그대로 살아있다.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from lint_query_sentinel_direct_calls import (  # noqa: E402
    find_router_functions,
    scan_test_file,
)

_ROUTER_SOURCE = '''
from fastapi import Query

async def list_things(
    project_id: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=50),
):
    ...
'''

_MODULE = "app.routers.things"


def _router_functions():
    return {_MODULE: {fi.name: fi for fi in find_router_functions(_ROUTER_SOURCE, _MODULE)}}


def test_find_router_functions_collects_query_params_only():
    """limit도 Query(...)를 쓰지만 기본값이 None이 아니어도(50) 여전히 센티널 객체이므로
    잡혀야 한다 — «None 기본값»이 아니라 «Query(...) 자체»가 위험축임을 고정."""
    funcs = find_router_functions(_ROUTER_SOURCE, _MODULE)
    assert len(funcs) == 1
    assert funcs[0].name == "list_things"
    assert funcs[0].query_params == {"project_id", "q", "limit"}


# ─── ⭐AC2 — 영구 양성표본: 파라미터를 «아예 안 넘기는» 직접호출 ───────────────


def test_direct_call_omitting_query_param_is_flagged():
    test_source = '''
from app.routers.things import list_things

async def test_something():
    result = await list_things(project_id="p1")
    assert result is None
'''
    result = scan_test_file(test_source, "tests/test_fixture.py", _router_functions())
    assert len(result.violations) == 1
    v = result.violations[0]
    assert v.func_name == "list_things"
    assert v.missing == {"q", "limit"}


# ─── ⭐AC3 — 음성대조: 전부 명시로 넘기면 오탐 없음 ─────────────────────────


def test_direct_call_passing_all_query_params_is_not_flagged():
    test_source = '''
from app.routers.things import list_things

async def test_something():
    result = await list_things(project_id="p1", q="hello", limit=10)
    assert result is None
'''
    result = scan_test_file(test_source, "tests/test_fixture.py", _router_functions())
    assert result.violations == []
    assert result.skipped == []


def test_http_client_call_is_not_a_direct_call_and_not_flagged():
    """client.get(...)(실제 HTTP 경유)은 이 lint의 대상이 아니다 — FastAPI가 정상적으로
    센티널을 해소하므로 새지 않는다. import는 있지만 함수를 직접 부르지 않는 경우도 안전."""
    test_source = '''
from app.routers.things import list_things

async def test_something(client):
    resp = await client.get("/api/v2/things", params={"project_id": "p1"})
    assert resp.status_code == 200
'''
    result = scan_test_file(test_source, "tests/test_fixture.py", _router_functions())
    assert result.violations == []


def test_dict_literal_splat_with_all_keys_is_not_flagged():
    """dict(...) 리터럴로 만든 뒤 **splat — 모든 키가 있으면 오탐 없어야 한다(추적 성공 케이스)."""
    test_source = '''
from app.routers.things import list_things

async def test_something():
    params = dict(project_id="p1", q="hello", limit=10)
    result = await list_things(**params)
    assert result is None
'''
    result = scan_test_file(test_source, "tests/test_fixture.py", _router_functions())
    assert result.violations == []
    assert result.skipped == []


def test_dict_literal_splat_missing_a_key_is_flagged():
    """dict(...) 리터럴 추적이 성공하면 «빠진 키»도 정확히 잡아야 한다(test_2188_no_sprint_
    alone_contract_pin.py의 실물 모양 — 간접화 «한 단계»는 추적한다)."""
    test_source = '''
from app.routers.things import list_things

async def test_something():
    params = dict(project_id="p1", limit=10)
    result = await list_things(**params)
    assert result is None
'''
    result = scan_test_file(test_source, "tests/test_fixture.py", _router_functions())
    assert len(result.violations) == 1
    assert result.violations[0].missing == {"q"}


def test_opaque_kwargs_forwarding_is_skipped_not_flagged_and_not_cleared():
    """⭐AC5의 핵심 — `**kwargs`가 다른 함수의 진짜 **kwargs 파라미터라 리터럴로 추적이
    안 되면, 「안전」도 「위반」도 아니라 SKIPPED로 남아야 한다(test_2188_list_backlog_
    filter_drop_realdb.py의 실물 모양)."""
    test_source = '''
from app.routers.things import list_things

async def _call_list_things(**kwargs):
    params = dict(project_id=None, q=None, limit=50)
    params.update(kwargs)
    return await list_things(**params)
'''
    result = scan_test_file(test_source, "tests/test_fixture.py", _router_functions())
    assert result.violations == []
    assert len(result.skipped) == 1
    assert "추적불가" in result.skipped[0]


def test_function_name_collision_across_modules_is_not_confused():
    """⭐AC5④의 핵심 — story #2335를 촉발한 실제 사례(list_docs가 라우터·MCP 툴 둘 다에
    있던 것)를 고정 회귀가드로 만든다. 같은 이름 다른 모듈에서 온 함수는 무관해야 한다."""
    test_source = '''
from app.other_module.things import list_things

async def test_something():
    result = await list_things()
    assert result is None
'''
    result = scan_test_file(test_source, "tests/test_fixture.py", _router_functions())
    assert result.violations == [], "다른 모듈(app.other_module.things)의 동명함수를 라우터로 착각하면 안 된다"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
