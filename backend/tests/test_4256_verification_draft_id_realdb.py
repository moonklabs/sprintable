"""story #4256 — 블로그 레시피 verification 멘션의 발행 예시가 `site_post_draft_id`를 서버가 아는 실제 값으로 채운다.

- 이 스토리에 아직 발행 안 된 · 삭제 안 된 블로그 초안이 정확히 1건 → 그 id(예시를 그대로 발행하면 스키마 통과 — 자리 표시면 uuid 검증 422).
- 0건 → 자리 표시(지금 문구). 2건 이상 → 자리 표시 + 후보 id 목록(가장 최근 것을 고르지 않는다 — 추측 금지).
- «발행됨»은 발행 행으로 가른다(까디르 QA · PO 07:07Z — SitePostDraft.status는 늘 «draft»): 자사 블로그 SitePost(story · slug) ·
  외부 ChannelPublication(published · 그 초안 버전). 다른 조직 · 삭제된 초안도 세지 않는다.
- 조회가 실패해도 멘션은 자리 표시로 나가고 세션은 살아 있다(savepoint).
세션은 커밋하지 않는다(flush만 — 테스트 끝에 롤백).
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime

import pytest

from tests.test_4174_blog_article_preset_realdb import (
    _REAL_DB_URL,
    _definition,
    _with_session,
)

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


def _hosted_post(org_id, story_id, slug):
    from app.models.site_post import SitePost

    return SitePost(id=uuid.uuid4(), org_id=org_id, lang="ko", slug=slug, title="t", summary="s", body_md="b",
                    published_at=datetime.now(UTC), source_story_id=story_id, gate_id=uuid.uuid4())


def _draft(org_id, story_id, **kw):
    from app.models.site_post_draft import SitePostDraft

    return SitePostDraft(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, slug=f"s-{uuid.uuid4().hex[:8]}", **kw)


async def test_one_open_draft_fills_real_id_and_example_passes_schema():
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD
    from app.services.event_definition_registry import validate_event_payload

    async def body(s):
        org_id, story_id = uuid.uuid4(), uuid.uuid4()
        previous = _draft(org_id, story_id)  # 지난 회차 — 자사 블로그에 발행됨(status는 여전히 «draft»)
        mine = _draft(org_id, story_id)
        # 세지 않는 것: 발행된 지난 회차 · 삭제된 초안 · 다른 조직의 같은 work item 초안
        s.add_all([
            previous,
            _hosted_post(org_id, story_id, previous.slug),
            mine,
            _draft(org_id, story_id, deleted_at=datetime.now(UTC)),
            _draft(uuid.uuid4(), story_id),
        ])
        await s.flush()
        assert previous.status == "draft"  # status로는 못 가른다
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


async def test_externally_published_draft_is_not_counted():
    """외부 목적지에 발행된 초안(그 버전을 가리키는 ChannelPublication status=published)도 세지 않는다 — 남은 1건을 채운다."""
    from app.models.channel_publication import ChannelPublication
    from app.models.site_post_version import SitePostVersion
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD

    async def body(s):
        org_id, story_id = uuid.uuid4(), uuid.uuid4()
        external, mine = _draft(org_id, story_id), _draft(org_id, story_id)
        s.add_all([external, mine])
        await s.flush()
        v = SitePostVersion(id=uuid.uuid4(), draft_id=external.id, version=1, title="t", lang="ko", summary="s", body_md="b",
                            body_sha256="x", author_member_id=uuid.uuid4(), author_kind="agent")
        s.add(v)
        await s.flush()
        s.add(ChannelPublication(id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=v.id, connection_id=uuid.uuid4(),
                                 channel="wordpress", status="published"))
        await s.flush()
        _d, content = await _render(s, org_id, story_id)
        assert _example(content)["payload"][RECIPE_SITE_DRAFT_LINK_FIELD] == str(mine.id)

    await _with_session(body)


async def test_lookup_failure_falls_back_to_placeholder_and_keeps_session_alive(monkeypatch):
    """⭐조회가 DB에서 실패해도(없는 테이블) 멘션은 자리 표시로 나가고, 같은 세션의 다음 쿼리가 산다(savepoint — 예외만 삼키면 aborted)."""
    from types import SimpleNamespace

    from sqlalchemy import column, table, text

    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD

    missing = table("no_such_table_4256", column("org_id"), column("source_story_id"), column("slug"))
    monkeypatch.setattr("app.models.site_post.SitePost", SimpleNamespace(
        org_id=missing.c.org_id, source_story_id=missing.c.source_story_id, slug=missing.c.slug,
    ))

    async def body(s):
        org_id, story_id = uuid.uuid4(), uuid.uuid4()
        s.add(_draft(org_id, story_id))
        await s.flush()
        _d, content = await _render(s, org_id, story_id)
        assert _example(content)["payload"][RECIPE_SITE_DRAFT_LINK_FIELD] == _PLACEHOLDER
        assert (await s.execute(text("select 1"))).scalar_one() == 1

    await _with_session(body)
