"""story #2282(E-CONNECT) — 참조 토큰 builder + response computed_field 순수 단위 테스트.

AC2(단일 SSOT) — DocResponse/StoryResponse/GoalResponse가 전부 같은
`build_reference_token`을 재사용하는지, AC5(해석 불가 타입엔 안 줌), AC3(FE `applyEntity`와의
parity — 이스케이핑 부재까지 그대로 pin)를 다룬다. AC4(왕복 실증)는 realdb 테스트
(`test_2282_reference_token_roundtrip_realdb.py`) 몫.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.services.reference_token import build_reference_token


# ─── build_reference_token — AC2/AC5 ────────────────────────────────────────


def test_build_reference_token_doc():
    doc_id = uuid.uuid4()
    assert build_reference_token("doc", doc_id, "Pricing Policy") == (
        f"[Pricing Policy](entity:doc:{doc_id})"
    )


def test_build_reference_token_story():
    story_id = uuid.uuid4()
    assert build_reference_token("story", story_id, "Fix login bug") == (
        f"[Fix login bug](entity:story:{story_id})"
    )


def test_build_reference_token_epic():
    epic_id = uuid.uuid4()
    assert build_reference_token("epic", epic_id, "E-CONNECT") == (
        f"[E-CONNECT](entity:epic:{epic_id})"
    )


def test_build_reference_token_unregistered_type_returns_none():
    """⭐AC5 핵심 — task/artifact/hypothesis 등 ENTITY_RESOLVERS 밖 타입엔 토큰을 안 준다
    (못 주는 것을 준 것처럼 보이면 그게 거짓)."""
    target_id = uuid.uuid4()
    for unsupported in ("task", "artifact", "hypothesis", "chat_message", "epic_typo"):
        assert build_reference_token(unsupported, target_id, "X") is None, unsupported


# ─── AC3 — FE applyEntity와의 parity(+이스케이핑 부재를 있는 그대로 pin) ────────


def test_build_reference_token_matches_fe_applyEntity_format_no_trailing_space():
    """FE `chat-input.tsx applyEntity`: `` `[${title}](entity:${type}:${id}) ` `` — trailing
    space는 textarea 삽입 편의(이 함수의 반환값엔 없다, 모듈 docstring 참조)."""
    doc_id = uuid.uuid4()
    token = build_reference_token("doc", doc_id, "X")
    assert token == f"[X](entity:doc:{doc_id})"
    assert not token.endswith(" ")


def test_build_reference_token_does_not_escape_brackets_matching_fe_gap():
    """⛔AC3 실측 pin — FE `applyEntity`는 title을 escape하지 않는다(형제 `applyAsset`은
    한다). 이 함수도 **동일하게 escape 안 함**(있는 척 안 함, parity가 목적) — 제목에
    `]`가 들어가면 토큰 구조가 깨진다는 것을 이 테스트가 고정한다. ⚠️이건 알려진 gap이지
    이 함수의 버그가 아니다(#2282 보고 참조 — FE도 같이 고쳐야 하는 별건)."""
    doc_id = uuid.uuid4()
    dangerous_title = "Report](https://evil.example)[Click"
    token = build_reference_token("doc", doc_id, dangerous_title)
    # escape 안 됐다는 것 자체를 pin(문자 그대로 들어감 — \\[ \\] 변환 없음).
    assert token == f"[{dangerous_title}](entity:doc:{doc_id})"
    assert "\\]" not in token
    assert "\\)" not in token


# ─── DocResponse/StoryResponse/GoalResponse computed_field — AC1/AC2 ────────


def _doc_kwargs(**overrides):
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), parent_id=None,
        created_by=None, assignee_id=None, status="draft", superseded_by=None,
        title="Doc Title", slug="doc-title", canonical_slug="doc-title", slug_locked=False,
        content="", icon=None, sort_order=0, doc_type="page", content_format="markdown",
        tags=[], created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    base.update(overrides)
    return base


def test_doc_response_reference_token_computed():
    from app.schemas.doc import DocResponse
    kwargs = _doc_kwargs()
    resp = DocResponse(**kwargs)
    assert resp.reference_token == f"[Doc Title](entity:doc:{kwargs['id']})"


def _story_kwargs(**overrides):
    base = dict(
        id=uuid.uuid4(), story_number=1, project_id=uuid.uuid4(), org_id=uuid.uuid4(),
        title="Story Title", status="backlog", priority="medium",
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    base.update(overrides)
    return base


def test_story_response_reference_token_computed():
    from app.schemas.story import StoryResponse
    kwargs = _story_kwargs()
    resp = StoryResponse(**kwargs)
    assert resp.reference_token == f"[Story Title](entity:story:{kwargs['id']})"


def _goal_kwargs(**overrides):
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="Goal Title",
        status="draft", priority="medium",
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    base.update(overrides)
    return base


def test_goal_response_reference_token_computed_uses_epic_type():
    """⛔Goal 모델이지만 entity_type 문자열은 registry 기준 "epic"이어야 한다(모델명≠타입
    리터럴 — reference_registry._resolve_epics가 Goal을 쓰는 것과 동형)."""
    from app.schemas.goal import GoalResponse
    kwargs = _goal_kwargs()
    resp = GoalResponse(**kwargs)
    assert resp.reference_token == f"[Goal Title](entity:epic:{kwargs['id']})"


# ─── AC6 — MCP 도구 설명에 문법이 들어가는지(정적 스캔) ──────────────────────


def test_mcp_tool_descriptions_mention_reference_token_syntax():
    """⭐AC6 pin — create_doc·get_doc·add_story·list_stories(스토리 본문이 명시한 넷) 도구
    설명에 `entity:` 토큰 문법 언급이 실제로 있는지 소스를 정적으로 훑어 확認한다."""
    import inspect
    import sprintable_mcp.server as server_module

    source = inspect.getsource(server_module)
    # _TOOL_DEFS 리터럴 블록만 보면 충분 — 전체 소스에서 각 도구 이름 뒤 description에
    # "entity:" 문법이 붙어 있는지를 대략적으로 확인(정확한 파싱보다 정적 포함 여부로 pin).
    required_tools = [
        "sprintable_create_doc", "sprintable_get_doc",
        "sprintable_add_story", "sprintable_list_stories",
    ]
    for tool_name in required_tools:
        idx = source.index(f'"{tool_name}"')
        # 그 도구 이름 등장 지점부터 다음 500자 안에 문법 힌트가 있는지(느슨하지만 정적 스캔).
        window = source[idx: idx + 500]
        assert "entity:" in window, f"{tool_name} 설명에 참조 토큰 문법이 없다"
