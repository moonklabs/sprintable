"""story #4269 — 발행 시도 장부 `publication_attempts.adapter_called`는 이 시도가 공급자에 **쓰기 요청을 실제로 보냈을 때만** True.

판정은 한 곳 — 공급자 호출 표시(`provider_call_mark` · #4272): 발행 경로의 HTTP 클라이언트(`provider_client`)가 쓰기 요청을 보내기
직전에 켠다. 워커(채널 · 사이트 · 댓글 답글 · 광고)는 #4272에서 이미 이 표시를 읽고, 이 스토리는 남은 한 자리 — **즉시 발행 라우터** —
를 같은 표시로 옮긴다. 예전 라우터는 실패 갈래마다 True를 박아 두어:
- 게시 한도 조회(GET · 읽기) 뒤 한도 초과(`CHANNEL_RATE_LIMITED`)도 «불렀다»로 적혔고,
- 같은 버전 동시 요청에서 진 쪽(이긴 쪽의 실패를 다시 알림 — 이 요청의 호출 0)도 «불렀다»로 적혔다.
라우터는 발행 전에 표시를 지워(`reset_provider_call_mark`) 앞 일의 표시가 새지 않게 한다. 성공(published)은 워커와 같이 True.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_4264_failure_classification_realdb import (  # noqa: F401 — 픽스처(파일 단위 autouse)를 그대로 쓴다
    _configure_secrets,
    _dispose_global_engine_after_test,
    _local_channel_media_storage,
    anyio_backend,
)
from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _seed_connection,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


def _rate_limited():
    from datetime import UTC, datetime, timedelta

    from app.services.channel_posts import ChannelRateLimitedError

    return ChannelRateLimitedError(reset_at=datetime.now(UTC) + timedelta(hours=1))


def _token_expired():
    from app.services.channel_posts import ChannelTokenExpiredError

    return ChannelTokenExpiredError(connection_id=uuid.uuid4(), provider_message="expired")


def _provider_error():
    from app.services.channel_posts import ChannelPublishProviderError

    return ChannelPublishProviderError(provider_code="X_POST_TWEET_MISSING_ID", provider_message="id missing")


async def _publish_once(monkeypatch, *, exc_factory, wrote: bool, stale_mark: bool = False):
    """즉시 발행 한 번 — 가짜 발행이 (`wrote`면 쓰기 요청 표시를 켠 뒤) `exc_factory()`를 던진다. 장부 행 (adapter_called, result_code)."""
    from sqlalchemy import select

    from app.models.publication_attempt import PublicationAttempt
    from app.models.publication_command import PublicationCommand
    from app.routers import channel_posts as router_module
    from app.services.provider_call_mark import mark_provider_call
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly,
        _create_draft,
        _png_bytes,
        _upload_and_confirm,
    )

    async def _fake_publish(*_args, **_kwargs):
        if wrote:
            mark_provider_call()  # `provider_client`의 쓰기 요청 훅이 하는 일과 같다
        raise exc_factory()

    monkeypatch.setattr(router_module, "publish_channel_post_draft", _fake_publish)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)
        from app.main import app

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                assert (await _upload_and_confirm(client, org_id, draft_id, _png_bytes(800, 800), content_type="image/png")).status_code == 201
                r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
                assert r_submit.status_code == 200, r_submit.text
                async with Session() as s:
                    await _approve_gate_directly(s, uuid.UUID(r_submit.json()["gate_id"]))
                if stale_mark:
                    mark_provider_call()  # 같은 컨텍스트에서 앞 일이 켜 둔 표시 — 라우터가 발행 전에 지워야 한다
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        finally:
            app.dependency_overrides.clear()
        assert r.status_code >= 400, r.text
        async with Session() as s:
            rows = (await s.execute(
                select(PublicationAttempt.adapter_called, PublicationAttempt.result_code).where(
                    PublicationAttempt.command_id.in_(select(PublicationCommand.id).where(PublicationCommand.org_id == org_id))
                )
            )).all()
        assert len(rows) == 1, rows
        return tuple(rows[0])
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize(("case", "exc_factory", "wrote", "expected"), [
    ("게시 한도 GET 뒤 초과 — 쓰기 0", _rate_limited, False, (False, "CHANNEL_RATE_LIMITED")),
    ("동시 요청 진 쪽 — 이긴 쪽 실패 재알림 · 이 요청 호출 0", _token_expired, False, (False, "CHANNEL_TOKEN_EXPIRED")),
    # 라우터 장부는 공급자 코드 대신 `CHANNEL_PUBLISH_PROVIDER_ERROR`로 적는다(워커는 공급자 코드) — 4269 범위 밖, PR 본문에 기록.
    ("쓰기 요청 뒤 공급자 오류", _provider_error, True, (True, "CHANNEL_PUBLISH_PROVIDER_ERROR")),
    ("쓰기 요청 뒤 토큰 만료 응답", _token_expired, True, (True, "CHANNEL_TOKEN_EXPIRED")),
])
async def test_the_immediate_publish_ledger_says_whether_this_request_wrote_to_the_provider(monkeypatch, case, exc_factory, wrote, expected):
    """AC1 — 뮤테이션: 라우터 실패 갈래를 예전처럼 True로 박으면 앞 두 줄이 RED."""
    assert await _publish_once(monkeypatch, exc_factory=exc_factory, wrote=wrote) == expected, case


@pytest.mark.anyio
async def test_a_mark_left_by_earlier_work_does_not_leak_into_this_attempt(monkeypatch):
    """발행 전에 표시를 지운다 — 뮤테이션: `reset_provider_call_mark()`를 빼면 쓰기 0인 실패가 True로 RED."""
    assert await _publish_once(monkeypatch, exc_factory=_token_expired, wrote=False, stale_mark=True) == (False, "CHANNEL_TOKEN_EXPIRED")


def test_every_failure_ledger_write_in_the_router_reads_the_one_mark():
    """AC2 — 판정 사본 0: 즉시 발행 라우터의 발행 호출 뒤 실패 기록은 전부 `provider_call_marked()`를 읽고(코드별로 True/False를
    손으로 박지 않는다), 성공(published) 하나만 True. 워커 쪽은 #4272가 같은 표시를 읽는다."""
    import re
    from pathlib import Path

    src = (Path(__file__).resolve().parents[1] / "app/routers/channel_posts.py").read_text()
    start = src.index("reset_provider_call_mark()\n    try:\n        row = await publish_channel_post_draft(")
    end = src.index('await _record_this_attempt(approval_check="ok", adapter_called=True, result_code="published")', start)
    chain = src[start:end]
    writes = re.findall(r"_record_this_attempt\(approval_check=\"[a-z_]+\", adapter_called=([^,]+),", chain)
    assert len(writes) >= 15, writes  # 스캔이 실제 갈래들을 읽는지(공허 통과 방지)
    assert set(writes) == {"provider_call_marked()"}, writes
