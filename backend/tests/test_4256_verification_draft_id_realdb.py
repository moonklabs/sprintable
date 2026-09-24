"""story #4256 — 블로그 레시피 verification 멘션의 발행 예시가 `site_post_draft_id`를 서버가 아는 실제 값으로 채운다.

- 이 스토리에 발행 전(status=draft) · 삭제 안 된 블로그 초안이 정확히 1건 → 그 id(예시를 그대로 발행하면 스키마 통과 — 자리 표시면 uuid 검증 422).
- 0건 → 자리 표시(지금 문구). 2건 이상 → 자리 표시 + 후보 id 목록(가장 최근 것을 고르지 않는다 — 추측 금지).
- 다른 조직 · 발행된(status≠draft) · 삭제된 초안은 세지 않는다.
세션은 커밋하지 않는다(flush만 — 테스트 끝에 롤백).
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_4174_blog_article_preset_realdb import _REAL_DB_URL, _definition, _with_session

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_PLACEHOLDER = "<draft_id you passed to submit_site_post_draft>"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _example(content: str) -> dict:
    m = re.search(r"publish_event\((\{.*\})\)", content)
    assert m, content
    return json.loads(m.group(1))


async def _render(s, org_id, story_id, locale="ko"):
    from app.routers.events import _render_event_message_content

    d = await _definition(s)
    content = await _render_event_message_content(
        s, org_id=org_id, definition=d, payload={"stage": "verification", "work_item_type": "story", "work_item_id": str(story_id)},
        resolved_locale=locale,
    )
    return d, content


def _draft(org_id, story_id, **kw):
    from app.models.site_post_draft import SitePostDraft

    return SitePostDraft(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, slug=f"s-{uuid.uuid4().hex[:8]}", **kw)


async def test_one_open_draft_fills_real_id_and_example_passes_schema():
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD
    from app.services.event_definition_registry import validate_event_payload

    async def body(s):
        org_id, story_id = uuid.uuid4(), uuid.uuid4()
        mine = _draft(org_id, story_id)
        # 세지 않는 것: 발행된 옛 회차 · 삭제된 초안 · 다른 조직의 같은 work item 초안
        s.add_all([
            mine,
            _draft(org_id, story_id, status="published"),
            _draft(org_id, story_id, deleted_at=datetime.now(timezone.utc)),
            _draft(uuid.uuid4(), story_id),
        ])
        await s.flush()
        d, content = await _render(s, org_id, story_id)
        ex = _example(content)
        assert ex["payload"][RECIPE_SITE_DRAFT_LINK_FIELD] == str(mine.id)
        validate_event_payload(d.payload_schema, ex["payload"])  # 예시 그대로 발행 — 422 없음
        assert _PLACEHOLDER not in content

    await _with_session(body)


async def test_zero_drafts_keeps_placeholder_without_candidates():
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD

    async def body(s):
        _d, content = await _render(s, uuid.uuid4(), uuid.uuid4())
        assert _example(content)["payload"][RECIPE_SITE_DRAFT_LINK_FIELD] == _PLACEHOLDER
        assert "초안이 여럿" not in content

    await _with_session(body)


async def test_two_drafts_keep_placeholder_and_list_candidates_without_picking():
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD

    async def body(s):
        org_id, story_id = uuid.uuid4(), uuid.uuid4()
        a, b = _draft(org_id, story_id), _draft(org_id, story_id)
        s.add_all([a, b])
        await s.flush()
        _d, content = await _render(s, org_id, story_id)
        assert _example(content)["payload"][RECIPE_SITE_DRAFT_LINK_FIELD] == _PLACEHOLDER  # 최근 것을 고르지 않는다
        assert str(a.id) in content and str(b.id) in content
        _d, en = await _render(s, org_id, story_id, locale="en")
        assert "several unpublished blog drafts" in en and str(a.id) in en

    await _with_session(body)
