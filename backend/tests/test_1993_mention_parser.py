"""story #1993(E-KNOWLEDGE-LINK S1) — mention_parser.py 순수 추출 함수 단위 테스트.

TDD: 이 테스트가 먼저 RED(app/services/mention_parser.py 부재)였고, 구현 후 GREEN. 순수 함수라
DB/세션 불요 — extract_chat_doc_mention_ids(정규식)·extract_doc_mention_ids(HTMLParser) 커버.
"""
from __future__ import annotations

import uuid

from app.services.mention_parser import (
    extract_chat_doc_mention_ids,
    extract_doc_mention_ids,
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
