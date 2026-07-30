"""story #1993(E-KNOWLEDGE-LINK S1) — mention_parser.py 순수 추출 함수 단위 테스트.

TDD: 이 테스트가 먼저 RED(app/services/mention_parser.py 부재)였고, 구현 후 GREEN. 순수 함수라
DB/세션 불요 — extract_chat_doc_mention_ids(정규식)·extract_doc_mention_ids(HTMLParser) 커버.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from app.services.mention_parser import (
    extract_chat_doc_mention_ids,
    extract_doc_mention_ids,
    extract_doc_mention_targets,
)


# ─── extract_chat_doc_mention_ids (정규식 — entity:doc:<uuid> 토큰) ────────────


def test_extract_chat_single_doc_token():
    doc_id = uuid.uuid4()
    content = f"참고: [설계 doc](entity:doc:{doc_id}) 확인해줘"
    assert extract_chat_doc_mention_ids(content) == [doc_id]


def test_extract_chat_multiple_doc_tokens_preserve_order():
    id1, id2 = uuid.uuid4(), uuid.uuid4()
    content = f"[A](entity:doc:{id1}) 그리고 [B](entity:doc:{id2})"
    assert extract_chat_doc_mention_ids(content) == [id1, id2]


def test_extract_chat_dedupes_repeated_token():
    doc_id = uuid.uuid4()
    content = f"[A](entity:doc:{doc_id}) 또 [B](entity:doc:{doc_id})"
    assert extract_chat_doc_mention_ids(content) == [doc_id]


def test_extract_chat_ignores_non_doc_entity_types():
    """story/epic/task/asset 토큰은 스코프 밖 — 파싱하지 않는다(과확장 금지)."""
    story_id, task_id, asset_id, doc_id = (uuid.uuid4() for _ in range(4))
    content = (
        f"[S](entity:story:{story_id}) [T](entity:task:{task_id}) "
        f"[F](entity:asset:{asset_id}) [D](entity:doc:{doc_id})"
    )
    assert extract_chat_doc_mention_ids(content) == [doc_id]


def test_extract_chat_malformed_token_skipped_silently():
    doc_id = uuid.uuid4()
    content = f"[bad](entity:doc:not-a-uuid) 그리고 [good](entity:doc:{doc_id})"
    # malformed 토큰은 조용히 스킵 — 예외 없이 유효한 토큰만 반환.
    assert extract_chat_doc_mention_ids(content) == [doc_id]


def test_extract_chat_no_tokens_returns_empty_list():
    assert extract_chat_doc_mention_ids("그냥 평범한 메시지입니다") == []


def test_extract_chat_empty_content_returns_empty_list():
    assert extract_chat_doc_mention_ids("") == []


def test_extract_chat_requires_title_brackets():
    """토큰은 `[title](entity:doc:id)` 형태 — bracket 없는 bare `entity:doc:id` 는 FE 가 만들지
    않는 포맷이라 매치하지 않는다(정확한 FE 포맷 재현 — 과확대 매칭 방지)."""
    doc_id = uuid.uuid4()
    content = f"entity:doc:{doc_id} (bracket 없음)"
    assert extract_chat_doc_mention_ids(content) == []


# ─── story #2282(PO critical) — escape-aware 정규식 (제목 안 `]`가 조기종료 안 함) ────


def test_extract_chat_title_with_escaped_bracket_still_matches():
    """⭐핵심 회귀 가드 — 제목에 escape된 `]`가 있어도 파싱이 성공해야 한다(요건은 특정
    조직의 명명 관례를 받는 게 아니라 "어떤 제목이든 안 깨진다"는 것 — PO 재정정,
    2026-07-28). 예전 정규식(`[^\\]]*`)은 escape를 몰라 이 케이스에서 통째로 매치
    실패했다(#2282 발견·재현). `[TAG] 제목`(이 조직에서 실제로 쓰는 형태 하나)은 그
    일반 요건이 실물에 적용된 사례일 뿐이다."""
    from app.services.mention_parser import extract_chat_entity_mentions

    story_id = uuid.uuid4()
    title = r"\[E-CONNECT\] 참조 토큰을 «만드는 법»을 응답이 알려 준다"
    content = f"[{title}](entity:story:{story_id})"
    assert extract_chat_entity_mentions(content) == [("story", story_id)]


def test_extract_chat_title_with_escaped_paren_and_backslash_still_matches():
    from app.services.mention_parser import extract_chat_entity_mentions

    doc_id = uuid.uuid4()
    title = r"Report\]\(https://evil.example\)\[Click"
    content = f"[{title}](entity:doc:{doc_id})"
    assert extract_chat_entity_mentions(content) == [("doc", doc_id)]


@pytest.mark.parametrize("raw_title", [
    "🚀 Launch Plan [Q3] 🎯",
    "Say \"Hello\" and 'Bye'",
    "日本語のタイトル [テスト] 中文标题 한국어 عربي",
    "C:\\Users\\test[1]",
    "[[deep]] nesting ]] test",
    "제목 — 부제(2024)",
    "Report](https://evil.example)[Click here",  # `](` 가 제목 «안»에 literal로 등장
])
def test_extract_chat_arbitrary_special_char_title_roundtrips(raw_title):
    """⭐⭐PO 판정(2026-07-28, 선생님 재정정) — 요건은 "우리 조직 관례를 받는다"가 아니라
    "어떤 제목이든 안 깨진다"다. `build_reference_token`이 만든 escape된 토큰이 이
    파서로 정확히 다시 파싱되는지 임의 특수문자 조합으로 확認한다(생성-파싱 왕복을
    파서 쪽에서 직접, 빌더 쪽 테스트와 별도로 재검증)."""
    from app.services.mention_parser import extract_chat_entity_mentions
    from app.services.reference_token import build_reference_token

    doc_id = uuid.uuid4()
    token = build_reference_token("doc", doc_id, raw_title)
    content = f"메시지: {token} 끝"
    assert extract_chat_entity_mentions(content) == [("doc", doc_id)], f"title={raw_title!r}"


def test_extract_chat_plain_title_without_escapes_still_matches_backward_compat():
    """escape-aware로 바꿔도 escape 없는 기존 토큰(대다수 실 데이터)은 그대로 매치돼야
    한다 — 회귀 0."""
    doc_id = uuid.uuid4()
    content = f"[Pricing Policy](entity:doc:{doc_id})"
    assert extract_chat_doc_mention_ids(content) == [doc_id]


# ─── story #2282(PO 판정) — 매치 실패를 조용히 넘기지 않는다(감시망) ──────────


def test_extract_chat_warns_on_unparsed_token_shape(caplog):
    """⭐토큰 «모양»(`](entity:`)이 있는데 실제 추출이 그보다 적으면 경고를 남긴다 — "실패가
    성공처럼 보이는" 것을 막는 최소 감시망. 일부러 다시 escape-unaware 패턴을 흉내내
    (실제 매치 실패를 유발할 순 없으니 문자열 자체에 `](entity:`를 여러 번 심어 카운트를
    올린다) 경고가 뜨는지 확認한다."""
    import logging
    from app.services.mention_parser import extract_chat_entity_mentions

    caplog.set_level(logging.WARNING, logger="app.services.mention_parser")
    doc_id = uuid.uuid4()
    # 진짜 토큰 1개 + "](entity:" 모양만 흉내낸 잡음 1개 → shape_count(2) > extracted(1).
    content = f"[Real](entity:doc:{doc_id}) 그리고 이상한 텍스트 ](entity: 어쩌고"
    result = extract_chat_entity_mentions(content)
    assert result == [("doc", doc_id)]
    assert any("possible silent parse failure" in r.message for r in caplog.records)


def test_extract_chat_no_warning_when_shapes_all_parsed(caplog):
    import logging
    from app.services.mention_parser import extract_chat_entity_mentions

    caplog.set_level(logging.WARNING, logger="app.services.mention_parser")
    doc_id = uuid.uuid4()
    content = f"[Real](entity:doc:{doc_id})"
    extract_chat_entity_mentions(content)
    assert not any("possible silent parse failure" in r.message for r in caplog.records)


# ─── story #2329(2026-07-30, #2316 AC8) — shape_count 오탐 95% 걷기 ───────────
# _redact_code_spans() 재사용(코드펜스/인라인코드 안의 `](entity:`는 안 센다) — AC2 양성
# 대조(펜스 안은 안 세이고 펜스 밖 진짜 깨진 토큰은 여전히 세인다) + AC3 뮤테이션 자가검증.


def test_extract_chat_no_warning_when_broken_shape_is_inside_fenced_code_block(caplog):
    """AC2 ㉠ — 코드펜스 «안»의 토큰형 문자열(우리가 문법을 설명·인용할 때 쓰는 것과 동형)은
    shape_count에서 안 세인다 — 경고가 안 뜬다."""
    import logging
    from app.services.mention_parser import extract_chat_entity_mentions

    caplog.set_level(logging.WARNING, logger="app.services.mention_parser")
    doc_id = uuid.uuid4()
    content = (
        f"[Real](entity:doc:{doc_id}) 그리고 설명:\n"
        "```\n"
        "예시 문법: ](entity: 이렇게 생겼다\n"
        "```"
    )
    result = extract_chat_entity_mentions(content)
    assert result == [("doc", doc_id)]
    assert not any("possible silent parse failure" in r.message for r in caplog.records)


def test_extract_chat_still_warns_when_broken_shape_is_outside_fenced_code_block(caplog):
    """AC2 ㉡(판별력) — 펜스 «밖»의 진짜 깨진 토큰형은 여전히 세인다·경고가 뜬다. ①만
    재면(안 세이는 것만 확인) 「경고를 죽인 것」과 구별이 안 된다 — ①②를 같이 재야 이
    처방이 "소음만 걷었다"이지 "감시망 자체를 죽였다"가 아님을 증명한다."""
    import logging
    from app.services.mention_parser import extract_chat_entity_mentions

    caplog.set_level(logging.WARNING, logger="app.services.mention_parser")
    doc_id = uuid.uuid4()
    content = f"[Real](entity:doc:{doc_id}) 그리고 이상한 텍스트 ](entity: 어쩌고"
    result = extract_chat_entity_mentions(content)
    assert result == [("doc", doc_id)]
    assert any("possible silent parse failure" in r.message for r in caplog.records)


def test_extract_chat_shape_count_redaction_mutation_self_check(caplog, monkeypatch):
    """AC3 — 뮤테이션 자가검증. `_redact_code_spans` 호출을 빼면(=고치기 前 상태로 되돌리면)
    코드펜스 안 토큰형에도 다시 경고가 뜬다(RED) — 방금 위 테스트가 실제로 이 배선을
    지키고 있다는 것을 증명한다."""
    import logging
    import app.services.mention_parser as mp

    monkeypatch.setattr(mp, "_redact_code_spans", lambda content: content)

    caplog.set_level(logging.WARNING, logger="app.services.mention_parser")
    doc_id = uuid.uuid4()
    content = (
        f"[Real](entity:doc:{doc_id}) 그리고 설명:\n"
        "```\n"
        "예시 문법: ](entity: 이렇게 생겼다\n"
        "```"
    )
    mp.extract_chat_entity_mentions(content)
    assert any("possible silent parse failure" in r.message for r in caplog.records), (
        "_redact_code_spans 배선을 빼도 경고가 안 뜨면 위 양성 테스트가 아무것도 안 지키는 것"
    )


# ─── extract_doc_mention_ids (HTMLParser — wikiLink/pageEmbed data-doc-id) ────


def test_extract_doc_wikilink_span():
    doc_id = uuid.uuid4()
    html = f'<p>참고 <span data-type="wikiLink" data-doc-id="{doc_id}" data-title="X" data-slug="x">X</span></p>'
    assert extract_doc_mention_ids(html) == [doc_id]


def test_extract_doc_page_embed_div():
    doc_id = uuid.uuid4()
    html = f'<div data-page-embed data-doc-id="{doc_id}" data-title="Y" data-icon="" data-slug="y"></div>'
    assert extract_doc_mention_ids(html) == [doc_id]


def test_extract_doc_attribute_order_independent():
    """설계 doc 근거: mergeAttributes 의 attribute 순서가 보장 안 됨 — HTMLParser 는 순서 무관
    dict 조회라 data-doc-id 가 어디 있든 잡아야 한다."""
    doc_id = uuid.uuid4()
    html_a = f'<span data-doc-id="{doc_id}" data-type="wikiLink">X</span>'
    html_b = f'<span data-type="wikiLink" data-title="X" data-doc-id="{doc_id}">X</span>'
    assert extract_doc_mention_ids(html_a) == [doc_id]
    assert extract_doc_mention_ids(html_b) == [doc_id]


def test_extract_doc_mixed_wikilink_and_page_embed_dedup_and_order():
    id1, id2 = uuid.uuid4(), uuid.uuid4()
    html = (
        f'<span data-type="wikiLink" data-doc-id="{id1}">A</span>'
        f'<div data-page-embed data-doc-id="{id2}"></div>'
        f'<span data-type="wikiLink" data-doc-id="{id1}">A again</span>'
    )
    assert extract_doc_mention_ids(html) == [id1, id2]


def test_extract_doc_ignores_unrelated_tags():
    doc_id = uuid.uuid4()
    html = f'<div data-doc-id="{doc_id}">not a wikiLink or pageEmbed</div><p>hello</p>'
    assert extract_doc_mention_ids(html) == []


def test_extract_doc_malformed_uuid_skipped_silently():
    doc_id = uuid.uuid4()
    html = (
        '<span data-type="wikiLink" data-doc-id="not-a-uuid">bad</span>'
        f'<span data-type="wikiLink" data-doc-id="{doc_id}">good</span>'
    )
    assert extract_doc_mention_ids(html) == [doc_id]


def test_extract_doc_missing_data_doc_id_skipped():
    html = '<span data-type="wikiLink">no id attr</span>'
    assert extract_doc_mention_ids(html) == []


def test_extract_doc_empty_content_returns_empty_list():
    assert extract_doc_mention_ids("") == []


def test_extract_doc_malformed_html_does_not_raise():
    """HTMLParser 는 malformed 마크업에도 예외를 던지지 않고 best-effort 파싱해야 한다."""
    doc_id = uuid.uuid4()
    html = f'<span data-type="wikiLink" data-doc-id="{doc_id}"><unclosed>'
    # 예외 없이 리턴되면 충분(잘린 태그라도 이미 열린 span 의 속성은 잡힘).
    result = extract_doc_mention_ids(html)
    assert doc_id in result


# ─── extract_doc_mention_targets (story #2284 — form 보존: wikiLink→mention·pageEmbed→embed) ──


def test_extract_doc_targets_wikilink_is_mention_form():
    doc_id = uuid.uuid4()
    html = f'<span data-type="wikiLink" data-doc-id="{doc_id}">X</span>'
    assert extract_doc_mention_targets(html) == [(doc_id, "mention")]


def test_extract_doc_targets_page_embed_is_embed_form():
    doc_id = uuid.uuid4()
    html = f'<div data-page-embed data-doc-id="{doc_id}"></div>'
    assert extract_doc_mention_targets(html) == [(doc_id, "embed")]


def test_extract_doc_targets_mixed_forms_both_kept_distinct():
    """⭐AC1 핵심 — 파싱 시점에 있던 형태 구분이 저장 직전 단계까지 버려지지 않고 살아남는다."""
    id1, id2 = uuid.uuid4(), uuid.uuid4()
    html = (
        f'<span data-type="wikiLink" data-doc-id="{id1}">A</span>'
        f'<div data-page-embed data-doc-id="{id2}"></div>'
    )
    assert extract_doc_mention_targets(html) == [(id1, "mention"), (id2, "embed")]


def test_extract_doc_targets_same_doc_as_both_forms_not_collapsed():
    """같은 doc이 인라인 멘션과 카드 임베드 둘 다로 등장하면 (id, form)이 달라 둘 다 남는다 —
    entity_references의 partial unique index가 form을 키에 포함하므로 공존이 설계상 맞다."""
    doc_id = uuid.uuid4()
    html = (
        f'<span data-type="wikiLink" data-doc-id="{doc_id}">A</span>'
        f'<div data-page-embed data-doc-id="{doc_id}"></div>'
    )
    assert extract_doc_mention_targets(html) == [(doc_id, "mention"), (doc_id, "embed")]


def test_extract_doc_targets_duplicate_same_form_deduped():
    doc_id = uuid.uuid4()
    html = (
        f'<span data-type="wikiLink" data-doc-id="{doc_id}">A</span>'
        f'<span data-type="wikiLink" data-doc-id="{doc_id}">A again</span>'
    )
    assert extract_doc_mention_targets(html) == [(doc_id, "mention")]


def test_extract_doc_mention_ids_wrapper_still_ignores_form():
    """extract_doc_mention_ids(하위호환 래퍼)는 여전히 id만 반환 — form이 다른 같은 id도
    한 번만(기존 계약 무변경)."""
    doc_id = uuid.uuid4()
    html = (
        f'<span data-type="wikiLink" data-doc-id="{doc_id}">A</span>'
        f'<div data-page-embed data-doc-id="{doc_id}"></div>'
    )
    assert extract_doc_mention_ids(html) == [doc_id]


# ─── story #2301(오르테가 리뷰): insert_chat_mentions가 코어의 «얇은 변환»인지 직접 확인 ──


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_insert_chat_mentions_is_a_thin_conversion_of_core_result():
    """`insert_chat_mentions`가 자체 필터/dropped 계산을 다시 하지 않고 코어의 결과값을
    그대로 반환하는지 — 코어를 mock해 임의의 (stored, dropped) 조합을 주입했을 때
    `ChatMentionResult`가 그 값과 **정확히 일치**하면 래퍼에 남은 이중 로직이 없다는 뜻이다
    (오르테가 리뷰 지적, 2026-07-29 — 이전엔 래퍼가 자체 dropped를 계산해 반환해서 이
    mock을 통과할 수 없었다)."""
    import app.services.mention_parser as mp

    org_id = uuid.uuid4()
    message_id = uuid.uuid4()
    fake_result = mp.ReconcileResult(
        stored=7, removed=0, dropped=[{"target_type": "sentinel", "target_id": "x"}],
    )
    with patch.object(mp, "reconcile_entity_references", new=AsyncMock(return_value=fake_result)) as m:
        result = await mp.insert_chat_mentions(
            db=object(), org_id=org_id, message_id=message_id,
            content=f"[X](entity:doc:{uuid.uuid4()})", created_by=uuid.uuid4(),
        )
    assert result.stored == fake_result.stored
    assert result.dropped == fake_result.dropped
    _, kwargs = m.call_args
    assert kwargs["known_new"] is True
    assert kwargs["source_type"] == "chat_message"
    assert kwargs["source_field"] == "body"


@pytest.mark.anyio
async def test_insert_chat_mentions_no_tokens_passes_empty_refs_to_core():
    """토큰이 아예 없는 일반 메시지도 코어를 호출한다(빈 `extracted_refs`로) — 별도
    "비면 skip" 분기를 래퍼에 안 둔다(코어의 `known_new=True` 경로 자체가 이 경우 DB
    왕복 0으로 귀결하므로, 래퍼가 따로 판단할 필요가 없다 — `reconcile_entity_references`
    docstring의 known_new 설명 참조. 실제 DB 미접촉은 `db=None`으로 도는
    `test_dropped_logging_red_green_mutation_self_check`가 실측한다)."""
    import app.services.mention_parser as mp

    fake_result = mp.ReconcileResult(stored=0, removed=0, dropped=[])
    with patch.object(mp, "reconcile_entity_references", new=AsyncMock(return_value=fake_result)) as m:
        result = await mp.insert_chat_mentions(
            db=object(), org_id=uuid.uuid4(), message_id=uuid.uuid4(),
            content="plain text, no tokens", created_by=uuid.uuid4(),
        )
    m.assert_awaited_once()
    _, kwargs = m.call_args
    assert kwargs["extracted_refs"] == []
    assert result.stored == 0
    assert result.dropped == []


def test_chat_message_body_immutability_premise_still_holds():
    """`insert_chat_mentions`가 코어에 넘기는 `known_new=True`는 "채팅 메시지 본문은 편집
    되지 않는다"는 전제에 기댄다(오르테가 지적, 2026-07-29) — 그 전제가 사라지면 stale
    참조 삭제가 조용히 안 도는 날이 오는데, 주석은 안 잡히니(다음 사람이 안 읽는다) 이
    테스트로 묶는다: `conversations.py`에 메시지 «본문» 편집 라우트(messages/{id}의
    PATCH/PUT)가 생기면 RED.

    ⛔이 전제가 깨지면 할 일(실패 메시지에도 명시): `insert_chat_mentions`이 코어를 부를 때
    `known_new=True`를 걷고(기본값 False로 되돌려) 완전 reconcile로 전환할 것 — doc/story와
    동형으로 편집-가능 콘텐츠는 항상 stale-delete를 돈다.

    양성대조: 이 스캐너가 실재하는 PATCH 라우트 3개(mute·status·conversation 본체)는 실제로
    집는지 확인한다 — 안 그러면 "메시지 편집 라우트 0건"이 "정말 없다"인지 "스캐너가 안
    본다"인지 구분이 안 된다."""
    import re
    from pathlib import Path

    src = Path(__file__).resolve().parent.parent / "app" / "routers" / "conversations.py"
    text = src.read_text()
    routes = re.findall(r'@router\.(patch|put)\(\s*"([^"]+)"', text)

    # 양성대조 — 스캐너가 실재하는 3건은 실제로 잡는다(안 그러면 아래 진짜 시험이 공허통과).
    assert ("patch", "/{conversation_id}/mute") in routes, "스캐너가 실재 라우트를 못 잡는다"
    assert ("patch", "/{conversation_id}/status") in routes, "스캐너가 실재 라우트를 못 잡는다"
    assert ("patch", "/{conversation_id}") in routes, "스캐너가 실재 라우트를 못 잡는다"

    # 진짜 시험 — 메시지 본문 편집 라우트(messages/{id} 형태의 PATCH/PUT)는 아직 없어야 한다.
    message_edit_routes = [
        (method, path) for method, path in routes
        if "messages/" in path or path.rstrip("/").endswith("messages")
    ]
    assert message_edit_routes == [], (
        f"메시지 편집 라우트가 생겼다({message_edit_routes}) — insert_chat_mentions의 "
        "known_new=True 전제(채팅 메시지는 편집되지 않는다)가 깨졌다. mention_parser.py의 "
        "insert_chat_mentions에서 known_new=True를 걷고 완전 reconcile(기본값 False)로 "
        "되돌릴 것."
    )
