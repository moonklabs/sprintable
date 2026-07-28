"""story #1995: `sprintable_send_chat_message`의 agent doc-mention 토큰 합성 — MCP 쪽 검증.
story #2283 후속(오르테가 라이브 실측, 2026-07-28): doc→doc/story/epic 확장 + title 미지정
경로가 백엔드 `reference_token`(#2282 SSOT)을 재사용하도록 변경 — 검증도 함께 확장.

근본 원인: human이 채팅 UI에서 `#`으로 doc를 검색하면 chat-input.tsx의 applyEntity()가
`[title](entity:doc:id) ` 토큰을 삽입해 doc 링크/backlink가 동작한다. agent가
sprintable_send_chat_message로 보내는 raw content엔 이 토큰을 만들 방법이 없어 agent 발신
메시지의 doc 참조가 링크되지 않았다(선생님 "doc 링크 안 됨" 리포트 근본원인).

이 테스트는 (1) escape helper 단위 테스트(adversarial title — token-injection/forged-link
방지), (2) mentions→토큰 합성 통합 테스트(title 명시/생략 양쪽 경로 + 404 전파),
(3) mentions 생략 시 회귀 0(가장 중요), (4) type Literal["doc","story","epic"] 외 값이
Pydantic 스키마 레벨에서 거부되는지, (5) title 생략 시 서버 `reference_token`을 그대로
재사용하는지(+ 없을 때 로컬 fallback+경고), (6) `_MENTION_ENTITY_ENDPOINTS`가 백엔드
`ENTITY_RESOLVERS`와 축이 같은지(twin-system drift 고정)를 검증한다.
"""
from __future__ import annotations

