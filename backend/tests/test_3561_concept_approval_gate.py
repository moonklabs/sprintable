"""story #3561(Phase2·BE, 페드루 PO 確定 2026-09-06) — 3560 BE 조각. gate_type
`concept_approval` 신설(허용목록·항상-수동·휴먼 approver) — doc을 근거자료로 다른
work_item(Story/Task)을 승인한다(doc_approval과 별개 축, doc.status는 안 바뀐다).

確定 매핑:
① `POST /docs/{id}/concept-approval`(app/services/doc.py::submit_concept_approval) —
   doc.project_id != work_item project_id면 422(그라운딩 근거: doc이 그 work item을
   "참조"한다는 것의 구체적 정의 = project-scope 일치).
② doc 본문 편집 훅(app/services/doc.py::_reseal_concept_approval_gate_on_doc_update) —
   channel_posts.py::_reseal_gate_on_new_version과 동형: pending 편집=즉시 재봉인,
   approved 편집=pending+reapproval_required=True(옛 봉인 보존).
③ channel_posts.py::submit_channel_post_draft·site_posts.py::submit_site_post_draft —
   work_item에 concept_approval 게이트가 있고 미승인이면 422 CONCEPT_NOT_APPROVED
   (gate_service.py::find_unapproved_gate_of_type 공용, opt-in — 게이트 없으면 무변경).
④ hitl_config.py GATE_TYPES + gate_service.py _ALWAYS_MANUAL_GATE_TYPES 등재.
⑤ evidence.py — type=report·payload.kind=verification_sheet: items 1건 이상 배열
   (name·verdict∈{pass,fail,n_a}), verified_by 서버 강제(caller_type+id), verified_at
   서버 시각.

뮤테이션 3건(story 확定 그대로) — 세션 中 실행·RED 확인·원복, 커밋엔 미포함:
① 거부 분기 제거(channel_posts.py concept_gate 체크 블록) → 미승인 게이트가 있어도
   submit이 200을 내야 test_channel_post_submit_blocked_when_concept_gate_unapproved가
   RED.
② verified_by 강제 제거(evidence.py `payload["verified_by"] = ...` 대입) → 클라이언트
   위조값이 그대로 남아야
   test_evidence_verification_sheet_server_forces_verified_by_ignoring_client가 RED.
③ 재승인 판정 제거(doc.py `_reseal_concept_approval_gate_on_doc_update`의 approved→
   pending 분기) → 승인 뒤 doc 편집이 게이트를 안 건드려야
   test_doc_edit_after_approval_flips_pending_reapproval_required가 RED."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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

    org = Organization(id=uuid.uuid4(), name="3561 Concept Approval Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_project(session, org_id, *, name="B"):
    from app.models.project import Project

    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project.id


async def _seed_human(session, org_id, *, role="owner"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_agent(session, org_id, project_id, *, name="담롱"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="컨셉 승인 대상 스토리"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_doc(session, org_id, project_id, *, content="컨셉 초안 본문입니다.", title="컨셉 문서"):
    from app.models.doc import Doc

    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}", content=content,
    )
    session.add(doc)
    await session.commit()
    return doc.id


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_connection(session, org_id, *, channel="threads", status="active", token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token) if status == "active" else None,
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _approve_gate_directly(session, gate_id):
    from sqlalchemy import select
    from app.models.gate import Gate

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


async def _get_gate(session, gate_id):
    from sqlalchemy import select
    from app.models.gate import Gate

    return (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
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
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _submit_concept_approval(client, org_id, doc_id, *, work_item_id, work_item_type="story"):
    # app/routers/docs.py 라우터 prefix는 "/api/v2/docs"(org-scoped path segment 없음 —
    # org_id는 get_verified_org_id가 JWT claims/X-Org-Id 헤더에서 해소, /transition과 동형).
    return await client.post(
        f"/api/v2/docs/{doc_id}/concept-approval",
        json={"work_item_id": str(work_item_id), "work_item_type": work_item_type},
    )


# ─── ① submit_concept_approval — 상신 ────────────────────────────────────────


@pytest.mark.anyio
async def test_submit_concept_approval_creates_pending_gate_sealed():
    from app.main import app
    from app.services.doc import compute_doc_body_sha256

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, content="본문 v1")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["status"] == "pending"
        assert body["work_item_id"] == str(story_id)
        assert body["doc_id"] == str(doc_id)
        assert body["sealed_doc_body_sha256"] == compute_doc_body_sha256("본문 v1")

        async with Session() as s:
            gate = await _get_gate(s, uuid.UUID(body["gate_id"]))
        assert gate.gate_type == "concept_approval"
        assert gate.work_item_type == "story"
        assert gate.sealed_doc_id == doc_id
        assert gate.sealed_doc_body_sha256 == compute_doc_body_sha256("본문 v1")
        assert gate.requires_human is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_concept_approval_doc_scope_mismatch_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            project_b = await _seed_project(s, org_id, name="B")
            story_in_b = await _seed_story(s, org_id, project_b)
            doc_in_a = await _seed_doc(s, org_id, project_a)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _submit_concept_approval(client, org_id, doc_in_a, work_item_id=story_in_b)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CONCEPT_APPROVAL_DOC_SCOPE_MISMATCH"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_concept_approval_doc_not_found_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _submit_concept_approval(client, org_id, uuid.uuid4(), work_item_id=story_id)
        assert r.status_code == 404, r.text
    finally:
        await engine.dispose()


# ─── ② doc 편집 훅 — 재봉인/재승인 ────────────────────────────────────────────


@pytest.mark.anyio
async def test_doc_edit_while_pending_reseals_gate_immediately():
    from app.main import app
    from app.services.doc import compute_doc_body_sha256

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, content="본문 v1")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
            assert r.status_code == 201, r.text
            gate_id = uuid.UUID(r.json()["gate_id"])

            r_patch = await client.patch(f"/api/v2/docs/{doc_id}", json={"content": "본문 v2(수정)"})
        assert r_patch.status_code == 200, r_patch.text

        async with Session() as s:
            gate = await _get_gate(s, gate_id)
        assert gate.status == "pending"
        assert gate.sealed_doc_body_sha256 == compute_doc_body_sha256("본문 v2(수정)")
        assert gate.reapproval_required is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_doc_edit_after_approval_flips_pending_reapproval_required():
    """뮤테이션 대상③ — doc.py::_reseal_concept_approval_gate_on_doc_update의
    approved→pending 분기가 제거되면 이 테스트가 RED여야 한다(옛 봉인 보존 확認도 겸함)."""
    from app.main import app
    from app.services.doc import compute_doc_body_sha256

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, content="본문 v1")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
            assert r.status_code == 201, r.text
            gate_id = uuid.UUID(r.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        async with _client_for(app) as client:
            r_patch = await client.patch(f"/api/v2/docs/{doc_id}", json={"content": "본문 v2(승인 뒤 수정)"})
        assert r_patch.status_code == 200, r_patch.text

        async with Session() as s:
            gate = await _get_gate(s, gate_id)
        assert gate.status == "pending"
        assert gate.reapproval_required is True
        # 옛 봉인 보존 — 새 본문 해시로 갱신되지 않는다.
        assert gate.sealed_doc_body_sha256 == compute_doc_body_sha256("본문 v1")
        assert gate.resolver_id is None
        assert gate.resolved_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_doc_edit_unrelated_doc_does_not_touch_other_gate():
    """회귀 0 — concept_approval 게이트가 없는(또는 다른 doc을 근거로 삼은) doc 편집은
    아무 게이트도 안 건드린다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            doc_id = await _seed_doc(s, org_id, project_id, content="무관 문서")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_patch = await client.patch(f"/api/v2/docs/{doc_id}", json={"content": "무관 문서 수정"})
        assert r_patch.status_code == 200, r_patch.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_doc_edit_reseals_all_gates_when_doc_backs_multiple_work_items():
    """페드루 PO 리뷰(PR#3922, 2026-09-06) — 컨셉 doc 1건이 여러 work_item(Story N)에
    근거자료로 걸리는 것은 정상 경로(같은 컨셉 문서로 여러 스토리를 동시에 상신 가능).
    _reseal_concept_approval_gate_on_doc_update가 scalar_one_or_none()이면 이 상태에서
    doc 편집이 MultipleResultsFound로 500이 나야 이 테스트가 잡는다 — 전부 순회해
    각자 독립 판정해야 한다(하나는 pending 재봉인, 다른 하나는 approved→pending
    재승인, 동시에)."""
    from app.main import app
    from app.services.doc import compute_doc_body_sha256

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_pending = await _seed_story(s, org_id, project_id, title="스토리 A(pending 유지)")
            story_approved = await _seed_story(s, org_id, project_id, title="스토리 B(approved→pending)")
            doc_id = await _seed_doc(s, org_id, project_id, content="본문 v1")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r1 = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_pending)
            assert r1.status_code == 201, r1.text
            gate_pending_id = uuid.UUID(r1.json()["gate_id"])

            r2 = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_approved)
            assert r2.status_code == 201, r2.text
            gate_approved_id = uuid.UUID(r2.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_approved_id)

        async with _client_for(app) as client:
            r_patch = await client.patch(f"/api/v2/docs/{doc_id}", json={"content": "본문 v2(동시 편집)"})
        assert r_patch.status_code == 200, r_patch.text

        async with Session() as s:
            gate_pending = await _get_gate(s, gate_pending_id)
            gate_approved = await _get_gate(s, gate_approved_id)
        assert gate_pending.status == "pending"
        assert gate_pending.sealed_doc_body_sha256 == compute_doc_body_sha256("본문 v2(동시 편집)")
        assert gate_approved.status == "pending"
        assert gate_approved.reapproval_required is True
        assert gate_approved.sealed_doc_body_sha256 == compute_doc_body_sha256("본문 v1")
    finally:
        await engine.dispose()


