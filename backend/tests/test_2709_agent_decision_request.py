"""story #2709 — 에이전트의 블로킹 질문을 비동기 결정 요청으로 승격.

self-referencing standalone anchor(work_item_id==gate.id, work_item_type=
"agent_decision")가 create_gate()의 멱등 조회(work_item_id+
work_item_type+gate_type)와 충돌 없이 항상 유일한 새 gate를 만드는지(PO 조건ⓑ) +
KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES 미등재 시 재발했을 fail-closed 404(전수 grep으로
발견한 그 자리)가 지금은 안 걸리는지를 real PG로 검증한다.
"""
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


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2709", slug=f"org2709-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human_member(session, org_id, *, user_id=None, role="member"):
    """story #3004(선생님 정책 확定 2026-08-24) — approver_member_id가 create_decision_request의
    필수 인자가 되며, 실 HTTP 왕복 테스트는 (a) 호출자를 실 User+OrgMember로(카디르 CRITICAL,
    PR #3435 QA — resolve_member가 JWT 분기에서 OrgMember.user_id를 조회하므로 seed 없이는
    400 Organization member not found) (b) 지정할 owner/admin 대상도 실 OrgMember로 갖춰야
    한다. user_id를 지정하면(호출자 축) 그 값으로 User를 만들어 auth.user_id와 정확히
    일치시킨다."""
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


