"""story #3614(Phase2·BE, 페드루 PO 確定 2026-09-07) — 채널 글 초안 「폐기」(withdraw).
그라운딩(dev 실물, 2026-09-07 02:29Z): 재작성(3602, 「재료 0」로 닫음)도 폐기도 없어
「변경 요청」 뒤 작성자의 유일한 다음 행동이 「재상신」뿐이었다 — 거절된 초안이
결재함·목록에 영구 잔존.

세팅 헬퍼는 test_3414_publication_command_core.py를 그대로 재사용(중복 재발명 0,
그 파일 자체 docstring이 "세팅 헬퍼·픽스처는 이 파일이 소유"라 명시)."""
from __future__ import annotations

import uuid

import pytest

from tests.test_3414_publication_command_core import (
    _seed_org, _seed_agent, _seed_human, _seed_default_role, _seed_connection, _seed_story,
    _session_factory, _setup_org_scoped_app, _client_for, _draft_body,
)

pytestmark = [pytest.mark.destructive_schema]


@pytest.fixture
def anyio_backend():
    return "asyncio"


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


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _create_draft(client, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다."):
    r = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json=_draft_body(work_item_id=story_id, connection_id=connection_id, text=text),
    )
    assert r.status_code == 201, r.text
    return r.json()["draft_id"]


@pytest.mark.anyio
async def test_origin_author_agent_can_withdraw_own_draft_never_submitted():
    """AC1 — 게이트가 아직 없는(상신 前) 순수 초안도 폐기 가능. 작성자 본인(에이전트)이
    호출 — human 제한 없음(발행 취소·회수 전용 _require_owner_or_admin과 다른 축)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "withdrawn"
        assert body["gate_id"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_author_non_admin_gets_403():
    """AC1 — 작성자도 admin/owner도 아닌 멤버는 403(CHANNEL_POST_WITHDRAW_FORBIDDEN).
    ⭐뮤테이션 표적 — 이 가드를 지우면 아무나 남의 초안을 닫을 수 있게 된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_agent_id = await _seed_agent(s, org_id, project_id, name="작성자")
            other_agent_id = await _seed_agent(s, org_id, project_id, name="타인")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=author_agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=other_agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "CHANNEL_POST_WITHDRAW_FORBIDDEN"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_admin_can_withdraw_someone_elses_draft():
    """AC1 — org owner/admin은 작성자가 아니어도 폐기 가능."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_agent_id = await _seed_agent(s, org_id, project_id, name="작성자")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=author_agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        async with Session() as s:
            admin_user_id = await _seed_human(s, org_id, role="admin")
        _setup_org_scoped_app(app, Session, org_id, user_id=admin_user_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "withdrawn"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pending_gate_gets_rejected_with_author_withdrew_reason():
    """AC1 — 상신해 pending 게이트가 있는 초안을 폐기하면 게이트가 rejected(사유
    「작성자가 폐기」)로 종결된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            assert r_submit.status_code == 200, r_submit.text
            gate_id = r_submit.json()["gate_id"]

            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "withdrawn"
        assert body["gate_id"] == gate_id
        assert body["gate_status"] == "rejected"

        from app.models.gate import Gate
        from sqlalchemy import select
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(gate_id)))).scalar_one()
            assert gate.status == "rejected"
            assert gate.resolution_note == "작성자가 폐기"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_already_published_draft_cannot_be_withdrawn_409():
    """AC1 — 발행된 초안(publication status='published')은 409(발행 취소는 별도
    unpublish 경로). draft.status는 그대로(draft) — 부분 실패 없음. publication
    행은 실제 Threads 왕복 없이 직접 심는다(이 테스트의 관심사는 withdraw 가드지
    발행 파이프라인 자체가 아니다 — 그건 test_f8f7cb0f_channel_post_publish.py 몫)."""
    from app.main import app
    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.channel_publication import ChannelPublication
    from sqlalchemy import select
    from datetime import datetime, timezone

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        from tests.test_3414_publication_command_core import _approve_gate_directly
        async with Session() as s:
            await _approve_gate_directly(s, gate_id)
            from app.models.channel_post_version import ChannelPostVersion
            v = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalars().first()
            pub = ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=v.id, channel="threads",
                connection_id=connection_id, status="published",
                external_id="media-1", permalink="https://threads.net/p/1",
                published_at=datetime.now(timezone.utc),
            )
            s.add(pub)
            await s.commit()

        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "CHANNEL_POST_DRAFT_ALREADY_PUBLISHED"

        async with Session() as s:
            draft = (await s.execute(select(ChannelPostDraft).where(ChannelPostDraft.id == uuid.UUID(draft_id)))).scalar_one()
            assert draft.status == "draft", "409 거부 시 draft.status는 절대 안 바뀌어야 한다(부분 실패 0)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_withdraw_is_idempotent():
    """AC — 이미 폐기된 초안을 다시 호출하면 그대로 조용히 성공(재클릭 방어)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
            assert r1.status_code == 200, r1.text
            r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r2.status_code == 200, r2.text
        assert r2.json()["status"] == "withdrawn"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_can_withdraw_field_three_branches_via_detail_endpoint():
    """story #3614 CHANGES(유나 재판정, 페드루 PO 채택 2026-09-07) — 이웃 can_unpublish와
    같은 정책: 서버가 (원저자 또는 org owner/admin) ∧ 미발행 ∧ 미폐기를 계산해
    can_withdraw 하나로 낸다. 3분기: ①원저자=true ②무관 멤버=false ③org admin
    (작성자 아님)=true."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            author_agent_id = await _seed_agent(s, org_id, project_id, name="작성자")
            other_agent_id = await _seed_agent(s, org_id, project_id, name="무관")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=author_agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        # ① 원저자 — can_withdraw=true
        _setup_org_scoped_app(app, Session, org_id, user_id=author_agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r.json()["can_withdraw"] is True

        # ② 무관 멤버(작성자도 admin도 아님) — can_withdraw=false
        _setup_org_scoped_app(app, Session, org_id, user_id=other_agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r.json()["can_withdraw"] is False

        # ③ org admin(작성자 아님) — can_withdraw=true
        async with Session() as s:
            admin_user_id = await _seed_human(s, org_id, role="admin")
        _setup_org_scoped_app(app, Session, org_id, user_id=admin_user_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r.json()["can_withdraw"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_excludes_withdrawn_by_default_includes_with_flag():
    """AC2 — 목록 기본 응답에서 폐기된 초안은 빠지고, include_withdrawn=true면 보인다.
    단건 조회는 항상 보인다(목록 필터와 별개)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")

            r_default = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            assert r_default.status_code == 200, r_default.text
            assert draft_id not in [row["draft_id"] for row in r_default.json()]

            r_included = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts", params={"include_withdrawn": "true"},
            )
            assert draft_id in [row["draft_id"] for row in r_included.json()]
            withdrawn_row = next(row for row in r_included.json() if row["draft_id"] == draft_id)
            assert withdrawn_row["draft_status"] == "withdrawn"

            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert r_detail.status_code == 200, r_detail.text
            assert r_detail.json()["draft_status"] == "withdrawn"
    finally:
        await engine.dispose()