import logging
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from sprintable_mcp.tools import chat as chat_mod
from sprintable_mcp.tools.chat import (
    MentionRef,
    SendChatInput,
    escape_mention_title,
    send_chat_message,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── escape_mention_title ──────────────────────────────────────────────────────
def test_escape_mention_title_plain_string_passthrough():
    assert escape_mention_title("My Doc") == "My Doc"


def test_escape_mention_title_empty_string():
    assert escape_mention_title("") == ""


def test_escape_mention_title_adversarial_forged_link():
    """`x](https://evil.example)[y` — escape 없으면 markdown-link 토큰 구조를 깨고
    `[x](https://evil.example)[y](entity:doc:id) ` 처럼 임의 링크를 위조할 수 있다."""
    raw = "x](https://evil.example)[y"
    escaped = escape_mention_title(raw)
    assert escaped == r"x\]\(https://evil.example\)\[y"
    # 합성된 토큰 안에서 title 부분의 `]`/`(`/`)`가 전부 escape되어 링크 구조 경계가 title
    # 내부로 침범하지 않는다.
    token = f"[{escaped}](entity:doc:doc-1) "
    assert token == r"[x\]\(https://evil.example\)\[y](entity:doc:doc-1) "


def test_escape_mention_title_backslash():
    assert escape_mention_title("a\\b") == "a\\\\b"


def test_escape_mention_title_brackets_and_parens():
    assert escape_mention_title("[a](b)") == r"\[a\]\(b\)"


def test_escape_mention_title_collapses_newlines_to_single_space():
    assert escape_mention_title("line1\nline2") == "line1 line2"
    assert escape_mention_title("a\r\n\r\nb") == "a b"


# ── MentionRef schema validation ──────────────────────────────────────────────
def test_mention_ref_rejects_invalid_type():
    """type이 허용 목록 외 값이면 Pydantic 스키마 레벨에서 거부(AC1) — 핸들러 코드 진입
    전 차단. `goal`은 절대 안 열리는 값(epic과 물리적으로 같은 테이블)이라 진짜 "미등록"
    예시로 안전하다."""
    with pytest.raises(ValidationError):
        MentionRef(type="goal", id="t-1")


def test_send_chat_input_rejects_invalid_mention_type():
    with pytest.raises(ValidationError):
        SendChatInput(thread_id="conv-1", content="hi", mentions=[{"type": "goal", "id": "t-1"}])


def test_mention_ref_rejects_evidence_type_intentional_gap():
    """`evidence`는 백엔드 ENTITY_RESOLVERS엔 있지만(#2294 B단계) MCP mentions Literal엔
    없다 — GET /api/v2/evidence/{id} 단건조회 라우트가 없어서다(의도적 gap,
    `_MENTION_ENDPOINT_KNOWN_GAP` 참조). 그 gap이 스키마 레벨에서 실제로 거부로 이어지는지."""
    with pytest.raises(ValidationError):
        MentionRef(type="evidence", id="ev-1")


def test_mention_ref_accepts_doc_type():
    m = MentionRef(type="doc", id="d-1", title="My Doc")
    assert m.type == "doc"


def test_mention_ref_accepts_story_type():
    m = MentionRef(type="story", id="s-1", title="My Story")
    assert m.type == "story"


def test_mention_ref_accepts_epic_type():
    m = MentionRef(type="epic", id="e-1", title="My Epic")
    assert m.type == "epic"


def test_mention_ref_accepts_task_type():
    m = MentionRef(type="task", id="t-1", title="My Task")
    assert m.type == "task"


def test_mention_ref_accepts_sprint_type():
    m = MentionRef(type="sprint", id="sp-1", title="Sprint 12")
    assert m.type == "sprint"


def test_mention_ref_accepts_artifact_type():
    m = MentionRef(type="artifact", id="a-1", title="My Artifact")
    assert m.type == "artifact"


def test_mention_ref_accepts_hypothesis_type():
    m = MentionRef(type="hypothesis", id="h-1", title="My Hypothesis")
    assert m.type == "hypothesis"


# story #2294 B단계(2026-07-29): evidence는 백엔드 registry에 있지만 GET /{id} 단건조회
# 라우트가 없어(list만 있음) MCP mentions에서 의도적으로 뺀다 — 조용히 빠진 것과 일부러
# 뺀 것은 처방이 다르므로 이유를 명시 등재한다(infra/mcp-path-contract-allowlist.yml의
# "알고 있다"는 선언 관례와 동형).
_MENTION_ENDPOINT_KNOWN_GAP: frozenset[str] = frozenset({"evidence"})


def test_mention_entity_endpoints_match_backend_entity_resolvers():
    """`_MENTION_ENTITY_ENDPOINTS`(MCP 쪽 type→GET endpoint 매핑)가 백엔드
    `reference_registry.ENTITY_RESOLVERS`(존재판정 registry, #2259/#2266/#2283이 계속 SSOT로
    써 온 것)와 같은 타입 집합인지 고정(알려진 gap `_MENTION_ENDPOINT_KNOWN_GAP` 제외) —
    한쪽만 늘면(예: 백엔드에 새 target_type 등록, MCP mentions는 안 넓힘) agent 경로만
    뒤처지는 형제 비대칭이 조용히 생긴다. ⛔story #2294에서 이 테스트가 실제로 RED였다
    (task가 백엔드에만 열리고 여기 안 넓혀진 채 develop에 머지됨 — merge-order 드리프트)."""
    from app.services.reference_registry import ENTITY_RESOLVERS

    assert set(chat_mod._MENTION_ENTITY_ENDPOINTS) == set(ENTITY_RESOLVERS) - _MENTION_ENDPOINT_KNOWN_GAP
    # gap 자체가 정말 gap인지도 고정 — evidence가 실수로 뚫려도(둘 다에 존재) 이 assert가 잡는다.
    assert _MENTION_ENDPOINT_KNOWN_GAP <= set(ENTITY_RESOLVERS)
    assert _MENTION_ENDPOINT_KNOWN_GAP.isdisjoint(chat_mod._MENTION_ENTITY_ENDPOINTS)


def test_mention_ref_literal_matches_mention_entity_endpoints_directly():
    """⭐PO 지적(2026-07-29): 위 테스트는 `_MENTION_ENTITY_ENDPOINTS`↔`ENTITY_RESOLVERS`
    (dict↔registry) «둘만» 잰다 — `MentionRef.type`의 Pydantic `Literal`(스키마 검증 축)은
    지금까지 «손으로 같이 맞춰 왔을 뿐» 어느 테스트도 직접 재지 않았다. Literal과 dict가
    서로 갈리면(예: dict에만 새 키를 추가하고 Literal enum을 깜빡하면) 위 테스트는 여전히
    통과하는데(Literal은 안 보니까) 실제로는 `MentionRef(type="새키", ...)`가 스키마
    레벨에서 거부되는 죽은 경로가 생긴다 — registry↔dict가 아니라 «dict↔Literal» 축의
    twin-system 갭. `typing.get_args()`로 Literal의 실제 허용값을 직접 추출해 dict 키와
    동일한지 고정한다(세 축 중 마지막 하나)."""
    import typing

    literal_type = typing.get_type_hints(MentionRef)["type"]
    literal_values = set(typing.get_args(literal_type))
    assert literal_values == set(chat_mod._MENTION_ENTITY_ENDPOINTS)


# ── send_chat_message: token synthesis (title given) ─────────────────────────
@pytest.mark.anyio
async def test_send_chat_message_synthesizes_token_with_given_title():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "11111111-1111-1111-1111-111111111111", "title": "My Doc"}],
    )
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m, \
         patch.object(chat_mod.client, "get", new=AsyncMock()) as g:
        result = await send_chat_message(args)
        g.assert_not_called()  # title 명시 → doc GET 조회 스킵
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == (
            "see this [My Doc](entity:doc:11111111-1111-1111-1111-111111111111) "
        )
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_send_chat_message_synthesizes_token_multiple_mentions_no_double_space():
    args = SendChatInput(
        thread_id="conv-1",
        content="see these",
        mentions=[
            {"type": "doc", "id": "doc-a", "title": "Doc A"},
            {"type": "doc", "id": "doc-b", "title": "Doc B"},
        ],
    )
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == (
            "see these [Doc A](entity:doc:doc-a) [Doc B](entity:doc:doc-b) "
        )


