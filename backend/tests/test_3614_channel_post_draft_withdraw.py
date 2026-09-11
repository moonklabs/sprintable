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
from app.services.publication_command import process_due_publication_commands

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
async def test_withdraw_already_withdrawn_by_non_author_non_admin_still_403():
    """story #3614 CHANGES(카디르 QA 적발, 페드루 PO 채택 2026-09-07) — 인가가 멱등
    조기반환보다 앞에 있어야 한다. 작성자가 먼저 폐기(200)한 뒤, 작성자도 admin도
    아닌 다른 멤버가 같은 초안에 다시 호출하면 멱등 성공(200)이 아니라 403이어야
    한다 — 순서가 뒤바뀌면(조회→멱등 반환→인가) 이미 withdrawn인 초안은 누가
    호출해도 인가 체크에 닿기 전에 200이 새 나갔다.
    ⭐뮤테이션 표적 — 인가 체크를 멱등 반환 «뒤»로 되돌리면 이 테스트가 RED여야
    한다."""
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
            r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
            assert r1.status_code == 200, r1.text

        _setup_org_scoped_app(app, Session, org_id, user_id=other_agent_id, agent=True)
        async with _client_for(app) as client:
            r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r2.status_code == 403, r2.text
        assert r2.json()["error"]["code"] == "CHANNEL_POST_WITHDRAW_FORBIDDEN"
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


@pytest.mark.anyio
async def test_withdraw_cancels_pending_retry_command():
    """story #3639(3614 후속) — dev 실측 재현: 승인된 초안을 발행 시도했다가 503으로
    command_status=pending·next_attempt_at이 미래로 잡힌 채 withdraw하면(게이트는 이미
    approved라 "gate.status == pending" 분기는 안 닿는다), command가 cancelled로
    종결돼 워커 due 조회(process_due_publication_commands)에서 더는 안 집힌다. 마커
    표본이 아니라 진짜 일시 실패였다면 다음 재시도가 성공해 "작성자가 폐기한 초안이
    외부에 발행"되는 반쪽을 막는다."""
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from app.models.publication_command import PublicationCommand
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        from tests.test_3414_publication_command_core import _approve_gate_directly

        command_id = uuid.uuid4()
        async with Session() as s:
            await _approve_gate_directly(s, gate_id)
            v = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalars().first()
            # dev 실측 그대로 — 503(provider-error 마커) 뒤 워커가 남긴 pending·재시도
            # 대기 command를 직접 심는다(이 테스트의 관심사는 withdraw의 취소 가드지
            # 발행 파이프라인 자체가 아니다).
            command = PublicationCommand(
                id=command_id, org_id=org_id, gate_id=gate_id, destination=connection_id,
                approved_version=v.id, operation="publish", content_kind="channel_post",
                status="pending", attempt_count=1,
                next_attempt_at=datetime.now(timezone.utc) - timedelta(seconds=1),  # 이미 도래(due)
                requested_by_member_id=human_id,
            )
            s.add(command)
            await s.commit()

        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r.status_code == 200, r.text

        async with Session() as s:
            refreshed = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == command_id)
            )).scalar_one()
            assert refreshed.status == "cancelled"
            assert refreshed.reason_code == "CANCELLED_BY_HUMAN"

        # AC1 — 워커 due 조회에서 실제로 빠지는지 직접 증명(단언만이 아니라 실제 워커
        # 진입점을 태워 0건 처리됨을 확認).
        async with Session() as s:
            result = await process_due_publication_commands(s)
            assert sum(result.values()) == 0, f"취소된 command가 워커에 집혔다: {result}"
            refreshed = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == command_id)
            )).scalar_one()
            assert refreshed.status == "cancelled", "워커가 취소된 command를 다시 집으면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_withdraw_cancel_mutation_removing_guard_leaves_command_due():
    """뮤테이션 대조 — cancel 로직을 제거하면(withdraw_channel_post_draft에서 command
    상태를 안 건드리면) 위 테스트가 RED로 돌아가는지는 소스 코드 리뷰로 확認(로컬에서
    수동 확認 후 복구) — 여기서는 그 반대(정상 동작에서 command가 실제로 due 조회에
    안 걸림)를 별도 직접 쿼리로 한 번 더 고정한다(process_due_publication_commands
    내부의 SKIP LOCKED 배치 크기·격리와 무관하게, 순수 WHERE 조건만으로도 재검증)."""
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from app.models.publication_command import PublicationCommand
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        from tests.test_3414_publication_command_core import _approve_gate_directly

        command_id = uuid.uuid4()
        async with Session() as s:
            await _approve_gate_directly(s, gate_id)
            v = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalars().first()
            command = PublicationCommand(
                id=command_id, org_id=org_id, gate_id=gate_id, destination=connection_id,
                approved_version=v.id, operation="publish", content_kind="channel_post",
                status="pending", attempt_count=1,
                next_attempt_at=datetime.now(timezone.utc) - timedelta(seconds=1),
                requested_by_member_id=human_id,
            )
            s.add(command)
            await s.commit()

        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
        assert r.status_code == 200, r.text

        async with Session() as s:
            due = (await s.execute(
                select(PublicationCommand).where(
                    PublicationCommand.id == command_id,
                    PublicationCommand.status == "pending",
                )
            )).scalar_one_or_none()
            assert due is None, "취소됐다면 status='pending' 조건에 더는 안 걸려야 한다(due 배제 SSOT)"
    finally:
        await engine.dispose()


