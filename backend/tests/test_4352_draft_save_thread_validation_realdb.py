"""story #4352 — 채널 초안 버전 저장이 이어쓰기(스레드) 검사 예외를 잡지 않아 오류 코드 없는 500이 났다(3808부터).

발행 경로는 4336(PR 4716)이 `CHANNEL_THREAD_*` 코드 · 요청 언어 문장(`publish_error_body.preflight_error_facts`)으로 고쳤고, 저장 경로는
같은 원천으로 4xx가 돼야 한다(AC2). 지금(develop)은 저장 라우트(`POST …/channel-posts/drafts`)의 except 절이 글자 수 · 연결 · 원문 ·
YouTube 메타데이터만 잡아 세 예외가 그대로 500이 된다 → 이 파일이 AC1 재현(RED)이다.

세 모양: 이어쓰기를 지원하지 않는 채널(threads · thread_max_segments=0) · 조각 수 초과(x · 상한 10) · 조각 하나 글자 수 초과(x · 280자).
어느 경우든 초안 행은 만들어지지 않아야 한다(부분 저장 0).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_3374_channel_posts import (
    _REAL_DB_URL,
    _seed_agent,
    _seed_connection,
    _seed_default_role,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    # test_3374 시드(team_members에 직접 쓰기)는 create_all 스키마 전제 — 같은 파괴 표시로 분리 실행한다.
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.parametrize("channel,thread,code", [
    ("threads", ["이어 쓰는 글"], "CHANNEL_THREAD_UNSUPPORTED"),
    ("x", [f"조각 {i}" for i in range(11)], "CHANNEL_THREAD_SEGMENT_LIMIT_EXCEEDED"),
    ("x", ["가" * 281], "CHANNEL_THREAD_SEGMENT_TOO_LONG"),
])
async def test_saving_a_draft_with_an_invalid_thread_is_4xx_with_the_publish_code_and_writes_nothing(channel, thread, code):
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import func, select

    from app.main import app
    from app.models.channel_post_draft import ChannelPostDraft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id, grant=True)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel=channel)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        # 처리 안 된 예외가 테스트 클라이언트로 튀지 않고 실제 응답(500)으로 보이게.
        async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as client:
            resp = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id), "text": "헤드 글",
                    "channel_payload": {"thread": thread},
                },
            )
        assert resp.status_code == 422, f"{resp.status_code}: {resp.text[:300]}"
        assert code in resp.text, resp.text[:300]
        async with Session() as s:
            drafts = (await s.execute(
                select(func.count()).select_from(ChannelPostDraft).where(ChannelPostDraft.work_item_id == story_id)
            )).scalar_one()
        assert drafts == 0, "검사에 걸린 저장이 초안 행을 남겼다(부분 저장)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