@pytest.mark.anyio
async def test_send_chat_message_escapes_adversarial_given_title():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "doc-1", "title": "x](https://evil.example)[y"}],
    )
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == (
            r"see this [x\]\(https://evil.example\)\[y](entity:doc:doc-1) "
        )


# ── send_chat_message: title omitted → fetched via client.get, reuses reference_token ──
@pytest.mark.anyio
async def test_send_chat_message_reuses_backend_reference_token_when_title_omitted():
    """⭐#2283 후속 핵심 — title 생략 시 응답의 `reference_token`(#2282 SSOT, 서버가 이미
    escape까지 끝낸 것)을 그대로 쓴다. 여기서 로컬 escape를 다시 태우지 않는다는 것이 핵심
    (title이 실제로는 `]`를 포함해도, reference_token 필드 자체가 이미 정답이므로 title
    파싱/재조립이 필요 없다).

    ⛔fixture 설계 주의 — reference_token을 title의 로컬 escape 결과와 «일부러 다르게»
    만든다(예: 다른 표시 문구). 둘이 같으면 "reference_token을 썼다"와 "fallback으로 title을
    로컬 escape했다"를 구별할 수 없는 테스트가 된다(오늘 낮에 반복 경계한 confound 클래스) —
    실제로 이 실수로 처음 짠 버전은 sabotage(강제 fallback)해도 GREEN이 나와 자체발견했다."""
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "doc-1"}],
    )
    fetched = {
        "id": "doc-1", "title": "Fetched Doc",
        "reference_token": "[SERVER-CANONICAL-TOKEN](entity:doc:doc-1)",
    }
    with patch.object(chat_mod.client, "get", new=AsyncMock(return_value=fetched)) as g, \
         patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        result = await send_chat_message(args)
        g.assert_awaited_once_with("/api/v2/docs/doc-1")
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == (
            "see this [SERVER-CANONICAL-TOKEN](entity:doc:doc-1) "
        )
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_send_chat_message_reuses_reference_token_for_story_type():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "story", "id": "story-1"}],
    )
    fetched = {
        "id": "story-1", "title": "My Story",
        "reference_token": "[SERVER-CANONICAL-STORY-TOKEN](entity:story:story-1)",
    }
    with patch.object(chat_mod.client, "get", new=AsyncMock(return_value=fetched)) as g, \
         patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        g.assert_awaited_once_with("/api/v2/stories/story-1")
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == "see this [SERVER-CANONICAL-STORY-TOKEN](entity:story:story-1) "


