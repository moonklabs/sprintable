"""E-UI-DAEGBYEON P0-04 impl(story d17ac3c3·doc trust-pipeline-be-design) — 실 PG.

1) /glance/attention merge_ready 엄격화(human_verified+무블로커+무검증실패) + needs_input/verify_fail
   신규 kind 노출.
2) SSE 훅 3곳(gate 전이·dependency create/delete·story status 변경) — old/new 비교 후 변경시에만
   story.trust_stage_changed emit(publish_event mock으로 실측). item_type≠story는 무배선 확인.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _base_org_project_caller(session):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    session.add(project)
    await session.commit()
    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="member",
    ))
    await session.commit()
    return org.id, project.id, caller_id


def _story(org_id, project_id, title, status="in-progress"):
    from app.models.pm import Story
    return Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status=status)


# ── ① /glance/attention merge_ready 엄격화 + needs_input/verify_fail 신규 kind ──────────────

async def _seed_attention(session):
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.models.member import Member

    org_id, project_id, caller_id = await _base_org_project_caller(session)

    # story_unverified: in-review이나 human_verified 없음 → 엄격화 前엔 merge_ready였으나 後엔 제외.
    story_unverified = _story(org_id, project_id, "Unverified Review", status="in-review")
    # story_ready: in-review + gate_approval evidence(human_verified) + 무블로커/무검증실패 → merge_ready.
    story_ready = _story(org_id, project_id, "Ready Story", status="in-review")
    # story_needs_input: open + Gate(requires_human, pending) → needs_input.
    story_needs_input = _story(org_id, project_id, "Needs Input Story", status="in-progress")
    # story_verify_fail: open + Gate(merge, evidence_status=blocked) → verify_fail.
    story_verify_fail = _story(org_id, project_id, "Verify Fail Story", status="in-progress")
    session.add_all([story_unverified, story_ready, story_needs_input, story_verify_fail])
    await session.commit()

    reviewer = Member(id=uuid.uuid4(), org_id=org_id, type="human", name="Reviewer", org_role="admin")
    session.add(reviewer)
    await session.commit()
    session.add(Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_ready.id, work_item_type="story",
        type="gate_approval", ref="approved", created_by=reviewer.id,
    ))
    session.add(Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_needs_input.id, work_item_type="story",
        gate_type="pr_review", status="pending", requires_human=True,
    ))
    session.add(Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_verify_fail.id, work_item_type="story",
        gate_type="merge", status="pending", evidence_status="blocked",
    ))
    await session.commit()

    return {
        "org_id": org_id, "project_id": project_id, "caller_id": caller_id,
        "story_unverified": story_unverified.id, "story_ready": story_ready.id,
        "story_needs_input": story_needs_input.id, "story_verify_fail": story_verify_fail.id,
    }


@pytest.mark.anyio
async def test_attention_merge_ready_strict_and_new_kinds():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_attention(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            items = resp.json()["items"]

            merge_ready_ids = {i["story_id"] for i in items if i["kind"] == "merge_ready"}
            assert str(seeded["story_ready"]) in merge_ready_ids
            # 엄격화 핵심: human_verified 없는 in-review story는 더 이상 merge_ready 아님.
            assert str(seeded["story_unverified"]) not in merge_ready_ids

            needs_input_ids = {i["story_id"] for i in items if i["kind"] == "needs_input"}
            assert str(seeded["story_needs_input"]) in needs_input_ids

            verify_fail_ids = {i["story_id"] for i in items if i["kind"] == "verify_fail"}
            assert str(seeded["story_verify_fail"]) in verify_fail_ids

            # scope_violation: §7 확定②로 이번 스코프 미구현 — 어떤 item도 이 kind로 안 나옴.
            assert not any(i["kind"] == "scope_violation" for i in items)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── ② SSE 훅: gate 전이 ──────────────────────────────────────────────────────

def _trust_stage_calls(mock, story_id):
    return [
        c for c in mock.call_args_list
        if c.args[1] == "story.trust_stage_changed" and c.args[2]["story_id"] == str(story_id)
    ]


@pytest.mark.anyio
async def test_gate_transition_emits_trust_stage_changed_on_stage_change():
    """qa gate(story는 auto-advance 안 됨) approve — needs_input(다른 pending human gate 有) →
    running 전이가 trust_stage_changed 정확히 1회로 잡히는지(중복 emit 없음)."""
    from app.models.gate import Gate
    from app.models.member import Member
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, _ = await _base_org_project_caller(s)
            story = _story(org_id, project_id, "Gate Story", status="in-progress")
            s.add(story)
            await s.commit()
            resolver = Member(id=uuid.uuid4(), org_id=org_id, type="human", name="Resolver", org_role="admin")
            s.add(resolver)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="qa", status="pending", requires_human=True,
            )
            s.add(gate)
            await s.commit()

            publish = MagicMock()
            with patch("app.routers.events.publish_event", publish):
                await transition_gate(s, org_id, gate.id, "approved", resolver_id=resolver.id)
                await s.commit()

            calls = _trust_stage_calls(publish, story.id)
            assert len(calls) == 1, calls
            payload = calls[0].args[2]
            assert payload["old_stage"] == "needs_input"
            assert payload["new_stage"] == "running"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_transition_dedupes_when_status_also_advances():
    """merge gate approve가 story를 done까지 자동전진(_advance_story_on_merge_approve)시키는 경로 —
    훅③(status 변경)이 이미 old_stage/new_stage를 정확히 잡으므로 훅①은 skip해 중복 emit 0(doc §4
    이벤트 폭주 방지)."""
    from app.models.gate import Gate
    from app.models.member import Member
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, _ = await _base_org_project_caller(s)
            story = _story(org_id, project_id, "Merge Story", status="in-review")
            s.add(story)
            await s.commit()
            resolver = Member(id=uuid.uuid4(), org_id=org_id, type="human", name="Resolver", org_role="admin")
            s.add(resolver)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending",
            )
            s.add(gate)
            await s.commit()

            publish = MagicMock()
            with patch("app.routers.events.publish_event", publish):
                await transition_gate(s, org_id, gate.id, "approved", resolver_id=resolver.id)
                await s.commit()

            calls = _trust_stage_calls(publish, story.id)
            assert len(calls) == 1, calls  # 훅①·③ 둘 다 발화 가능한 상황이나 정확히 1회만.
            payload = calls[0].args[2]
            assert payload["old_stage"] == "claimed_done"
            assert payload["new_stage"] is None  # done = 파이프라인 스코프 밖.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_transition_noop_for_non_story_work_item():
    """work_item_type != story(예: doc)는 trust_stage 훅 자체가 무배선 — publish_event 미호출."""
    from app.models.gate import Gate
    from app.models.member import Member
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id, _ = await _base_org_project_caller(s)
            resolver = Member(id=uuid.uuid4(), org_id=org_id, type="human", name="Resolver", org_role="admin")
            s.add(resolver)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(), work_item_type="doc",
                gate_type="doc_approval", status="pending",
            )
            s.add(gate)
            await s.commit()

            publish = MagicMock()
            with patch("app.routers.events.publish_event", publish):
                await transition_gate(s, org_id, gate.id, "approved", resolver_id=resolver.id)
                await s.commit()

            publish.assert_not_called()
    finally:
        await engine.dispose()


# ── ③ SSE 훅: dependency create/delete ──────────────────────────────────────

@pytest.mark.anyio
async def test_dependency_create_and_delete_emit_trust_stage_changed_for_blocked_story():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, caller_id = await _base_org_project_caller(s)
            blocker = _story(org_id, project_id, "Blocker", status="in-progress")
            blocked = _story(org_id, project_id, "Blocked", status="in-progress")
            s.add_all([blocker, blocked])
            await s.commit()
            blocker_id, blocked_id = blocker.id, blocked.id

        await _setup_app(app, Session, caller_id, org_id)
        client = _client_for(app)
        try:
            publish = MagicMock()
            with patch("app.routers.events.publish_event", publish):
                resp = await client.post("/api/v2/dependencies", json={
                    "from_id": str(blocker_id), "to_id": str(blocked_id),
                    "dep_type": "blocks", "item_type": "story",
                })
                assert resp.status_code == 201, resp.text
                dep_id = resp.json()["id"]

            # running(무블로커) → running(블로킹 있음. 단, "running" 자체는 exception overlay 변화라
            # stage명은 동일하되 blocked 신호 True로 바뀌므로 emit돼야 함).
            publish.assert_called_once()
            args, _ = publish.call_args
            assert args[1] == "story.trust_stage_changed"
            assert args[2]["story_id"] == str(blocked_id)
            assert args[2]["exception_signals"]["blocked"] is True

            publish2 = MagicMock()
            with patch("app.routers.events.publish_event", publish2):
                del_resp = await client.delete(f"/api/v2/dependencies/{dep_id}")
                assert del_resp.status_code == 200, del_resp.text

            publish2.assert_called_once()
            args2, _ = publish2.call_args
            assert args2[2]["exception_signals"]["blocked"] is False
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_dependency_create_noop_for_non_story_item_type():
    """item_type=epic은 blocked 신호 스코프 밖(glance.py 기존 규율과 동형) — trust_stage 훅 무배선."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.pm import Epic

            org_id, project_id, caller_id = await _base_org_project_caller(s)
            epic_a = Epic(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="Epic A")
            epic_b = Epic(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="Epic B")
            s.add_all([epic_a, epic_b])
            await s.commit()
            epic_a_id, epic_b_id = epic_a.id, epic_b.id

        await _setup_app(app, Session, caller_id, org_id)
        client = _client_for(app)
        try:
            publish = MagicMock()
            with patch("app.routers.events.publish_event", publish):
                resp = await client.post("/api/v2/dependencies", json={
                    "from_id": str(epic_a_id), "to_id": str(epic_b_id),
                    "dep_type": "blocks", "item_type": "epic",
                })
                assert resp.status_code == 201, resp.text
            publish.assert_not_called()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
