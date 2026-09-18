"""story #3476(Phase1·BE·결함, 런북 A-7 FAIL 2026-09-05) — 외부 목적지(WordPress·
webhook) 발행 결과를 읽는 표면 신설. `/site-posts/drafts/{id}/publication`·
`/publish`·`/unpublish`가 `channel_publications`/`publication_commands`에 이미
쓰인 값(permalink·external_id·status·attempt_count·dead_letter_at 등)을 destination
축과 함께 실어 반환한다 — 전용 엔드포인트 신설 없음, 기존 표면 확장뿐(페드루 5줄
確定 그대로).

세팅 헬퍼는 test_e4fc29fa_site_post_orchestration.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import uuid

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _client_for,
    _create_and_submit_site_post_draft,
    _seed_agent,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _seed_wordpress_connection,
    _session_factory,
    _setup_org_scoped_app,
    live_wordpress_stub,  # noqa: F401 — pytest fixture import
)

import os

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


@pytest.mark.anyio
async def test_publication_view_shows_wordpress_permalink_and_external_id_after_worker_run(live_wordpress_stub):
    """(1) 양성대조 — 승인·워커 처리 뒤 GET /publication이 destination="wordpress"·
    channel_publication.permalink(dev-wordpress-stub.internal/{slug}/)·external_id·
    status="published"을 실제로 실어 준다(런북 A-7이 요구하는 그 값)."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id, slug="perm-test",
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["destination"] == "wordpress"
        pub = body["channel_publication"]
        assert pub is not None
        assert pub["status"] == "published"
        assert pub["external_id"] is not None
        assert pub["permalink"] == "https://dev-wordpress-stub.internal/perm-test/"
        assert pub["last_error"] is None
        cmd = body["command"]
        assert cmd is not None
        assert cmd["command_status"] == "completed"
        assert cmd["attempt_count"] == 0  # 성공은 attempt_count를 안 건드린다(실패 카운터).
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_hosted_site_publication_view_regression_unchanged():
    """(2) 양성대조 — hosted_site(connection_id=None) draft는 destination="hosted_site"
    고정·channel_publication/command 둘 다 null(회귀 0, 새 필드 추가가 기존 4필드
    계약을 안 건드린다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "제목", "slug": "hosted-view-test",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
                },
            )
            assert r.status_code == 201, r.text
            draft_id = uuid.UUID(r.json()["draft_id"])

            r2 = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["destination"] == "hosted_site"
        assert body["channel_publication"] is None
        assert body["command"] is None
        assert body["published_at"] is None
        assert body["url"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_dead_letter_command_shows_last_error_and_dead_letter_at():
    """(3) — 결정적 실패로 dead_letter된 커맨드도 last_error·dead_letter_at이 읽기
    표면에 그대로 실린다(카디르가 로그 없이 원인을 볼 수 있어야 한다는 런북 요구)."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            # 스텁이 아닌 도달 불가 URL — adapter 호출이 결정적으로 실패한다(연결
            # 자체가 없다는 뜻이 아니라 provider 자체가 존재하지 않는 host, 재시도
            # 자체는 이 테스트 관심사가 아니라 강제로 dead_letter 상태를 만든다).
            connection_id = await _seed_wordpress_connection(
                s, org_id, site_url="http://127.0.0.1:1/unreachable-test-host",
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        # publication_command.py::apply_command_failure — 매핑표 밖 error_code(이
        # 시나리오는 httpx 연결 실패라 SitePostExternalPublishError 자체를 안 거친다,
        # error_code=None)는 needs_check로 fail-closed → 백오프 없이 첫 tick에서
        # 바로 dead_letter(재시도해도 똑같이 실패할 결정적 실패로 취급).
        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd_id = (await s.execute(
                select(PublicationCommand.id).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["dead_letter"] == 1, counts

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == cmd_id)
            )).scalar_one()
        assert cmd.status == "dead_letter", f"강제 재시도 루프로도 dead_letter를 못 만들었다(현재={cmd.status})"

        _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r.status_code == 200, r.text
        body = r.json()
        cmd_view = body["command"]
        assert cmd_view is not None
        assert cmd_view["command_status"] == "dead_letter"
        assert cmd_view["failure_kind"] == "needs_check"
        assert cmd_view["dead_letter_at"] is not None
        assert cmd_view["last_error"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publication_view_org_isolated(live_wordpress_stub):
    """(4) — org A의 발행 결과가 org B의 draft 조회로 안 새어 나온다(cross-tenant
    유출 부정대조 — get_site_post_external_publication_state의 org_id 필터가 실제로
    막는지)."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            await _seed_default_role(s, org_a)
            agent_a = await _seed_agent(s, org_a, project_a)
            human_user_a, human_a = await _seed_human(s, org_a)
            story_a = await _seed_story(s, org_a, project_a)
            connection_a = await _seed_wordpress_connection(s, org_a, site_url=live_wordpress_stub)

            org_b, project_b = await _seed_org(s)
            agent_b = await _seed_agent(s, org_b, project_b)

        _setup_org_scoped_app(app, Session, org_a, user_id=agent_a, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_a, story_id=story_a, connection_id=connection_a, slug="org-a-post",
            )
        async with Session() as s:
            await transition_gate(s, org_a, gate_id, "approved", resolver_id=human_a)
            await s.commit()
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        # org B가 org A의 draft_id로 조회 — draft 자체가 org B 소속이 아니므로 404.
        _setup_org_scoped_app(app, Session, org_b, user_id=agent_b, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_b}/site-posts/drafts/{draft_id}/publication")
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_and_unpublish_external_responses_carry_channel_publication_and_command(
    live_wordpress_stub,
):
    """(5) — `/publish` 외부 분기 응답도 command(pending 상태) 를 즉시 싣는다(워커
    실행 前 시점 — channel_publication은 아직 없어 null이 정상). unpublish 이후
    재조회하면 channel_publication.status가 "unpublished"로 바뀐 걸 GET에서 본다."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 200, r_pub.text
        pub_body = r_pub.json()
        assert pub_body["status"] == "pending"
        assert pub_body["command"] is not None
        assert pub_body["command"]["command_status"] == "pending"
        assert pub_body["channel_publication"] is None  # 워커가 아직 안 돌았다.

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 200, r_unpub.text
        unpub_body = r_unpub.json()
        assert unpub_body["command"] is not None
        # unpublish 요청 시점의 channel_publication은 아직 "published"(회수 워커가
        # 아직 안 돌았다 — publish와 동형으로 워커 완료 후에야 상태가 바뀐다).
        assert unpub_body["channel_publication"]["status"] == "published"

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with _client_for(app) as client:
            r_get = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r_get.status_code == 200, r_get.text
        assert r_get.json()["channel_publication"]["status"] == "unpublished"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_shared_retry_endpoint_requeues_site_post_dead_letter_command():
    """(6) 페드루 보정② — 신규 공용 `POST .../publication-commands/{id}/retry`가
    site_post 커맨드도 되돌린다(기존 `/channel-posts/publication-commands/{id}/retry`는
    경로 자체에 channel-posts가 박혀 있어 이 시나리오를 애초에 못 태웠다).
    `retry_dead_letter_command`가 content_kind를 안 본다는 그라운딩을 이 경로로
    직접 증명한다."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(
                s, org_id, site_url="http://127.0.0.1:1/unreachable-test-host-2",
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd_id = (await s.execute(
                select(PublicationCommand.id).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["dead_letter"] == 1, counts

        _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/publication-commands/{cmd_id}/retry")
        assert r.status_code == 200, r.text
        assert r.json() == {"id": str(cmd_id), "status": "pending"}

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == cmd_id)
            )).scalar_one()
            assert cmd.status == "pending"
            assert cmd.next_attempt_at is None
            assert cmd.dead_letter_at is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