@pytest.mark.anyio
async def test_send_chat_message_reuses_reference_token_for_epic_type():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "epic", "id": "epic-1"}],
    )
    fetched = {
        "id": "epic-1", "title": "My Epic",
        "reference_token": "[SERVER-CANONICAL-EPIC-TOKEN](entity:epic:epic-1)",
    }
    with patch.object(chat_mod.client, "get", new=AsyncMock(return_value=fetched)) as g, \
         patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        g.assert_awaited_once_with("/api/v2/goals/epic-1")
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == "see this [SERVER-CANONICAL-EPIC-TOKEN](entity:epic:epic-1) "


@pytest.mark.anyio
async def test_send_chat_message_falls_back_to_local_escape_when_reference_token_missing(caplog):
    """방어적 폴백 — 응답에 reference_token 필드가 없으면(구버전 백엔드 등) title로 로컬
    escape 조립하고 경고 로그를 남긴다(조용한 skew 금지)."""
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "doc-1"}],
    )
    fetched = {"id": "doc-1", "title": "Fetched Doc"}  # reference_token 없음
    with caplog.at_level(logging.WARNING, logger="sprintable_mcp.tools.chat"):
        with patch.object(chat_mod.client, "get", new=AsyncMock(return_value=fetched)), \
             patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
            await send_chat_message(args)
            _, kwargs = m.call_args
            assert kwargs["json"]["content"] == "see this [Fetched Doc](entity:doc:doc-1) "
    assert any("missing reference_token" in r.message for r in caplog.records)


# ── send_chat_message: 404 on doc fetch propagates, no message POST ──────────
@pytest.mark.anyio
async def test_send_chat_message_mention_doc_not_found_errors_without_posting_message():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "missing-doc"}],
    )

    with patch.object(chat_mod.client, "get", new=AsyncMock(side_effect=RuntimeError("404 Not Found"))) as g, \
         patch.object(chat_mod.client, "post_full", new=AsyncMock()) as m:
        result = await send_chat_message(args)
        g.assert_awaited_once_with("/api/v2/docs/missing-doc")
        m.assert_not_called()  # broken 토큰이 실린 반쪽 메시지가 저장되지 않는다
        assert result[0].text.startswith("Error")
        assert "404" in result[0].text


# ── references/command_gate sibling 노출(2026-07-29 오르테가 라이브 실측 버그) ──


@pytest.mark.anyio
async def test_send_chat_message_surfaces_references_sideband_from_backend():
    """⭐이 버그가 실제로 있었던 자리 — 백엔드가 `{"data": {...}, "references": {...}}`를
    돌려줘도 예전엔 `client.post()`의 자동 unwrap이 `references`를 통째로 버려서 CI green·
    배포 SHA 일치에도 MCP 호출부엔 한 번도 안 닿았다(라이브 재현으로 발견). `post_full`
    (unwrap=False)로 원본을 받아 재구성하는지 — sibling이 실제로 살아남는지를 직접 본다."""
    args = SendChatInput(thread_id="conv-1", content="[T](entity:task:t-1)")
    backend_response = {
        "data": {"id": "m1", "content": "[T](entity:task:t-1)"},
        "references": {"stored": 1, "dropped": [{"target_type": "sprint", "target_id": "s-1"}]},
    }
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value=backend_response)):
        result = await send_chat_message(args)
    import json
    body = json.loads(result[0].text)
    assert body["id"] == "m1"  # data가 평탄하게 풀렸다(기존 MCP 호출부 기대 모양 유지)
    assert body["references"] == {"stored": 1, "dropped": [{"target_type": "sprint", "target_id": "s-1"}]}


@pytest.mark.anyio
async def test_send_chat_message_surfaces_command_gate_sideband_from_backend():
    """references와 같은 클래스의 기존 버그 — command_gate도 같은 이유로 MCP 경로에서
    한 번도 안 보이고 있었다(이번에 같이 드러남). 같은 수정으로 같이 고쳐지는지."""
    args = SendChatInput(thread_id="conv-1", content="/unsupported-command")
    backend_response = {
        "data": {"id": "m2", "content": "/unsupported-command"},
        "command_gate": {"blocked": ["unsupported-command"]},
    }
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value=backend_response)):
        result = await send_chat_message(args)
    import json
    body = json.loads(result[0].text)
    assert body["command_gate"] == {"blocked": ["unsupported-command"]}


