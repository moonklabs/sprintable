"""story #4290 — 사람이 «다시 시도»할 수 있는가는 서버 한 판정(`human_retryable`)이다. 재시도 엔드포인트가 받는지(200/404)와 글 상세 ·
목록의 `command_retryable`(화면 배지 버튼이 읽는 값)이 모든 명령 상태에서 같다.

- AC2: 상태 · failure_kind 조합마다 «상세가 참이라고 한 것 ⇔ 재시도가 받는 것». 뮤테이션: 재시도 쪽을 예전처럼 따로 가르면(예: blocked
  빼기) 그 줄이 RED.
- AC3: 낡은 화면 — 다른 재시도가 먼저 받아 pending이 된 뒤의 내 재시도는 404, 그 사이 워커가 또 멈춰 새 dead_letter가 되면 다시 읽은
  상세는 retryable=true(화면은 그 값으로 결과 줄을 고른다).
- 까디르 QA(PO 06:40Z): ① 일시정지 blocked는 사람 재시도 대상 아님(상세 false ⇔ 404) · ② 발행 409가 실제 명령 상태와 같은 판정을
  싣는다 · ③ 에이전트가 보면 command_retryable=false(재시도 엔드포인트는 사람만 · 403) · ④ 성과 보드 행도 같은 판정.
"""
from __future__ import annotations

import os

import pytest

