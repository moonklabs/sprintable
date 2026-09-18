"""story #3319(40030054) — 머지 게이트가 designated_approver_id=None으로 생성돼 rule B
(gates.py::_non_doc_gate_approvable)가 project/org owner·admin 전원에게 «승인 가능»으로
노출하던 결함 처방(실사고: PR#3706 머지 게이트를 QA 前에 org owner가 서명).

처방 B(선생님 확定): OrgGatePolicy.merge_gate_default_approver_member_id(nullable) 설정 시
①evaluate_merge_gate가 그 값을 designated_approver_id로 채우고 ②_non_doc_can_approve의
새 최우선 분기가 «designated_approver_id가 있으면 그 1인만 승인 가능»을 gate_type 무관
강제한다(두 변경이 다 있어야 실제로 owner inbox의 승인 버튼이 비활성화됨 — 그라운딩에서
확認한 "designated만 채우면 반쪽" 갭)."""
from __future__ import annotations

import os
import uuid

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


async def _seed_org_project(session, *, slug="org3319"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3319", slug=f"{slug}-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human_member(session, org_id, *, user_id=None, role="member"):
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User

    uid = user_id or uuid.uuid4()
    session.add(User(
        id=uid, email=f"u-{uid.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=uid, role=role))
    await session.commit()
    return member_id


async def _seed_agent_member(session, org_id, project_id, *, role="admin"):
    """사람 아닌 org owner/admin — merge_gate_default_approver_member_id 422 검증용. org_members
    엔 type 컬럼이 없어(사람 전용 구조) 통합 신원 테이블 `members`(app/models/member.py::Member,
    team_members는 이 테이블 위 VIEW — 실 alembic 스키마에선 view라 직접 INSERT 불가)에 같은
    user_id로 type='agent' 행을 얹어 is_org_owner_or_admin의 NOT EXISTS 패턴이 실제로 걸리는
    조건을 재현한다."""
    from app.core.security import hash_password
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.user import User

    uid = uuid.uuid4()
    # members.user_id → users.id FK — agent라도 이 테이블은 human user row를 참조한다
    # (봇 소유주 개념, org_members와 동형 관례).
    session.add(User(
        id=uid, email=f"bot-{uid.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=uid, role=role))
    await session.commit()
    session.add(Member(id=uuid.uuid4(), org_id=org_id, type="agent", user_id=uid, name="bot"))
    await session.commit()
    return member_id


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_jwt(app, Session, org_id, project_id, caller_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

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
            user_id=str(caller_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


# ─── ① rule B 매트릭스(순수 함수) ───────────────────────────────────────────────


@pytest.mark.anyio
async def test_non_doc_can_approve_designated_matches_caller_true():
    """⚠️user_id 축(org_members.user_id)과 designated_approver_id 축(member_id)이 달라
    caller_member_id를 별도로 넘겨야 한다(첫 구현에서 user_id로 직접 비교해 지정 승인자
    본인도 403이 나던 실측 버그 — 회귀가드 겸함)."""
    from app.routers.gates import _non_doc_can_approve

    caller_member = uuid.uuid4()
    assert await _non_doc_can_approve(
        session=None, gate_type="merge", user_id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        designated_approver_id=caller_member, caller_member_id=caller_member,
    ) is True


@pytest.mark.anyio
async def test_non_doc_can_approve_designated_mismatch_false_even_for_owner():
    """⭐핵심 — designated가 있으면 caller가 project owner/admin이어도(rule B가 원래 True를
    줬을 자리) False. session=None이라 _non_doc_gate_approvable로 폴백하면 즉시 크래시할
    것 — 최우선 단락이 실제로 먼저 걸려 폴백 자체를 안 탄다는 것도 같이 증명."""
    from app.routers.gates import _non_doc_can_approve

    caller_member = uuid.uuid4()
    designated = uuid.uuid4()
    assert await _non_doc_can_approve(
        session=None, gate_type="merge", user_id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        designated_approver_id=designated, caller_member_id=caller_member,
    ) is False


@pytest.mark.anyio
async def test_non_doc_can_approve_designated_caller_member_id_missing_fails_closed():
    """caller_member_id를 안 넘긴 호출(레거시 호출부가 있다면)도 fail-closed(False) — 지정
    승인자가 있는데 caller 축을 모르면 조용히 통과가 아니라 거부."""
    from app.routers.gates import _non_doc_can_approve

    designated = uuid.uuid4()
    assert await _non_doc_can_approve(
        session=None, gate_type="merge", user_id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        designated_approver_id=designated,
    ) is False


@pytest.mark.anyio
async def test_non_doc_can_approve_designated_none_is_current_behavior_regression():
    """designated_approver_id 생략(기존 호출부 스타일)도 None과 동일 — 회귀 0."""
    from sqlalchemy import select

    from app.models.project import OrgMember
    from app.routers.gates import _non_doc_can_approve

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319rb")
            owner_id = await _seed_human_member(s, org_id, role="owner")
            member_id = await _seed_human_member(s, org_id, role="member")

            owner_user_id = (await s.execute(
                select(OrgMember.user_id).where(OrgMember.id == owner_id)
            )).scalar_one()
            member_user_id = (await s.execute(
                select(OrgMember.user_id).where(OrgMember.id == member_id)
            )).scalar_one()

            assert await _non_doc_can_approve(
                s, "merge", owner_user_id, org_id, project_id,
            ) is True
            assert await _non_doc_can_approve(
                s, "merge", member_user_id, org_id, project_id,
            ) is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_doc_can_approve_designated_applies_across_gate_types_not_just_merge():
    """⭐PO 확定 — designated 분기는 gate_type을 안 가린다(레시피 external_publish 등에도
    적용). qa 게이트로 재현 — merge 전용 로직이 아님을 명시 고정."""
    from app.routers.gates import _non_doc_can_approve

    caller_member = uuid.uuid4()
    designated = uuid.uuid4()
    assert await _non_doc_can_approve(
        session=None, gate_type="qa", user_id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        designated_approver_id=designated, caller_member_id=caller_member,
    ) is False
    assert await _non_doc_can_approve(
        session=None, gate_type="external_publish", user_id=uuid.uuid4(), org_id=uuid.uuid4(),
        project_id=uuid.uuid4(), designated_approver_id=designated, caller_member_id=designated,
    ) is True


# ─── ② 정책값 → 머지 게이트 designated_approver_id 실주입(실 왕복) ────────────────


@pytest.mark.anyio
async def test_evaluate_merge_gate_stamps_designated_approver_from_org_policy():
    """⭐AC 핵심 — OrgGatePolicy.merge_gate_default_approver_member_id를 설정해 두면
    evaluate_merge_gate가 생성하는 머지 게이트의 designated_approver_id가 그 값으로
    채워진다."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.models.pm import Story
    from app.models.participation import Participation, ParticipationRole
    from app.services.merge_verdict_gate import evaluate_merge_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319stamp")
            po_member_id = await _seed_human_member(s, org_id, role="admin")

            s.add(OrgGatePolicy(
                id=uuid.uuid4(), org_id=org_id, posture="balanced",
                merge_gate_default_approver_member_id=po_member_id,
            ))
            await s.commit()

            implementer_id = await _seed_human_member(s, org_id, role="member")
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="implementation", label="Implementation", is_default=True)
            s.add(role)
            await s.commit()
            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S")
            s.add(story)
            await s.commit()
            s.add(Participation(
                id=uuid.uuid4(), org_id=org_id, story_id=story.id,
                member_id=implementer_id, role_id=role.id,
            ))
            await s.commit()

            decision = await evaluate_merge_gate(
                s, org_id, story.id, pr_number=101, repo="acme/repo",
                ci_result="pass", head_sha="a" * 40,
            )
            await s.commit()

            assert decision.gate_id is not None
            gate = (await s.execute(
                select(Gate).where(Gate.id == decision.gate_id)
            )).scalar_one()
            assert gate.designated_approver_id == po_member_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evaluate_merge_gate_designated_approver_none_when_policy_unset():
    """회귀 0 — OrgGatePolicy 행 자체가 없으면(미설정 조직) 머지 게이트는 여전히
    designated_approver_id=None으로 생성된다(현행 무변경)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.pm import Story
    from app.models.participation import Participation, ParticipationRole
    from app.services.merge_verdict_gate import evaluate_merge_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319nopolicy")
            implementer_id = await _seed_human_member(s, org_id, role="member")
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="implementation", label="Implementation", is_default=True)
            s.add(role)
            await s.commit()
            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S")
            s.add(story)
            await s.commit()
            s.add(Participation(
                id=uuid.uuid4(), org_id=org_id, story_id=story.id,
                member_id=implementer_id, role_id=role.id,
            ))
            await s.commit()

            decision = await evaluate_merge_gate(
                s, org_id, story.id, pr_number=102, repo="acme/repo",
                ci_result="pass", head_sha="b" * 40,
            )
            await s.commit()

            gate = (await s.execute(
                select(Gate).where(Gate.id == decision.gate_id)
            )).scalar_one()
            assert gate.designated_approver_id is None
    finally:
        await engine.dispose()


# ─── ③ 정책 PUT — 사람 owner/admin만(422) ──────────────────────────────────────


@pytest.mark.anyio
async def test_upsert_org_policy_rejects_agent_member_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319agent")
            admin_user_id = uuid.uuid4()
            await _seed_human_member(s, org_id, user_id=admin_user_id, role="admin")
            agent_member_id = await _seed_agent_member(s, org_id, project_id)
        await _setup_app_jwt(app, Session, org_id, project_id, admin_user_id)
        client = _client_for(app)
        try:
            resp = await client.put(
                "/api/v2/gate-config/policy",
                json={"posture": "balanced", "merge_gate_default_approver_member_id": str(agent_member_id)},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upsert_org_policy_rejects_non_owner_admin_member_422():
    """member role(owner/admin 아님)도 거부 — 사람이어도 자격 부족."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319member")
            admin_user_id = uuid.uuid4()
            await _seed_human_member(s, org_id, user_id=admin_user_id, role="admin")
            plain_member_id = await _seed_human_member(s, org_id, role="member")
        await _setup_app_jwt(app, Session, org_id, project_id, admin_user_id)
        client = _client_for(app)
        try:
            resp = await client.put(
                "/api/v2/gate-config/policy",
                json={"posture": "balanced", "merge_gate_default_approver_member_id": str(plain_member_id)},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upsert_org_policy_accepts_human_admin_member_200_round_trip():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319ok")
            admin_user_id = uuid.uuid4()
            await _seed_human_member(s, org_id, user_id=admin_user_id, role="admin")
            po_member_id = await _seed_human_member(s, org_id, role="owner")
        await _setup_app_jwt(app, Session, org_id, project_id, admin_user_id)
        client = _client_for(app)
        try:
            resp = await client.put(
                "/api/v2/gate-config/policy",
                json={"posture": "balanced", "merge_gate_default_approver_member_id": str(po_member_id)},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["merge_gate_default_approver_member_id"] == str(po_member_id)

            # GET도 값을 그대로 되돌려준다.
            resp2 = await client.get("/api/v2/gate-config/policy")
            assert resp2.json()["merge_gate_default_approver_member_id"] == str(po_member_id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upsert_org_policy_unset_value_still_200_regression():
    """미지정(None, 기본값)은 검증 대상 자체가 없어 그대로 통과(회귀 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319unset")
            admin_user_id = uuid.uuid4()
            await _seed_human_member(s, org_id, user_id=admin_user_id, role="admin")
        await _setup_app_jwt(app, Session, org_id, project_id, admin_user_id)
        client = _client_for(app)
        try:
            resp = await client.put("/api/v2/gate-config/policy", json={"posture": "conservative"})
            assert resp.status_code == 200, resp.text
            assert resp.json()["merge_gate_default_approver_member_id"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ④ HTTP 승인 왕복 — designated만 성공·비지정 project owner는 403 ──────────────


@pytest.mark.anyio
async def test_transition_endpoint_designated_approver_succeeds_others_403():
    """실 HTTP 왕복 — designated_approver_id가 찍힌 non-doc 게이트(gate_type=qa로 재현,
    머지 SHA 프레시니스 기계장치는 이 테스트의 관심사가 아니라 배제)를 project owner가
    아닌 비지정 admin이 승인 시도하면 403, 지정된 본인은 200."""
    from app.main import app
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319tx")
            designated_user_id = uuid.uuid4()
            designated_member_id = await _seed_human_member(
                s, org_id, user_id=designated_user_id, role="admin",
            )
            other_admin_user_id = uuid.uuid4()
            await _seed_human_member(s, org_id, user_id=other_admin_user_id, role="admin")

            from app.models.pm import Story
            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S")
            s.add(story)
            await s.commit()

            gate = await create_gate(
                s, org_id, story.id, "story", "qa",
                designated_member_id, uuid.uuid4(),
                project_id=project_id, neutral_facts={},
                designated_approver_id=designated_member_id, notify=False,
            )
            await s.commit()
            gate_id = gate.id

        # 비지정 admin — project owner/admin이면 옛 rule B론 통과했을 자리, 지금은 403.
        await _setup_app_jwt(app, Session, org_id, project_id, other_admin_user_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition", json={"status": "approved"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # 지정된 본인 — 200.
        await _setup_app_jwt(app, Session, org_id, project_id, designated_user_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition", json={"status": "approved"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ⑤ delegate 후 새 지정자 허용(예외 경로) ─────────────────────────────────────


@pytest.mark.anyio
async def test_delegate_then_new_designee_can_approve_old_designee_403():
    """예외 경로는 기존 delegate API뿐(PO 확定) — 위임 後 새 지정자는 승인 가능, 원 지정자는
    더 이상 불가."""
    from app.main import app
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="org3319delegate")
            original_user_id = uuid.uuid4()
            original_member_id = await _seed_human_member(
                s, org_id, user_id=original_user_id, role="admin",
            )
            new_user_id = uuid.uuid4()
            new_member_id = await _seed_human_member(s, org_id, user_id=new_user_id, role="admin")

            from app.models.pm import Story
            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S")
            s.add(story)
            await s.commit()

            gate = await create_gate(
                s, org_id, story.id, "story", "qa",
                original_member_id, uuid.uuid4(),
                project_id=project_id, neutral_facts={},
                designated_approver_id=original_member_id, notify=False,
            )
            await s.commit()
            gate_id = gate.id

        await _setup_app_jwt(app, Session, org_id, project_id, original_user_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/delegate",
                json={"new_approver_member_id": str(new_member_id)},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # 원 지정자 — 이제 403(위임으로 자격 이전됨).
        await _setup_app_jwt(app, Session, org_id, project_id, original_user_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition", json={"status": "approved"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # 새 지정자 — 200.
        await _setup_app_jwt(app, Session, org_id, project_id, new_user_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition", json={"status": "approved"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
