"""story #1993(E-KNOWLEDGE-LINK S1) — mention_parser.py 순수 추출 함수 단위 테스트.

TDD: 이 테스트가 먼저 RED(app/services/mention_parser.py 부재)였고, 구현 후 GREEN. 순수 함수라
DB/세션 불요 — extract_chat_doc_mention_ids(정규식)·extract_doc_mention_ids(HTMLParser) 커버.
"""
from __future__ import annotations

import uuid

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
    """⭐핵심 회귀 가드 — `[TAG] 제목`류(이 조직의 실제 명명 관례)가 escape된 채로 와도
    파싱이 성공해야 한다. 예전 정규식(`[^\\]]*`)은 escape를 몰라 이 케이스에서 통째로
    매치 실패했다(#2282 발견·재현)."""
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