from tests.test_0e960006_command_id_exposure import (
    _client_for,
    _create_draft_submit_approve,
    _seed_agent,
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


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


# (status, failure_kind, reason_code) — 서버가 실제로 만드는 조합 + 화면이 따로 갈랐던 틈(pending/in_progress + 비-transient).
CASES = [
    ("dead_letter", "needs_check", "X_POST_TWEET_MISSING_ID"),
    ("dead_letter", "not_sent", "STIBEE_PLAN_RESTRICTED"),
    ("dead_letter", "transient", "CHANNEL_PUBLISH_PROVIDER_ERROR"),
    ("blocked", "connection", "CHANNEL_TOKEN_EXPIRED"),
    ("blocked", "paused", None),
    ("pending", "transient", "CHANNEL_PUBLISH_PROVIDER_ERROR"),
    ("pending", None, None),
    ("pending", "needs_check", "X_POST_TWEET_MISSING_ID"),
    ("in_progress", "needs_check", "X_POST_TWEET_MISSING_ID"),
    ("completed", None, None),
    ("voided", None, "CONTENT_CHANGED"),
    ("cancelled", None, None),
]


async def _world(Session):
    """승인된 채널 초안 + 즉시 발행으로 만든 명령 하나."""
    from unittest.mock import AsyncMock, patch

    import app.services.threads_publish as tp
    from app.main import app

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        agent_id = await _seed_agent(s, org_id, project_id)
        human_id = await _seed_human(s, org_id)
        story_id = await _seed_story(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id)
    _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
    async with _client_for(app) as client, Session() as s:
        draft_id, _gate_id = await _create_draft_submit_approve(
            client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
        )
    with (
        patch.object(tp, "create_container", AsyncMock(return_value="creation-1")),
        patch.object(tp, "publish_container", AsyncMock(return_value="media-1")),
        patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
        patch.object(tp, "get_permalink", AsyncMock(return_value=None)),
    ):
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r_pub.status_code == 200, r_pub.text
            command_id = (r_pub.json().get("data") or r_pub.json())["command_id"]
    return app, org_id, draft_id, command_id, human_id, agent_id


async def _set(Session, command_id, *, status, failure_kind, reason_code):
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        await s.execute(update(PublicationCommand).where(PublicationCommand.id == command_id).values(
            status=status, failure_kind=failure_kind, reason_code=reason_code,
        ))
        await s.commit()


@pytest.mark.anyio
async def test_the_detail_says_retryable_exactly_when_the_retry_endpoint_accepts():
    """AC2 — 조합마다 상세(단건 · 목록)의 command_retryable ⇔ 재시도 200. 예전 화면 판정이 켜던 틈(pending/in_progress + needs_check)은
    서버 판정으로 false · 재시도 404로 같은 사실."""
    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id, command_id, _human_id, _agent_id = await _world(Session)
        base = f"/api/v2/organizations/{org_id}/channel-posts"
        seen = {}
        async with _client_for(app) as client:
            for status, failure_kind, reason_code in CASES:
                await _set(Session, command_id, status=status, failure_kind=failure_kind, reason_code=reason_code)
                detail = (await client.get(f"{base}/drafts/{draft_id}")).json()
                listed = next(i for i in (await client.get(f"{base}/drafts")).json() if i["draft_id"] == draft_id)
                assert detail["command_retryable"] == listed["command_retryable"]
                r = await client.post(f"{base}/publication-commands/{command_id}/retry")
                assert r.status_code in (200, 404), r.text
                seen[(status, failure_kind)] = (detail["command_retryable"], r.status_code == 200)
        assert all(flag == accepted for flag, accepted in seen.values()), seen
        assert seen[("dead_letter", "needs_check")] == (True, True)
        assert seen[("blocked", "connection")] == (True, True)
        assert seen[("pending", "needs_check")] == (False, False)
        assert seen[("in_progress", "needs_check")] == (False, False)
        # 까디르 QA ① — 조직 일시정지로 멈춘 blocked: 화면이 숨기는 줄 = 서버도 사람 재시도 대상 아님(정지를 풀면 서버가 다시 올린다).
        assert seen[("blocked", "paused")] == (False, False)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_stale_retry_is_404_and_the_reloaded_new_stop_is_retryable():
    """AC3 — 화면 A · B가 같은 dead_letter를 봄 → B가 먼저 재시도(200 · pending) → A의 재시도 404 → 워커가 또 멈춰 같은 명령이 새
    dead_letter → A가 다시 읽은 상세는 retryable=true(버튼 켜짐이 맞다 — 화면은 결과 줄을 이 값으로 고른다)."""
    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id, command_id, _human_id, _agent_id = await _world(Session)
        base = f"/api/v2/organizations/{org_id}/channel-posts"
        await _set(Session, command_id, status="dead_letter", failure_kind="needs_check", reason_code="X_POST_TWEET_MISSING_ID")
        async with _client_for(app) as client:
            assert (await client.post(f"{base}/publication-commands/{command_id}/retry")).status_code == 200  # B
            assert (await client.post(f"{base}/publication-commands/{command_id}/retry")).status_code == 404  # A(낡은 화면)
            assert (await client.get(f"{base}/drafts/{draft_id}")).json()["command_retryable"] is False
            await _set(Session, command_id, status="dead_letter", failure_kind="needs_check", reason_code="X_POST_TWEET_MISSING_ID")
            reloaded = (await client.get(f"{base}/drafts/{draft_id}")).json()
        assert (reloaded["command_status"], reloaded["failure_kind"], reloaded["command_retryable"]) == (
            "dead_letter", "needs_check", True,
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_viewer_never_gets_a_retryable_command():
    """까디르 QA ③ — 같은 dead_letter를 사람은 retryable=true로, 에이전트는 false로 받는다(재시도 엔드포인트가 사람만 · 에이전트 403).
    성과 보드 행(④)도 같은 판정. 뮤테이션: 읽는 자리가 보는 쪽을 안 보면(사람 판정만) 에이전트 줄이 RED."""
    from tests.test_0e960006_command_id_exposure import _setup_org_scoped_app as setup

    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id, command_id, human_id, agent_id = await _world(Session)
        base = f"/api/v2/organizations/{org_id}/channel-posts"
        await _set(Session, command_id, status="dead_letter", failure_kind="needs_check", reason_code="X_POST_TWEET_MISSING_ID")
        seen = {}
        for who, user_id, agent in (("human", human_id, False), ("agent", agent_id, True)):
            setup(app, Session, org_id, user_id=user_id, agent=agent)
            async with _client_for(app) as client:
                detail = (await client.get(f"{base}/drafts/{draft_id}")).json()
                listed = next(i for i in (await client.get(f"{base}/drafts")).json() if i["draft_id"] == draft_id)
                board = (await client.get(f"/api/v2/organizations/{org_id}/insights-board")).json()
                rows = [r for r in (board.get("items") or board.get("rows") or []) if r.get("channel_post_draft_id") == str(draft_id)]
                retry = await client.post(f"{base}/publication-commands/{command_id}/retry") if agent else None
            seen[who] = (detail["command_retryable"], listed["command_retryable"], [r["command_retryable"] for r in rows])
            if retry is not None:
                assert retry.status_code == 403, retry.text
        assert seen["human"][:2] == (True, True) and seen["human"][2] in ([True], []), seen
        assert seen["agent"][:2] == (False, False) and seen["agent"][2] in ([False], []), seen
        assert seen["human"][2] == [True], f"성과 보드에 이 발행 행이 있어야 한다(공허 통과 방지): {seen}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_publish_409_carries_the_real_status_and_judgement():
    """까디르 QA ② — 발행 409(needs_check)는 거절된 명령의 실제 상태와 같은 한 판정을 싣는다: pending + needs_check면
    command_retryable=false(재시도 404) · dead_letter + needs_check면 true. 화면은 지어내지 않고 이 값을 그대로 쓴다."""
    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id, command_id, _human_id, _agent_id = await _world(Session)
        base = f"/api/v2/organizations/{org_id}/channel-posts"
        got = {}
        async with _client_for(app) as client:
            for status in ("pending", "dead_letter"):
                await _set(Session, command_id, status=status, failure_kind="needs_check", reason_code="X_POST_TWEET_MISSING_ID")
                r = await client.post(f"{base}/drafts/{draft_id}/publish")
                assert r.status_code == 409, r.text
                body = r.json()
                err = body.get("error") or body.get("detail") or {}
                got[status] = (err.get("command_status"), err.get("command_retryable"), err.get("command_id"))
        assert got["pending"] == ("pending", False, str(command_id)), got
        assert got["dead_letter"] == ("dead_letter", True, str(command_id)), got
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
