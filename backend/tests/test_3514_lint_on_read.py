"""story #3514(Phase1·BE+FE·소형, 페드루 PO 確定 2026-09-05) — 초안 로드 시 규칙 재검
(lint-on-read). 유나 13회차 ③ 관찰 — 규칙이 바뀐 뒤 기존 초안을 «열기만» 하면 위반이
0으로 보이던 결함(저장/상신 응답에서만 violations가 채워졌다). 원문(site_post)·변형
(channel_post) 동형.

fix — 두 도메인의 단건 GET이 **지금** org 규칙으로 다시 lint한 `violations[]`를
싣는다(저장 시점 스냅샷이 아니다). site_post는 이 단건 GET 자체가 이 스토리에서
신설(이제껏 목록·/versions·/publication뿐이었다). channel_post는 기존 단건 GET(story
#3403)에 필드만 얹는다. 목록 응답엔 안 실음(행마다 lint하면 비용 N배, PO 明示 "단건만").

세팅 헬퍼는 test_e4fc29fa_site_post_orchestration.py(site_post)·test_3403_channel_
post_draft_detail.py(channel_post)와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _client_for as _sp_client_for,
    _create_and_submit_site_post_draft,
    _seed_agent as _seed_sp_agent,
    _seed_default_role as _seed_sp_default_role,
    _seed_org as _seed_sp_org,
    _seed_story as _seed_sp_story,
    _seed_wordpress_connection,
    _session_factory as _sp_session_factory,
    _setup_org_scoped_app as _setup_sp_org_scoped_app,
)
from tests.test_3403_channel_post_draft_detail import (
    _client_for as _cp_client_for,
    _draft_body,
    _seed_agent as _seed_cp_agent,
    _seed_connection as _seed_cp_connection,
    _seed_org as _seed_cp_org,
    _seed_story as _seed_cp_story,
    _session_factory as _cp_session_factory,
    _setup_org_scoped_app as _setup_cp_org_scoped_app,
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
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


async def _put_rules(session, *, org_id, rules):
    # story #3501(PR#3856, CAS 낙관적 잠금) — expected_version이 필수 인자가 됐다(#3514
    # 브랜치가 #3856 착지 前에 갈라져 나와 몰랐던 자리, develop CI 핫픽스). 이 헬퍼가
    # PUT 엔드포인트와 동형으로 "지금 서버 버전"을 먼저 읽어 넘긴다 — 한 테스트 안에서
    # 같은 org에 두 번 PUT하는 경우(규칙 추가→원복)가 있어 0 하드코딩은 두 번째 호출을
    # 깬다.
    from app.services.content_rules import get_org_content_rules, put_org_content_rules

    existing = await get_org_content_rules(session, org_id=org_id)
    expected_version = existing.version if existing else 0
    return await put_org_content_rules(
        session, org_id=org_id, rules=rules, updated_by_member_id=uuid.uuid4(),
        expected_version=expected_version,
    )


# ─── site_post ────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_site_post_detail_unknown_draft_404():
    from app.main import app

    engine, Session = await _sp_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_sp_org(s)
            agent_id = await _seed_sp_agent(s, org_id, project_id)

        _setup_sp_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _sp_client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{uuid.uuid4()}")
        assert r.status_code == 404
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_detail_no_rules_violations_empty():
    from app.main import app

    engine, Session = await _sp_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_sp_org(s)
            await _seed_sp_default_role(s, org_id)
            agent_id = await _seed_sp_agent(s, org_id, project_id)
            story_id = await _seed_sp_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url="https://example.com")

        _setup_sp_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _sp_client_for(app) as client:
            draft_id, _gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )
            r = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}")
        assert r.status_code == 200, r.text
        assert r.json()["violations"] == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_detail_reflects_current_rules_without_resave():
    """핵심 pin — 초안 생성 «뒤에» 규칙을 추가해도(저장 없이) 다음 GET이 위반을 보인다.
    규칙 원복 뒤 다시 GET하면 0으로 돌아온다(스냅샷 아니라 매번 재검이라는 증거)."""
    from app.main import app

    engine, Session = await _sp_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_sp_org(s)
            await _seed_sp_default_role(s, org_id)
            agent_id = await _seed_sp_agent(s, org_id, project_id)
            story_id = await _seed_sp_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url="https://example.com")

        _setup_sp_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _sp_client_for(app) as client:
            draft_id, _gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

            async with Session() as s:
                await _put_rules(s, org_id=org_id, rules={"banned_terms": ["본문"]})

            r_after_rule = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}")
            assert r_after_rule.status_code == 200, r_after_rule.text
            violations = r_after_rule.json()["violations"]
            assert len(violations) >= 1, "규칙 추가 뒤 재저장 없이 GET했는데 위반이 안 보인다(#3514 원 증상)"
            assert violations[0]["code"] == "banned_term"

            async with Session() as s:
                await _put_rules(s, org_id=org_id, rules={"banned_terms": []})

            r_after_revert = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}")
        assert r_after_revert.json()["violations"] == [], "규칙 원복 뒤에도 옛 위반이 남아있다(스냅샷 캐시 의심)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_list_does_not_compute_violations():
    """PO 明示 — 목록 응답은 행마다 lint 안 함(비용 N배 방지), violations=None 그대로."""
    from app.main import app

    engine, Session = await _sp_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_sp_org(s)
            await _seed_sp_default_role(s, org_id)
            agent_id = await _seed_sp_agent(s, org_id, project_id)
            story_id = await _seed_sp_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url="https://example.com")

        _setup_sp_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _sp_client_for(app) as client:
            await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

            async with Session() as s:
                await _put_rules(s, org_id=org_id, rules={"banned_terms": ["본문"]})

            r = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
        assert r.status_code == 200, r.text
        assert all(row.get("violations") is None for row in r.json())
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── channel_post ──────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_channel_post_detail_reflects_current_rules_without_resave():
    from app.main import app

    engine, Session = await _cp_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_cp_org(s)
            agent_id = await _seed_cp_agent(s, org_id, project_id)
            story_id = await _seed_cp_story(s, org_id, project_id)
            connection_id = await _seed_cp_connection(s, org_id)

        _setup_cp_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _cp_client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="채널 포스트 본문입니다."),
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_before = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert r_before.json()["violations"] == []

            async with Session() as s2:
                await _put_rules(s2, org_id=org_id, rules={"banned_terms": ["본문"]})

            r_after = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_after.status_code == 200, r_after.text
        violations = r_after.json()["violations"]
        assert len(violations) >= 1, "규칙 추가 뒤 재저장 없이 GET했는데 위반이 안 보인다(#3514 원 증상)"
        assert violations[0]["code"] == "banned_term"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_list_does_not_compute_violations():
    from app.main import app

    engine, Session = await _cp_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_cp_org(s)
            agent_id = await _seed_cp_agent(s, org_id, project_id)
            story_id = await _seed_cp_story(s, org_id, project_id)
            connection_id = await _seed_cp_connection(s, org_id)
            await _put_rules(s, org_id=org_id, rules={"banned_terms": ["본문"]})

        _setup_cp_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _cp_client_for(app) as client:
            await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="채널 포스트 본문입니다."),
            )
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        assert r.status_code == 200, r.text
        assert all(row.get("violations") is None for row in r.json())
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