@pytest.mark.anyio
async def test_self_referencing_anchor_gate_id_equals_work_item_id():
    """gate.id == gate.work_item_id — 1 INSERT 원자 생성(생성 後 UPDATE 2단계 아님)."""
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            caller_id = uuid.uuid4()
            gate_id = uuid.uuid4()

            gate = await create_gate(
                session=s, org_id=org_id, work_item_id=gate_id,
                work_item_type="agent_decision",
                gate_type="agent_decision_request",
                member_id=caller_id, role_id=gate_id,
                neutral_facts={"question": "A or B?", "assumption": "A", "requested_by_member_id": str(caller_id), "project_id": str(project_id)},
                project_id=project_id, gate_id=gate_id, notify=False,
            )
            await s.commit()

            assert gate.id == gate_id
            assert gate.work_item_id == gate_id
            assert gate.status == "pending", "agent_decision_request는 _ALWAYS_MANUAL — posture 무관 항상 pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_two_distinct_decision_requests_never_collide():
    """PO 조건ⓑ — 서로 다른 uuid4로 만든 두 standalone anchor는 create_gate()의 멱등 조회에
    걸리지 않고 각각 독립된 gate로 생성된다(항상 유일, «사실상 no-op 없음» 실증)."""
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            caller_id = uuid.uuid4()

            gate_id_1 = uuid.uuid4()
            gate1 = await create_gate(
                session=s, org_id=org_id, work_item_id=gate_id_1,
                work_item_type="agent_decision",
                gate_type="agent_decision_request",
                member_id=caller_id, role_id=gate_id_1,
                neutral_facts={"question": "Q1", "assumption": "A1"},
                project_id=project_id, gate_id=gate_id_1, notify=False,
            )
            await s.commit()

            gate_id_2 = uuid.uuid4()
            gate2 = await create_gate(
                session=s, org_id=org_id, work_item_id=gate_id_2,
                work_item_type="agent_decision",
                gate_type="agent_decision_request",
                member_id=caller_id, role_id=gate_id_2,
                neutral_facts={"question": "Q2", "assumption": "A2"},
                project_id=project_id, gate_id=gate_id_2, notify=False,
            )
            await s.commit()

            assert gate1.id != gate2.id
            assert gate1.neutral_facts["question"] == "Q1"
            assert gate2.neutral_facts["question"] == "Q2"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_repeated_gate_id_is_idempotent_no_op():
    """호출측이 실수로(또는 재시도로) 같은 gate_id를 두 번 넘기면 — create_gate() 자체의
    기존 멱등 로직(work_item_id+work_item_type+gate_type 조합)이 그대로 적용돼 새 행을
    또 안 만들고 기존 gate를 반환한다(회귀 없음, PO가 스코프 밖으로 明示한 "발행측 재발행
    판단"과는 별개 축 — 이건 순수 create_gate() 계약)."""
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            caller_id = uuid.uuid4()
            gate_id = uuid.uuid4()

            gate_a = await create_gate(
                session=s, org_id=org_id, work_item_id=gate_id,
                work_item_type="agent_decision",
                gate_type="agent_decision_request",
                member_id=caller_id, role_id=gate_id,
                neutral_facts={"question": "Q", "assumption": "A"},
                project_id=project_id, gate_id=gate_id, notify=False,
            )
            await s.commit()

            gate_b = await create_gate(
                session=s, org_id=org_id, work_item_id=gate_id,
                work_item_type="agent_decision",
                gate_type="agent_decision_request",
                member_id=caller_id, role_id=gate_id,
                neutral_facts={"question": "Q(다시 시도)", "assumption": "A"},
                project_id=project_id, gate_id=gate_id, notify=False,
            )
            await s.commit()

            assert gate_a.id == gate_b.id
            # 기존 gate 그대로 반환 — 두번째 호출의 neutral_facts로 덮어쓰지 않는다(멱등=no-op).
            assert gate_b.neutral_facts["question"] == "Q"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_known_project_agnostic_registration_prevents_404():
    """전수 grep으로 발견한 그 블로커의 회귀가드 — agent_decision이
    KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES에 없으면 GET /gates/{id}의 fail-closed 분기(#2237)가
    모든 조회를 404로 거부했을 것이다."""
    from app.services.gate_service import (
        KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES,
        is_known_project_agnostic_work_item_type,
    )

    assert "agent_decision" in KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES
    assert is_known_project_agnostic_work_item_type("agent_decision") is True


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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_http_endpoint_creates_pending_low_risk_decision_gate():
    """`POST /api/v2/gates/decisions`(신규 엔드포인트) 실 HTTP 왕복 — 응답이 self-referencing
    anchor(id==work_item_id)·status=pending(항상 manual)·risk_grade=low(원탭 승인, 서명
    플로우 면제)임을 확認한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            caller_id = uuid.uuid4()  # User.id — 아래서 그대로 seed(auth.user_id와 일치시킴).
            await _seed_human_member(s, org_id, user_id=caller_id, role="member")
            approver_member_id = await _seed_human_member(s, org_id, role="admin")
        await _setup_app_jwt(app, Session, org_id, project_id, caller_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/gates/decisions",
                json={
                    "question": "approach A or B?", "assumption": "A", "options": ["A", "B"],
                    # story #3004 — 이제 필수(미지정 400 APPROVER_REQUIRED).
                    "approver_member_id": str(approver_member_id),
                },
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["id"] == body["work_item_id"]
            assert body["status"] == "pending"
            assert body["gate_type"] == "agent_decision_request"
            assert body["work_item_type"] == "agent_decision"
            assert body["risk_grade"] == "low", "PO 조건① — 서명플로우 면제(원탭 승인)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_response_echoes_designated_approver_identity_for_self_verification():
    """story #d9c09f4b(2026-08-27, customer-zero) — 실사고 재발 방지: 카드 배달층은 무결했고
    호출자가 approver_member_id를 오지정(다른 실사람)한 게 진짜 원인이었다. 배달 성공/실패와
    무관하게 응답이 "실제로 누구를 가리키는지" 이름/이메일로 에코해야 호출자가 즉시
    자가검증할 수 있다 — 이 테스트는 응답의 designated_approver_name이 seed 시 지정한
    approver의 실제 email과 정확히 일치함을 고정한다(다른 값이면 즉시 RED)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            caller_id = uuid.uuid4()
            await _seed_human_member(s, org_id, user_id=caller_id, role="member")
            approver_user_id = uuid.uuid4()
            approver_email = f"designated-{approver_user_id.hex[:8]}@test.com"
            from app.core.security import hash_password
            from app.models.project import OrgMember
            from app.models.user import User

            s.add(User(
                id=approver_user_id, email=approver_email,
                hashed_password=hash_password("x"), is_active=True, email_verified=True,
            ))
            await s.commit()
            approver_member_id = uuid.uuid4()
            s.add(OrgMember(id=approver_member_id, org_id=org_id, user_id=approver_user_id, role="admin"))
            await s.commit()
        await _setup_app_jwt(app, Session, org_id, project_id, caller_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/gates/decisions",
                json={
                    "question": "approach A or B?", "assumption": "A",
                    "approver_member_id": str(approver_member_id),
                },
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["designated_approver_id"] == str(approver_member_id)
            assert body["designated_approver_name"] == approver_email
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_designated_approver_name_lookup_exception_does_not_break_response(monkeypatch, caplog):
    """카디르 QA(#3550) — designated_approver_name 조회가 «미확인 멤버»가 아니라 **예외**로
    죽으면(레이스·일시적 DB 오류) 이미 커밋된 게이트 생성 응답이 500으로 뒤집히면 안 된다.
    lookup_members_by_ids를 강제로 예외 발생시켜 응답이 여전히 201·필드는 None 폴백임을
    고정한다(관측성 필드가 본 기능을 죽이는 회귀 방지)."""
    import logging

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            caller_id = uuid.uuid4()
            await _seed_human_member(s, org_id, user_id=caller_id, role="member")
            approver_member_id = await _seed_human_member(s, org_id, role="admin")
        await _setup_app_jwt(app, Session, org_id, project_id, caller_id)

        import app.services.member_resolver as member_resolver_mod

        async def _boom(*args, **kwargs):
            raise RuntimeError("simulated lookup failure")

        monkeypatch.setattr(member_resolver_mod, "lookup_members_by_ids", _boom)

        client = _client_for(app)
        try:
            with caplog.at_level(logging.WARNING):
                resp = await client.post(
                    "/api/v2/gates/decisions",
                    json={
                        "question": "approach A or B?", "assumption": "A",
                        "approver_member_id": str(approver_member_id),
                    },
                )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["status"] == "pending", "게이트 생성 자체는 이미 커밋 완료 — 관측성 조회 실패로 뒤집히면 안 됨"
            assert body["designated_approver_name"] is None
            assert any("designated_approver_name 조회 실패" in r.message for r in caplog.records)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_http_endpoint_missing_org_or_project_403():
    """음성대조 — org_id/project_id를 못 얻으면(예: X-Project-Id 없는 API키 컨텍스트에서
    project 미해소) 403(get_scope_context 경유, 조용히 통과 안 함)."""
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)

        async def _db():
            async with Session() as s:
                yield s

        async def _auth():
            return AuthContext(
                user_id=str(uuid.uuid4()), email=None,
                claims={"app_metadata": {"org_id": str(org_id)}},  # project_id 없음
            )

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/gates/decisions",
                json={"question": "Q", "assumption": "A"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
