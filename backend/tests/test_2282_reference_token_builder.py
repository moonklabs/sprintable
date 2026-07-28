"""story #2282(E-CONNECT) — 참조 토큰 builder + response computed_field 순수 단위 테스트.

AC2(단일 SSOT) — DocResponse/StoryResponse/GoalResponse가 전부 같은
`build_reference_token`을 재사용하는지, AC5(해석 불가 타입엔 안 줌), AC3(FE `applyEntity`와의
포맷 parity + escape — PO critical 판정으로 `applyAsset`과 동일 escape 규칙을 적용)를
다룬다. AC4(왕복 실증)는 realdb 테스트(`test_2282_reference_token_roundtrip_realdb.py`) 몫.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

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
    """⭐AC5 핵심 — sprint/artifact/hypothesis 등 ENTITY_RESOLVERS 밖 타입엔 토큰을 안 준다
    (못 주는 것을 준 것처럼 보이면 그게 거짓). ⛔`task`는 story #2294(2026-07-28)부터
    ENTITY_RESOLVERS에 등록됐으므로 이 "밖" 목록에서 뺐다 — 등록되면 이 테스트가 그대로
    두면 실패하는 것 자체가 twin-system(#2283이 세운 원칙) 드리프트 경보다."""
    target_id = uuid.uuid4()
    for unsupported in ("sprint", "artifact", "hypothesis", "chat_message", "epic_typo"):
        assert build_reference_token(unsupported, target_id, "X") is None, unsupported


# ─── AC3 — FE applyEntity와의 parity(+이스케이핑 부재를 있는 그대로 pin) ────────


def test_build_reference_token_matches_fe_applyEntity_format_no_trailing_space():
    """FE `chat-input.tsx applyEntity`: `` `[${title}](entity:${type}:${id}) ` `` — trailing
    space는 textarea 삽입 편의(이 함수의 반환값엔 없다, 모듈 docstring 참조)."""
    doc_id = uuid.uuid4()
    token = build_reference_token("doc", doc_id, "X")
    assert token == f"[X](entity:doc:{doc_id})"
    assert not token.endswith(" ")


def test_build_reference_token_escapes_brackets_matching_fe_applyAsset_rule():
    """⭐PO critical 판정(2026-07-28) — FE `applyEntity`가 title을 escape 안 하는 게 실제
    보안 결함으로 확정됐다(형제 `applyAsset`은 `[ ] ( ) \\`+개행을 escape — 그 코멘트가
    "phishing 링크 렌더 차단"이라고 명시). 이 함수는 이제 **applyAsset과 같은 규칙**으로
    escape한다 — BE가 만드는 토큰은 무조건 안전해진다.

    ⛔PO 재정정(2026-07-28): "이 조직의 명명 관례가 흔하다"는 «급한 이유»일 뿐 «요건»이
    아니다 — 요건은 "우리 관례를 받는다"가 아니라 **"어떤 제목이든 안 깨진다"**다. 제목에
    특정 문자를 쓰지 말라고 하는 것은 제품이 질 일을 사람에게 미루는 것이라 안 하는 길이다.
    아래 `test_build_reference_token_handles_arbitrary_special_characters`가 그 일반
    요건을 다룬다 — 이 테스트는 그중 "링크 위장" 시나리오 하나만 남긴다."""
    doc_id = uuid.uuid4()
    dangerous_title = "Report](https://evil.example)[Click"
    token = build_reference_token("doc", doc_id, dangerous_title)
    expected_escaped = r"Report\]\(https://evil.example\)\[Click"
    assert token == f"[{expected_escaped}](entity:doc:{doc_id})"


def test_build_reference_token_escapes_realistic_org_tag_prefix_title():
    """실측 회귀 가드(참고 사례 하나) — 이 조직에서 실제로 쓰이는 `[TAG] 제목` 형태가
    안전한 토큰을 낸다는 것을 실물 사례로 고정한다. ⛔단 이건 "이 형태만 지원한다"는
    뜻이 아니다 — 일반 요건은 아래 파라미터화 테스트가 다룬다."""
    story_id = uuid.uuid4()
    title = "[E-CONNECT] 참조 토큰을 «만드는 법»을 응답이 알려 준다"
    token = build_reference_token("story", story_id, title)
    assert token == f"[\\[E-CONNECT\\] 참조 토큰을 «만드는 법»을 응답이 알려 준다](entity:story:{story_id})"
    # 안쪽 대괄호가 escape됐으니 바깥 [...] 몸통이 첫 `]`에서 조기 종료되지 않는다.
    body_end = token.index("](entity:")
    assert token[1:body_end] == r"\[E-CONNECT\] 참조 토큰을 «만드는 법»을 응답이 알려 준다"


@pytest.mark.parametrize("title", [
    "🚀 Launch Plan [Q3] 🎯",
    "Say \"Hello\" and 'Bye'",
    "日本語のタイトル [テスト] 中文标题 한국어 عربي",
    "C:\\Users\\test[1]",  # title 자체에 이미 backslash가 있는 경우(이중 escape 견고성)
    "[[deep]] nesting ]] test",
    "🔥 [TAG] \"quoted\" 日本語 (paren) \\ end — 모든 축 동시",
    "제목 — 부제(2024)",
    "Emoji only 😀😃😄",
])
def test_build_reference_token_handles_arbitrary_special_characters(title):
    """⭐⭐PO 판정(2026-07-28, 선생님 지적) — 요건은 «우리 조직 명명 관례를 받는다»가
    아니라 **«어떤 제목이든 안 깨진다»**다. 다른 조직은 `(2024)`·`제목 — 부제`·이모지·
    다국어 — 무엇이든 쓴다. 「이 문자는 못 씁니다」가 어디에도 뜨지 않아야 하는 것이
    요건이지, 특정 조직의 관례를 지원하는 게 요건이 아니다. 이 테스트는 임의의 특수문자
    조합이 항상 안전하게 escape되고(생성) 항상 다시 파싱되는지(왕복, 파서 쪽은
    test_1993_mention_parser.py에서 별도로도 재검증) 확認한다."""
    from app.services.mention_parser import extract_chat_entity_mentions

    entity_id = uuid.uuid4()
    token = build_reference_token("doc", entity_id, title)
    assert token is not None
    parsed = extract_chat_entity_mentions(f"메시지 본문: {token} 뒤에 텍스트")
    assert parsed == [("doc", entity_id)], f"title={title!r} token={token!r}"


def test_build_reference_token_escapes_backslash_and_collapses_newlines():
    doc_id = uuid.uuid4()
    title = "Path\\to\\file\nSecond line\r\nThird"
    token = build_reference_token("doc", doc_id, title)
    assert "\\\\" in token  # backslash escaped
    assert "\n" not in token and "\r" not in token
    assert token == f"[Path\\\\to\\\\file Second line Third](entity:doc:{doc_id})"


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
