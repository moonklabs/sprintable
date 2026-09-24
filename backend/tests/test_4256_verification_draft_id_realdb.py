"""story #4256 — 블로그 레시피 verification 멘션의 발행 예시가 `site_post_draft_id`를 서버가 아는 실제 값으로 채운다.

- 이 스토리에 아직 발행 안 된 · 삭제 안 된 블로그 초안이 정확히 1건 → 그 id(예시를 그대로 발행하면 스키마 통과 — 자리 표시면 uuid 검증 422).
- 0건 → 자리 표시(지금 문구). 2건 이상 → 자리 표시 + 후보 id 목록(가장 최근 것을 고르지 않는다 — 추측 금지).
- «발행됨»은 발행 감사 로그로 가른다(까디르 QA · PO 07:39Z 확定): 이 초안의 어느 버전이든 activity_logs(site_post_published)의
  context.version_id로 걸림. status(늘 «draft») · SitePost slug(레거시 글과 거짓 일치) · 게이트(스토리 × 목적지 슬롯)로는 못 가른다.
  다른 조직 · 삭제된 초안도 세지 않는다.
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


def _hosted_post(org_id, story_id, slug, **kw):
    from app.models.site_post import SitePost

    return SitePost(id=uuid.uuid4(), org_id=org_id, lang="ko", slug=slug, title="t", summary="s", body_md="b",
                    published_at=datetime.now(UTC), source_story_id=story_id, gate_id=uuid.uuid4(), **kw)


def _version(draft):
    from app.models.site_post_version import SitePostVersion

    return SitePostVersion(id=uuid.uuid4(), draft_id=draft.id, version=1, title="t", lang="ko", summary="s", body_md="b",
                           body_sha256="x", author_member_id=uuid.uuid4(), author_kind="agent")


def _publish_log(org_id, version, entity_type="site_post", action="site_post_published"):
    """발행 성공 때 두 발행 경로가 남기는 감사 로그(site_posts.py — 자사 entity_type=site_post · 외부 channel_publication)."""
    from app.models.activity_log import ActivityLog

    return ActivityLog(id=uuid.uuid4(), org_id=org_id, actor_type="platform", action=action,
                       entity_type=entity_type, entity_id=uuid.uuid4(), context={"version_id": str(version.id)})


def _draft(org_id, story_id, **kw):
    from app.models.site_post_draft import SitePostDraft

    return SitePostDraft(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, slug=f"s-{uuid.uuid4().hex[:8]}", **kw)


async def test_one_open_draft_fills_real_id_and_example_passes_schema():
    """⭐반복 회차 · 레거시 글 · 내린 글 — 이번 초안 하나만 남아 채워진다(status는 모두 «draft»)."""
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD
    from app.services.event_definition_registry import validate_event_payload

    async def body(s):
        org_id, story_id = uuid.uuid4(), uuid.uuid4()
        previous = _draft(org_id, story_id)  # 지난 회차 — 자사 블로그에 발행했다가 내림
        mine = _draft(org_id, story_id)
        s.add_all([previous, mine, _draft(org_id, story_id, deleted_at=datetime.now(UTC)), _draft(uuid.uuid4(), story_id)])
        await s.flush()
        pv = _version(previous)
        s.add(pv)
        await s.flush()
        s.add_all([
            _publish_log(org_id, pv),
            _hosted_post(org_id, story_id, previous.slug, unpublished_at=datetime.now(UTC)),  # 내린 글도 한 번 발행된 것
            _hosted_post(org_id, story_id, mine.slug),  # 초안 없이 올린 레거시 글 — 같은 slug(로그 없음 → 발행 아님)
        ])
        await s.flush()
        assert previous.status == mine.status == "draft"  # status로는 못 가른다
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


async def test_externally_published_draft_is_not_counted_but_a_publication_row_without_log_is():
    """외부 목적지 발행(로그 있음)은 세지 않는다 · 로그 없는 publication 행(아직 컨테이너 단계)은 발행 아님 → 그 초안이 채워진다.
    다른 조직 로그가 이 초안 버전을 가리켜도 발행으로 치지 않는다."""
    from app.models.channel_publication import ChannelPublication
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD

    async def body(s):
        org_id, story_id = uuid.uuid4(), uuid.uuid4()
        external, pending = _draft(org_id, story_id), _draft(org_id, story_id)
        s.add_all([external, pending])
        await s.flush()
        ev, pv = _version(external), _version(pending)
        s.add_all([ev, pv])
        await s.flush()
        s.add_all([
            _publish_log(org_id, ev, entity_type="channel_publication"),
            ChannelPublication(id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=pv.id, connection_id=uuid.uuid4(),
                               channel="wordpress", status="container_created"),
            _publish_log(uuid.uuid4(), pv),  # 다른 조직의 로그
            _publish_log(org_id, pv, action="site_post_publish_requested"),  # 같은 버전을 가리키는 다른 액션 — 발행 아님
        ])
        await s.flush()
        _d, content = await _render(s, org_id, story_id)
        assert _example(content)["payload"][RECIPE_SITE_DRAFT_LINK_FIELD] == str(pending.id)

    await _with_session(body)


async def test_lookup_failure_falls_back_to_placeholder_and_keeps_session_alive(monkeypatch):
    """⭐조회가 DB에서 실패해도(없는 테이블) 멘션은 자리 표시로 나가고, 같은 세션의 다음 쿼리가 산다(savepoint — 예외만 삼키면 aborted)."""
    from types import SimpleNamespace

    from sqlalchemy import column, table, text
    from sqlalchemy.dialects.postgresql import JSONB

    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD

    missing = table("no_such_table_4256", column("org_id"), column("action"), column("context", JSONB))
    monkeypatch.setattr("app.models.activity_log.ActivityLog", SimpleNamespace(
        org_id=missing.c.org_id, action=missing.c.action, context=missing.c.context,
    ))

    async def body(s):
        org_id, story_id = uuid.uuid4(), uuid.uuid4()
        s.add(_draft(org_id, story_id))
        await s.flush()
        _d, content = await _render(s, org_id, story_id)
        assert _example(content)["payload"][RECIPE_SITE_DRAFT_LINK_FIELD] == _PLACEHOLDER
        assert (await s.execute(text("select 1"))).scalar_one() == 1

    await _with_session(body)
