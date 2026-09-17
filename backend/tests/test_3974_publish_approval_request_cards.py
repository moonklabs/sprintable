"""story #3974(E-UX-OVERHAUL·「대화」 구현 4/N·BE) — 외부 발행(_EXTERNAL_PUBLISH_GATE_TYPE)
게이트 생성 시 doc/recipe/merge/agent_decision과 동일하게 `dispatch_approval_request_cards`를
호출한다(channel_posts.py/site_posts.py 둘 다 배선 0였던 갭 처방).

세팅 헬퍼는 채널=test_3414_publication_command_core.py, 사이트=test_e4fc29fa_site_post_
orchestration.py를 그대로 재사용(중복 재발명 0, 두 파일 모두 자기 docstring이 "세팅 헬퍼는
이 파일이 소유"라 명시)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from tests.test_3414_publication_command_core import (
    _seed_org, _seed_agent, _seed_default_role, _seed_connection, _seed_story,
    _session_factory, _setup_org_scoped_app, _client_for, _draft_body,
)
from tests.test_e4fc29fa_site_post_orchestration import (
    _create_and_submit_site_post_draft,
    _seed_wordpress_connection,
)

pytestmark = [pytest.mark.destructive_schema]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_approver(session, org_id, project_id, *, role="owner"):
    """OrgMember(role 판정용) + 같은 id의 TeamMember(대화 DM FK — test_2118_merge_gate_
    approval_cards_realdb.py::_seed_org_member와 동형 이유: approval_delivery.py의
    conversation_participants.member_id가 이 id 공간을 기대한다, create_all 기반
    테스트 한정 필요). test_3414/test_e4fc29fa의 _seed_human은 OrgMember만 만들어
    카드 배달이 team_members 신원 부재로 0건(전멸)이 되는 걸 실측으로 발견."""
    from app.models.project import OrgMember
    from app.models.team import TeamMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=user.id, role=role))
    session.add(TeamMember(
        id=member_id, org_id=org_id, project_id=project_id, type="human", name="approver", is_active=True,
    ))
    await session.commit()
    return user.id, member_id


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


async def _root_approval_messages(session, *, work_item_id):
    from app.models.conversation import ConversationMessage

    rows = (await session.execute(
        select(ConversationMessage).where(
            ConversationMessage.thread_id.is_(None),
            ConversationMessage.msg_metadata["approval_target"]["work_item_id"].astext == str(work_item_id),
        )
    )).scalars().all()
    return rows


@pytest.mark.anyio
async def test_channel_post_submit_creates_one_approval_request_card():
    """AC1/2 — 채널 초안 상신 → 결재자(project owner/admin, 상신자 제외)에게 카드 1건.
    approval_target에 gate_id·work_item_type이 실린다(dispatch_approval_request_cards
    기존 계약 그대로)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            requester_user_id = await _seed_agent(s, org_id, project_id)
            approver_user_id, approver_om_id = await _seed_approver(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            await _seed_default_role(s, org_id)

        app = _make_app()
        _setup_org_scoped_app(app, Session, org_id, user_id=requester_user_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            assert r.status_code == 201, r.text
            draft_id = r.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = r_submit.json()["gate_id"]

        async with Session() as s:
            rows = await _root_approval_messages(s, work_item_id=story_id)
            assert len(rows) == 1
            assert rows[0].msg_metadata["approval_target"]["gate_id"] == gate_id
            assert rows[0].msg_metadata["approval_target"]["work_item_type"] == "story"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_submit_creates_one_approval_request_card():
    """AC1/2 반대편 — 사이트 초안 상신도 동형으로 카드 1건."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            requester_user_id = await _seed_agent(s, org_id, project_id)
            await _seed_approver(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id, title="사이트 포스트")
            connection_id = await _seed_wordpress_connection(s, org_id, site_url="https://example.test")
            await _seed_default_role(s, org_id)

        app = _make_app()
        _setup_org_scoped_app(app, Session, org_id, user_id=requester_user_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            rows = await _root_approval_messages(s, work_item_id=story_id)
            assert len(rows) == 1
            assert rows[0].msg_metadata["approval_target"]["gate_id"] == str(gate_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_duplicate_submit_does_not_duplicate_root_card():
    """AC4 — 같은 초안·같은 버전을 다시 상신해도(내용 무변경) 카드가 중복되지 않는다.
    submit_channel_post_draft 자체의 기존 no-op 단락(existing is not None and not
    content_changed and ... : return existing)이 create_gate/dispatch 호출 자체에
    도달하지 않게 막아 이 신규 호출부가 애초에 두 번째로 안 실행된다 — 새 dedupe 로직을
    이 카드에서 새로 짜지 않는다는 확認."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            requester_user_id = await _seed_agent(s, org_id, project_id)
            await _seed_approver(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            await _seed_default_role(s, org_id)

        app = _make_app()
        _setup_org_scoped_app(app, Session, org_id, user_id=requester_user_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="본문 그대로"),
            )
            assert r.status_code == 201, r.text
            draft_id = r.json()["draft_id"]
            r_submit1 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit1.status_code == 200, r_submit1.text

            r_submit2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit2.status_code == 200, r_submit2.text

        async with Session() as s:
            rows = await _root_approval_messages(s, work_item_id=story_id)
            assert len(rows) == 1  # 두 번째 상신(무변경)이 카드를 또 안 만듦
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_dispatch_failure_does_not_block_channel_post_gate_creation():
    """best-effort — 카드 배달이 예외를 던져도 상신(게이트 생성) 자체는 성공한다
    (doc.py/merge_verdict_gate.py와 동일 관용구, 이 신규 호출부도 같은 방어를 물려받는지)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            requester_user_id = await _seed_agent(s, org_id, project_id)
            await _seed_approver(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            await _seed_default_role(s, org_id)

        import app.services.approval_delivery as approval_delivery_module
        original = approval_delivery_module.dispatch_approval_request_cards

        async def _boom(*args, **kwargs):
            raise RuntimeError("simulated delivery failure")

        approval_delivery_module.dispatch_approval_request_cards = _boom
        try:
            app = _make_app()
            _setup_org_scoped_app(app, Session, org_id, user_id=requester_user_id, agent=True)
            async with _client_for(app) as client:
                r = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json=_draft_body(work_item_id=story_id, connection_id=connection_id),
                )
                assert r.status_code == 201, r.text
                draft_id = r.json()["draft_id"]
                r_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
                )
                assert r_submit.status_code == 200, r_submit.text  # 배달 실패해도 상신 성공
                assert r_submit.json()["gate_id"]
        finally:
            approval_delivery_module.dispatch_approval_request_cards = original
    finally:
        await engine.dispose()


def _make_app():
    from app.main import app
    return app