@pytest.mark.anyio
async def test_send_chat_message_plain_response_without_sideband_stays_flat():
    """⛔회귀 0 — 백엔드가 sibling 없이 `{"data": {...}}`만 주면(평문 메시지의 일반 경로)
    기존과 동일하게 평탄한 메시지 필드만 남는다(references/command_gate 키 자체가 없음)."""
    args = SendChatInput(thread_id="conv-1", content="그냥 평문")
    backend_response = {"data": {"id": "m3", "content": "그냥 평문"}}
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value=backend_response)):
        result = await send_chat_message(args)
    import json
    body = json.loads(result[0].text)
    assert body["id"] == "m3"
    assert "references" not in body
    assert "command_gate" not in body


# ── RED→GREEN 자체검증 — post_full 안 쓰면 sideband가 실제로 사라지는지 ──────────


@pytest.mark.anyio
async def test_sideband_exposure_red_green_mutation_self_check():
    """`post_full` 대신 옛 `post`(자동 unwrap)를 쓰도록 사보타주하면 references가 실제로
    사라지는지(RED) → 원복하면 다시 나오는지(GREEN) — 이번에 고친 버그 그 자체를 재현."""
    import sprintable_mcp.tools.chat as chat_module

    args = SendChatInput(thread_id="conv-1", content="[T](entity:task:t-1)")
    backend_full_response = {
        "data": {"id": "m1", "content": "[T](entity:task:t-1)"},
        "references": {"stored": 1, "dropped": []},
    }

    original_send = chat_module.send_chat_message

    async def _sabotaged_send(a):
        # 사보타주: post_full 대신 post(자동 unwrap)를 써서 옛 버그를 재현.
        unwrapped = await chat_module.client.post(
            f"/api/v2/conversations/{a.thread_id}/messages", json={"content": a.content},
        )
        return chat_module.ok(unwrapped)

    with patch.object(
        chat_module.client, "post", new=AsyncMock(return_value=backend_full_response["data"]),
    ):
        # post()는 이미 unwrap된(= "data"만 있는) 값을 돌려준다고 가정(실제 client.post 동작과 동일).
        import json
        result = await _sabotaged_send(args)
        body = json.loads(result[0].text)
        assert "references" not in body, "사보타주가 안 먹었다 — references가 여전히 있다(RED 실패)"

    # 원복 — 실제 send_chat_message(post_full 사용)로 같은 입력을 돌리면 references가 다시 뜬다.
    with patch.object(chat_module.client, "post_full", new=AsyncMock(return_value=backend_full_response)):
        result2 = await original_send(args)
        body2 = json.loads(result2[0].text)
        assert body2.get("references") == {"stored": 1, "dropped": []}, "원복 후에도 안 뜬다(GREEN 실패)"


# ── mentions 생략 → 회귀 0 (가장 중요) ─────────────────────────────────────────
@pytest.mark.anyio
async def test_send_chat_message_mentions_omitted_byte_identical_to_current_behavior():
    """mentions 필드 자체를 안 넘긴 기존 호출자는 payload가 이 변경 前과 완전히 동일해야 한다."""
    args = SendChatInput(thread_id="conv-1", content="hi there")
    assert args.mentions is None
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m, \
         patch.object(chat_mod.client, "get", new=AsyncMock()) as g:
        result = await send_chat_message(args)
        g.assert_not_called()
        _, kwargs = m.call_args
        assert kwargs["json"] == {"content": "hi there"}
        assert "attachments" not in kwargs["json"]
        assert "mentions" not in kwargs["json"]
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_send_chat_message_empty_mentions_list_byte_identical():
    """mentions=[] (falsy) 도 mentions=None과 동일하게 동작 — content 변조 없음."""
    args = SendChatInput(thread_id="conv-1", content="hi there", mentions=[])
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == "hi there"
