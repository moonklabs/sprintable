"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널 포스트 초안·버전·상신
봉인. site_posts.py(story #3365·#3367)의 초안/버전/상신/봉인 구조를 그대로 미러하되
페이로드는 채널 전용(text·link_url·channel/connection_id)이다.

AC 매핑(스토리 acceptance_criteria):
- AC1: 에이전트 키로 초안 생성·수정(버전 누적)·**상신**(request_publish)까지 전부 가능
  (2026-09-03 dev 실측 정정 — S2 실동작과 동일, human-only 아님). 승인·발행만 별도 축
  (승인은 gates.py 기존 human-only 가드, 발행은 이 스토리 범위 밖).
- AC2: text가 어댑터 선언 max_text_length(threads=500)를 넘으면 422 CHANNEL_TEXT_TOO_LONG
  (한도·현재 길이 응답 포함).
- AC3: 상신하면 external_publish 게이트가 pending으로 서고 그 시점 버전의 sha256이 봉인된다.
- AC4: 승인된 게이트의 초안을 수정하면 pending+reapproval_required=true로 되돌아가고(봉인은
  옛 버전 유지), gates.py의 기존 409 SITE_POST_RESUBMIT_REQUIRED 가드(코드 변경 없음)가
  옛 봉인 그대로의 승인을 막는다 — 빠져나가는 길은 재상신뿐.
- AC5: 봉인 판정 헬퍼가 gate_seal.py 공용(compute_seal_hash·GateSealMissingError·
  GateReapprovalRequiredError)이고, site_posts 기존 테스트 전량이 이 리팩터로 변경 없이
  GREEN(별도 커밋으로 이미 확認 — 이 파일은 채널 쪽 새 커버리지만 담는다). 공용 헬퍼
  자체가 깨지면 site·channel 양쪽에서 「승인 뒤 편집분」 봉인 갱신이 깨진다는 것을
  뮤테이션으로 pin한다(아래 뮤테이션 섹션).
- AC6: connection_id가 이 org의 channel_connections 행이 아니거나 status≠active면 초안
  생성/상신에서 409 CHANNEL_CONNECTION_NOT_ACTIVE(f8f7cb0f 발행 결정표와 HTTP status 통일).
- AC7: 마이그레이션 upgrade/downgrade/re-upgrade 왕복 — 별도로 CLI 검증 완료(PR 본문에 로그
  첨부), 이 파일은 담지 않는다(destructive_schema 테스트는 Base.metadata.create_all로
  스키마를 세운다 — alembic 자체를 구동하지 않는 관례, test_3365 등과 동형).

뮤테이션 1건(스토리 본문 「QA」란 명시) — gate_seal.compute_seal_hash가 payload 내용과
무관한 상수를 반환하도록 바꾸면(공용 헬퍼가 깨진 것과 동형 증상): 승인 뒤 편집한 새 버전이
옛 버전과 "같은 해시"로 보여 재상신이 재봉인을 건너뛴다 —
test_resubmit_after_approved_edit_reseals_to_new_version이 반드시 실패해야 한다. 세션
중 실행·RED 확인·원복 완료(커밋엔 포함 안 함)."""
from __future__ import annotations

import os
import uuid

import pytest

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Channel Post Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="담롱"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_human(session, org_id, *, role="member"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_story(session, org_id, project_id, *, title="채널 포스트"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_connection(session, org_id, *, channel="threads", status="active", account_id=None):
    from app.models.channel_connection import ChannelConnection

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _approve_gate_directly(session, gate_id):
    """gates.py 승인 UI 왕복 없이 승인 상태만 만든다 — 이 파일의 관심사는 channel_posts.py
    쪽 봉인 상태지 gates.py의 승인 authz가 아니다(test_3365_external_publish_gate_human_only.py
    관할, 신규 코드 없음이라 재검증 불요)."""
    from datetime import datetime, timezone
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _draft_body(*, work_item_id, connection_id, text="채널 포스트 본문입니다.", link_url=None):
    body = {"work_item_id": str(work_item_id), "connection_id": str(connection_id), "text": text}
    if link_url is not None:
        body["link_url"] = link_url
    return body


@pytest.mark.anyio
async def test_agent_creates_draft_and_submits_end_to_end():
    """AC1 — 에이전트 키로 초안 생성 + 상신까지 전부 200/201(2026-09-03 dev 실측 정정:
    submit도 에이전트에 열려 있다). channel은 응답 어디에도 요청 body로 안 들어갔지만
    connection에서 derive된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            assert r_draft.status_code == 201, r_draft.text
            payload = r_draft.json()
            assert payload["version"] == 1
            assert payload["author_kind"] == "agent"
            draft_id = payload["draft_id"]

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            assert r_list.status_code == 200, r_list.text
            item = next(i for i in r_list.json() if i["draft_id"] == draft_id)
            assert item["channel"] == "threads"

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.status_code == 200, r_submit.text
        submit_payload = r_submit.json()
        assert submit_payload["status"] == "pending"
        assert submit_payload["content_sha256"] == payload["body_sha256"]

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select

            gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(submit_payload["gate_id"])))).scalar_one()
        assert gate.gate_type == "external_publish"
        assert gate.sealed_content_sha256 == payload["body_sha256"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_text_too_long_returns_422_with_limit_and_current_length():
    """AC2 — Threads max_text_length=500 초과 시 422 CHANNEL_TEXT_TOO_LONG(한도·현재
    길이 포함)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="가" * 501),
            )
        assert r.status_code == 422, r.text
        body = r.json()["error"]
        assert body["code"] == "CHANNEL_TEXT_TOO_LONG"
        assert body["max_length"] == 500
        assert body["current_length"] == 501
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_not_found_returns_409_channel_connection_not_active():
    """AC6 — 존재하지 않는 connection_id."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=uuid.uuid4()),
            )
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "CHANNEL_CONNECTION_NOT_ACTIVE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_revoked_between_draft_and_submit_returns_409_at_submit():
    """AC6 — 생성 시점엔 active였지만 상신 시점에 revoke된 connection은 상신에서 재검증돼
    막힌다(생성 시점 검증만으로는 안 된다는 것을 직접 pin)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            draft_id = r_draft.json()["draft_id"]

        async with Session() as s:
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import select

            conn = (await s.execute(
                select(ChannelConnection).where(ChannelConnection.id == connection_id)
            )).scalar_one()
            conn.status = "revoked"
            await s.commit()

        async with _client_for(app) as client:
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.status_code == 409, r_submit.text
        assert r_submit.json()["error"]["code"] == "CHANNEL_CONNECTION_NOT_ACTIVE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approve_after_edit_is_blocked_until_resubmit_seals_new_version():
    """AC3·AC4 — site_posts.py::test_approve_after_edit_is_blocked_until_resubmit_seals_
    new_version과 동형. gates.py의 409 SITE_POST_RESUBMIT_REQUIRED 가드(gate_type==
    "external_publish"로만 스코프, site 특정 로직 0)가 코드 변경 없이 channel_posts의
    external_publish 게이트에도 그대로 적용됨을 직접 확認한다."""
    from app.main import app
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    from app.services.member_resolver import ResolvedMember

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            draft_id = r_draft.json()["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        gate_id = uuid.UUID(r_submit.json()["gate_id"])
        sealed_before = r_submit.json()["content_sha256"]

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        # 승인 뒤 편집 — pending 재오픈, 봉인은 옛 버전 그대로(AC4).
        async with _client_for(app) as client:
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(
                    work_item_id=story_id, connection_id=connection_id, text="채널 포스트 본문(승인 후 수정).",
                ),
            )
        assert r_edit.status_code == 201, r_edit.text
        new_sha256 = r_edit.json()["body_sha256"]

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select

            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        assert gate.status == "pending"
        assert gate.reapproval_required is True
        assert gate.sealed_content_sha256 == sealed_before, "봉인이 편집 훅에서 조용히 갱신됐다(승인 기록 훼손)"

        # 막다른 길 — 옛 봉인 그대로 승인 시도 → 409(신규 코드 0, 기존 gates.py 가드).
        from fastapi import BackgroundTasks, HTTPException
        from unittest.mock import AsyncMock, patch
        import app.routers.gates as gates_mod

        approver = ResolvedMember(
            id=uuid.uuid4(), user_id=uuid.uuid4(), name="approver", type="human", role="owner", org_id=org_id,
        )

        class _FakeAuth:
            user_id = str(approver.user_id)
            claims: dict = {"app_metadata": {"org_id": str(org_id)}}

        async with Session() as s:
            with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=approver)), \
                 patch.object(gates_mod, "_non_doc_gate_approvable", AsyncMock(return_value=True)):
                with pytest.raises(HTTPException) as exc_info:
                    await transition_gate_endpoint(
                        id=gate_id, body=GateTransitionRequest(status="approved"),
                        background_tasks=BackgroundTasks(), session=s, org_id=org_id, auth=_FakeAuth(),
                    )
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["code"] == "SITE_POST_RESUBMIT_REQUIRED"

        # 빠져나가는 길 — 재상신: 새 버전으로 재봉인 + 플래그 해제(별도 테스트가 이 부분을
        # 더 상세히 pin한다 — test_resubmit_after_approved_edit_reseals_to_new_version).
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_resubmit.status_code == 200, r_resubmit.text
        assert r_resubmit.json()["content_sha256"] == new_sha256
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_double_edit_without_resubmit_between_still_requires_and_allows_resubmit():
    """story #3496(site_posts.py::test_double_edit_without_resubmit_between_...와
    동형, 페드루 실측 2026-09-05) — 승인 뒤 편집(v2)까지는 위 테스트와 같지만,
    **submit() 없이 또 편집(v3)**하면 재봉인 훅이 sealed_*를 v3로 동기화하면서도
    reapproval_required는 True로 남긴다. submit()의 조기 return 조건이
    reapproval_required를 안 보면, sealed sha·schedule·media가 이미 v3와 일치해
    "이미 봉인돼 있다"로 조용히 넘어가 승인이 영구히 409 SITE_POST_RESUBMIT_REQUIRED
    로 막힌다."""
    from app.main import app
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    from app.services.member_resolver import ResolvedMember

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        # v2 — 승인 뒤 편집.
        async with _client_for(app) as client:
            r_edit_v2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="채널 포스트 v2."),
            )
        assert r_edit_v2.status_code == 201, r_edit_v2.text

        # v3 — submit() 없이 또 편집.
        async with _client_for(app) as client:
            r_edit_v3 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="채널 포스트 v3(submit 안 거침)."),
            )
        assert r_edit_v3.status_code == 201, r_edit_v3.text
        v3_sha256 = r_edit_v3.json()["body_sha256"]

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        assert gate.status == "pending"
        assert gate.sealed_content_sha256 == v3_sha256, "pending 재봉인 훅이 v3로 동기화되지 않았다(그라운딩 전제 확인)"
        assert gate.reapproval_required is True, "reapproval_required가 편집 훅에서 조용히 풀렸다(그라운딩 전제 확인)"

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_resubmit.status_code == 200, r_resubmit.text

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        assert gate.reapproval_required is False, (
            "submit() 재호출이 이미-봉인 조기 return을 타 reapproval_required가 안 풀렸다"
            " — 승인이 영구히 409로 막히는 사고"
        )

        approver = ResolvedMember(
            id=uuid.uuid4(), user_id=uuid.uuid4(), name="approver", type="human", role="owner", org_id=org_id,
        )

        class _FakeAuth:
            user_id = str(approver.user_id)
            claims: dict = {"app_metadata": {"org_id": str(org_id)}}

        from fastapi import BackgroundTasks
        from unittest.mock import AsyncMock, patch
        import app.routers.gates as gates_mod

        async with Session() as s:
            with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=approver)), \
                 patch.object(gates_mod, "_non_doc_gate_approvable", AsyncMock(return_value=True)):
                approved = await transition_gate_endpoint(
                    id=gate_id, body=GateTransitionRequest(status="approved", note="재검토 완료", evidence_viewed=True),
                    background_tasks=BackgroundTasks(), session=s, org_id=org_id, auth=_FakeAuth(),
                )
        assert approved.status == "approved", "재봉인이 정상 처리됐는데도 승인이 막혔다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_after_approved_edit_reseals_to_new_version():
    """AC5 QA 뮤테이션 대상 — gate_seal.compute_seal_hash가 payload 내용과 무관한 상수를
    내면(공용 헬퍼가 깨진 것과 동형), 편집 전/후 버전이 "같은 해시"로 보여 이 재상신이
    재봉인을 건너뛴다(멱등 분기가 잘못 탄다) — sealed_content_version이 갱신 안 됨."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        async with _client_for(app) as client:
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(
                    work_item_id=story_id, connection_id=connection_id, text="다른 내용으로 완전히 바꿈.",
                ),
            )
            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_resubmit.status_code == 200, r_resubmit.text

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select

            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        assert gate.sealed_content_version == 2, "재상신이 새 버전으로 재봉인하지 않았다(멱등 분기 오판)"
        assert gate.sealed_content_sha256 == r_edit.json()["body_sha256"]
        assert gate.reapproval_required is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_drafts_origin_author_kind_distinguishes_agent_origin_human_latest():
    """AC1 후속 — origin_author_kind(버전1)와 latest_author_kind(최신)가 갈릴 수 있다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
        draft_id = r1.json()["draft_id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="휴먼 개정본."),
            )
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        item = next(i for i in r_list.json() if i["draft_id"] == draft_id)
        assert item["origin_author_kind"] == "agent"
        assert item["latest_author_kind"] == "human"
        assert item["current_version"] == 2
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_without_default_role_returns_409_approver_role_missing():
    """org에 기본 결재 역할이 없으면 명시 거부(조용한 uuid4 폴백 금지) — site_posts.py와
    동형 규율, 채널 전용 코드(CHANNEL_POST_APPROVER_ROLE_MISSING — 공유 대상 2코드 밖)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            # 의도적으로 _seed_default_role 생략.

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{r_draft.json()['draft_id']}/submit",
                json={},
            )
        assert r_submit.status_code == 409, r_submit.text
        assert r_submit.json()["error"]["code"] == "CHANNEL_POST_APPROVER_ROLE_MISSING"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_draft_id_returns_404_on_versions_and_submit():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        unknown_id = uuid.uuid4()
        async with _client_for(app) as client:
            r_versions = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{unknown_id}/versions",
            )
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{unknown_id}/submit", json={},
            )
        assert r_versions.status_code == 404
        assert r_submit.status_code == 404
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