# story #3614 갭(PO 라이브 실측·確定, 2026-09-11 03:50Z) — 「폐기 종결」이 재POST+submit
# 으로 뚫리는 결함. 재현: withdrawn 초안에 같은 (work_item·connection)으로 재POST →
# 그 초안의 v2가 얹힘(매칭이 withdrawn을 안 뺐다) → submit → 200 pending·옛 게이트
# 재개방(좀비 게이트: 화면엔 안 보이는데 승인 가능한 게이트가 떠 있다).


@pytest.mark.anyio
async def test_repost_after_withdraw_creates_new_draft_not_new_version_on_withdrawn():
    """갭 처방②(PO 確定) — withdrawn 초안과 같은 (work_item·connection)으로 재POST하면
    그 초안에 v2를 얹는 대신 새 초안이 생긴다. 옛 초안은 종결 상태·버전 수 그대로 무변.

    ⭐뮤테이션 표적 — create_channel_post_draft_version의 매칭 쿼리에서
    `ChannelPostDraft.status != "withdrawn"` 조건을 걷으면 아래 draft_id 불일치·
    version count 단언이 RED가 된다(재POST가 옛 withdrawn 초안에 v2를 얹는 원래
    결함으로 되돌아간다)."""
    from app.main import app
    from app.services.channel_posts import get_channel_post_draft, list_channel_post_draft_versions

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            old_draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_withdraw = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{old_draft_id}/withdraw")
            assert r_withdraw.status_code == 200, r_withdraw.text

            new_draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

        assert new_draft_id != old_draft_id, "재POST가 새 초안 대신 폐기된 초안에 버전을 얹었다"

        async with Session() as s:
            old_versions = await list_channel_post_draft_versions(s, draft_id=uuid.UUID(old_draft_id))
            assert len(old_versions) == 1, "폐기된 초안에 새 버전이 얹히면 안 된다(종결 무변)"
            new_versions = await list_channel_post_draft_versions(s, draft_id=uuid.UUID(new_draft_id))
            assert len(new_versions) == 1

            old_draft = await get_channel_post_draft(s, org_id=org_id, draft_id=uuid.UUID(old_draft_id))
            assert old_draft.status == "withdrawn"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_withdrawn_draft_returns_409_and_does_not_reopen_gate():
    """갭 처방①③(PO 確定) — withdrawn 초안을 submit하면 409 CHANNEL_POST_DRAFT_WITHDRAWN,
    이미 rejected였던 게이트는 재개방되지 않는다(라이브 실측 좀비 게이트 재현·처방).

    ⭐뮤테이션 표적 — submit_channel_post_draft 진입부의 `draft.status == "withdrawn"`
    검사를 걷으면 이 테스트가 RED(409 대신 200·게이트가 다시 pending으로 열림)가
    된다."""
    from app.main import app
    from app.models.gate import Gate
    from app.services.gate_service import transition_gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            assert r_submit1.status_code == 200, r_submit1.text
            gate_id = uuid.UUID(r_submit1.json()["gate_id"])

        async with Session() as s:
            # AC4 라이브 실측과 동형 표본 — 폐기 前에 이미 owner가 반려(rejected)한
            # 게이트(withdraw_channel_post_draft는 status=="pending"만 되돌리므로
            # rejected는 그 분기를 안 탄다 — draft만 withdrawn으로 닫힌다).
            await transition_gate(s, org_id, gate_id, "rejected", human_id, "테스트 반려")

        async with _client_for(app) as client:
            r_withdraw = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw")
            assert r_withdraw.status_code == 200, r_withdraw.text

            r_submit2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
        assert r_submit2.status_code == 409, r_submit2.text
        assert r_submit2.json()["error"]["code"] == "CHANNEL_POST_DRAFT_WITHDRAWN"

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "rejected", "폐기된 초안 submit이 rejected 게이트를 재개방하면 안 된다(좀비 게이트 재발 방지)"
    finally:
        await engine.dispose()


