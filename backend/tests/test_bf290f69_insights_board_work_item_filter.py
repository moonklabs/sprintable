"""story #bf290f69(Phase2·BE, 페드루 PO 確定 2026-09-08) — story별 성과 대조. 재그라운딩
(착수 前) 결과 #3502 insights-board가 이미 UNION+d1/d7 버킷+work_item_id 셀렉트까지
하고 있어, 새 엔드포인트가 아니라 기존 `list_insights_board`에 `work_item_id` narrowing
필터 하나만 얹는다(신규 개념 0). 세팅 헬퍼는 test_3502_insights_board.py 재사용(중복
재발명 금지, 이 파일과 동형 관례).

핵심 축: work_item_id는 channel/status와 동형 AND-narrowing일 뿐 새 인가 축이 아니다
— org_id 스코프(_build_union 안)는 무변, work_item_id 필터는 그 위에 추가로 좁힐 뿐."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3471_org_content_rules_lint import _seed_org, _seed_story, _session_factory
from tests.test_3502_insights_board import _seed_channel_publication, _seed_gate, _seed_site_post

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_work_item_id_narrows_to_that_story_blog_and_social_only():
    """뮤테이션 킬(페드루 지정) — work_item_id로 좁히면 그 story의 발행물(blog+social
    둘 다)만 온다. WHERE를 빼면(뮤테이션) 다른 story의 발행물이 새 들어온다(RED)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_a = await _seed_story(s, org_id, project_id)
            story_b = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)

            sp_a = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_a, slug="post-a", title="A",
                published_at=now - timedelta(days=1),
            )
            gate_a = await _seed_gate(s, org_id=org_id, work_item_id=story_a)
            cp_a = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate_a.id, channel="threads", published_at=now - timedelta(days=1),
            )

            # story_b — 다른 story, 새면 안 되는 발행물.
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_b, slug="post-b", title="B",
                published_at=now - timedelta(days=1),
            )
            gate_b = await _seed_gate(s, org_id=org_id, work_item_id=story_b)
            await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate_b.id, channel="threads", published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d", work_item_id=story_a)

        ids = {r["publication_id"] for r in result["rows"]}
        assert ids == {sp_a.id, cp_a.id}, f"story_a의 blog+social만 와야 하는데: {ids}"
        assert all(r["work_item_id"] == story_a for r in result["rows"])
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_work_item_id_param_keeps_org_wide_behavior_unchanged():
    """회귀 0 — work_item_id를 안 주면(기존 호출부 전부) 여러 story의 발행물이 그대로
    다 온다(param 신설 前 동작과 동일)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_a = await _seed_story(s, org_id, project_id)
            story_b = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)

            sp_a = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_a, slug="post-a2", title="A2",
                published_at=now - timedelta(days=1),
            )
            sp_b = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_b, slug="post-b2", title="B2",
                published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")

        ids = {r["publication_id"] for r in result["rows"]}
        assert ids == {sp_a.id, sp_b.id}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_work_item_id_combines_with_channel_filter():
    """work_item_id도 channel/status와 같은 AND-narrowing 축 — 같은 story 안에서도
    channel로 더 좁힐 수 있다(신규 상호작용 버그 없음 확인)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_a = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)

            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_a, slug="post-c", title="C",
                published_at=now - timedelta(days=1),
            )
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_a)
            await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads", published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(
                s, org_id=org_id, window="30d", work_item_id=story_a, channel="hosted_site",
            )

        assert [r["publication_id"] for r in result["rows"]] == [sp.id]
    finally:
        await engine.dispose()