# ─── ③ 제출 시점 opt-in 서버 거부 — channel_posts/site_posts ─────────────────


@pytest.mark.anyio
async def test_channel_post_submit_blocked_when_concept_gate_unapproved():
    """뮤테이션 대상① — channel_posts.py의 concept_gate 체크 블록이 제거되면 이
    테스트가 RED여야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit_concept = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
            assert r_submit_concept.status_code == 201, r_submit_concept.text
            gate_id = r_submit_concept.json()["gate_id"]

            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "발행 본문"},
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_publish_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_publish_submit.status_code == 422, r_publish_submit.text
        detail = r_publish_submit.json()["error"]
        assert detail["code"] == "CONCEPT_NOT_APPROVED"
        assert detail["gate_id"] == gate_id
        assert detail["status"] == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_submit_allowed_once_concept_gate_approved():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit_concept = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
            assert r_submit_concept.status_code == 201, r_submit_concept.text
            concept_gate_id = uuid.UUID(r_submit_concept.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, concept_gate_id)

        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "발행 본문"},
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_publish_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_publish_submit.status_code == 200, r_publish_submit.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_submit_unaffected_when_no_concept_gate():
    """회귀 0 — concept_approval 게이트 자체가 없는 work_item은 이 축 검사 대상이
    아니다(opt-in, 현행 그대로 통과)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "발행 본문"},
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_publish_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_publish_submit.status_code == 200, r_publish_submit.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_submit_blocked_when_concept_gate_unapproved():
    """site_posts.py도 동형(story 確定③ "463 옆") — channel_post 테스트와 대칭 1건으로
    파리티 증명."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit_concept = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
            assert r_submit_concept.status_code == 201, r_submit_concept.text

            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "slug": "concept-test", "lang": "ko",
                    "title": "제목", "summary": "요약", "tags": [], "body_md": "본문",
                    "media_manifest": [],
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.status_code == 422, r_submit.text
        assert r_submit.json()["error"]["code"] == "CONCEPT_NOT_APPROVED"
    finally:
        await engine.dispose()


# ─── ④ 휴먼 전용 승인(기존 범용 가드 재확認, 신규 코드 아님) ─────────────────


@pytest.mark.anyio
async def test_agent_cannot_approve_concept_approval_gate():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _submit_concept_approval(client, org_id, doc_id, work_item_id=story_id)
            assert r.status_code == 201, r.text
            gate_id = r.json()["gate_id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_transition = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "approved"},
            )
        assert r_transition.status_code == 403, r_transition.text
    finally:
        await engine.dispose()


# ─── ⑤ evidence verification_sheet ───────────────────────────────────────────


async def _create_evidence(client, org_id, *, work_item_id, work_item_type="story", payload):
    return await client.post(
        f"/api/v2/evidence",
        json={
            "work_item_id": str(work_item_id), "work_item_type": work_item_type,
            "type": "report", "ref": "concept-verification", "payload": payload,
        },
    )


@pytest.mark.anyio
async def test_evidence_verification_sheet_valid_server_forces_verified_by():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, org_id, work_item_id=story_id,
                payload={
                    "kind": "verification_sheet",
                    "items": [{"name": "요구사항 A", "verdict": "pass"}, {"name": "요구사항 B", "verdict": "fail", "note": "미충족"}],
                    "verified_by": {"type": "human", "id": str(uuid.uuid4())},  # 위조 시도 — 서버가 덮어써야.
                },
            )
        assert r.status_code == 201, r.text
        payload = r.json()["payload"]
        assert payload["verified_by"]["type"] == "human"
        assert payload["verified_by"]["id"] != None
        assert "verified_at" in payload
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_verification_sheet_server_forces_verified_by_ignoring_client():
    """뮤테이션 대상② — evidence.py의 verified_by 강제 대입이 제거되면 이 테스트가
    RED여야 한다(클라 위조값이 그대로 남으면 안 된다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        forged_id = str(uuid.uuid4())
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, org_id, work_item_id=story_id,
                payload={
                    "kind": "verification_sheet",
                    "items": [{"name": "요구사항 A", "verdict": "pass"}],
                    "verified_by": {"type": "platform", "id": forged_id},
                },
            )
        assert r.status_code == 201, r.text
        verified_by = r.json()["payload"]["verified_by"]
        assert verified_by["type"] != "platform"
        assert verified_by["id"] != forged_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_verification_sheet_empty_items_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, org_id, work_item_id=story_id,
                payload={"kind": "verification_sheet", "items": []},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_verification_sheet_invalid_verdict_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await _create_evidence(
                client, org_id, work_item_id=story_id,
                payload={
                    "kind": "verification_sheet",
                    "items": [{"name": "요구사항 A", "verdict": "완료"}],
                },
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
    finally:
        await engine.dispose()


# ─── ⑥ 허용목록 등재(순수 유닛) ───────────────────────────────────────────────


def test_concept_approval_registered_in_gate_types_allowlist():
    from app.models.hitl_config import GATE_TYPES

    assert "concept_approval" in GATE_TYPES


def test_concept_approval_registered_as_always_manual():
    from app.services.gate_service import _ALWAYS_MANUAL_GATE_TYPES

    assert "concept_approval" in _ALWAYS_MANUAL_GATE_TYPES