# story #3614 갭 처방②(PO 確定 2026-09-11, migration 0360) — (org_id, work_item_id,
# connection_id) 유니크가 전체 제약에서 partial unique index(`status <> 'withdrawn'`)로
# 바뀌었다: withdrawn 행은 몇 개든 같은 자리에 공존하고, 활성(non-withdrawn) 행은
# 여전히 최대 1개만 허용된다.


@pytest.mark.anyio
async def test_db_allows_withdrawn_plus_one_active_same_triple():
    """partial unique index 양성대조 — withdrawn 1개 + 활성 1개는 같은
    (org·work_item·connection)에 공존 가능(재POST가 새 초안을 실제로 커밋할 수
    있다는 것의 DB 레벨 증명, 앱 경로와 별개로 직접 재확認)."""
    from app.models.channel_post_draft import ChannelPostDraft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

            withdrawn = ChannelPostDraft(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id,
                channel="threads", connection_id=connection_id, status="withdrawn",
            )
            active = ChannelPostDraft(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id,
                channel="threads", connection_id=connection_id, status="draft",
            )
            s.add_all([withdrawn, active])
            await s.commit()  # 여기서 IntegrityError가 나면 이 테스트 자체가 실패
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_db_rejects_two_active_drafts_same_triple():
    """⭐뮤테이션 표적(반대 방향) — 활성(non-withdrawn) 행 2개는 partial unique index가
    그대로 막는다. 처방②가 "제약을 없앤 것"이 아니라 "withdrawn만 뺀 것"임을 DB
    레벨에서 고정 — 이 단언이 없으면 인덱스를 아예 안 걸어도(또는 조건을 반대로
    걸어도) 위 공존 테스트만으론 못 잡는다."""
    from app.models.channel_post_draft import ChannelPostDraft
    from sqlalchemy.exc import IntegrityError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

            s.add(ChannelPostDraft(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id,
                channel="threads", connection_id=connection_id, status="draft",
            ))
            await s.commit()

            s.add(ChannelPostDraft(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id,
                channel="threads", connection_id=connection_id, status="draft",
            ))
            with pytest.raises(IntegrityError):
                await s.commit()
            await s.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_after_withdraw_seals_new_drafts_version_not_old():
    """처방②③ 조합 확認(PO 조건③) — withdraw → 재POST(새 초안) → 그 새 초안을
    submit하면, 같은 work_item 게이트 슬롯(find_gate_slot_with_pr_fallback, 3388
    기존 경로 무변)이 재사용되되 **새 초안의 버전**을 봉인한다.

    ⭐뮤테이션 표적 — submit_channel_post_draft가 (실수로) 옛 withdrawn 초안의
    버전이나 본문을 봉인하면 아래 sealed_content_body 단언이 RED다."""
    from app.main import app
    from app.models.gate import Gate
    from app.services.gate_service import transition_gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            old_draft_id = await _create_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id, text="옛 초안 본문",
            )
            r_submit1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{old_draft_id}/submit", json={})
            assert r_submit1.status_code == 200, r_submit1.text
            gate_id = uuid.UUID(r_submit1.json()["gate_id"])

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "rejected", human_id, "테스트 반려")

        async with _client_for(app) as client:
            r_withdraw = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{old_draft_id}/withdraw")
            assert r_withdraw.status_code == 200, r_withdraw.text

            new_draft_id = await _create_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id, text="새 초안 본문",
            )
            assert new_draft_id != old_draft_id

            r_submit2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{new_draft_id}/submit", json={})
            assert r_submit2.status_code == 200, r_submit2.text
            reopened_gate_id = uuid.UUID(r_submit2.json()["gate_id"])

        # 같은 work_item(scope_key=connection_id) 슬롯이라 게이트 id 자체는 재사용된다
        # (기존 3388 경로 — PO 조건③ 그대로 무변, 새 게이트를 만드는 게 갭 처방이
        # 아니다).
        assert reopened_gate_id == gate_id

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "pending"
            assert gate.sealed_content_body == "새 초안 본문", "재개방된 게이트가 옛 withdrawn 초안의 본문을 봉인하면 안 된다"
    finally:
        await engine.dispose()
