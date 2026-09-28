"""story #3868(customer-zero·BE, 페드루 PO 確定 2026-09-14 11:41Z) — ``GET /api/v2/today``의
needs_me kind(승인/서명) 판정을 gates.py 고위험 집행과 같은 SSOT 함수
``derive_risk_grade(posture, gate_type)``로 통일한 뒤의 posture 축 실PG 검증.

옛 규칙(``today_service.py``) — ``gate_type == "external_publish"``만 리터럴로 보고
kind를 정했다. 실제 위험도는 org posture(1차축)+gate_type(2차축, doc_approval도
external_publish와 동형 high 멤버) 둘 다로 정해지는데(gate_service.py::
derive_risk_grade, doc `gate-risk-ux-classification-criteria` §2) 옛 규칙은 그 SSOT를
전혀 안 봤다 — doc_approval을 놓치고(「오늘」=approval인데 게이트 페이지=signature
갈림, story #3868 원 증상) posture=permissive가 external_publish를 low로 내려도
여전히 high로 오판했다(양방향 오차).

AC2 표본(PO 지시 그대로): (a) doc_approval+conservative→signature (b)
external_publish+permissive→approval(옛 규칙이면 이 자리는 signature — 이 assert
자체가 옛 리터럴 비교로 되돌리면 RED가 되는 고정점) (c) 미분류 gate_type→high 폴백
그대로 (d) 교차 1=같은 fixture로 today kind와 GET /gates/{id}의 risk_grade가 정확히
동일 SSOT 값(오늘의 kind==='signature' ⇔ 그 게이트 risk_grade==='high', FE
usesSignatureFlow(risk)=risk!=='low'와 같은 판정).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    pytest.mark.destructive_schema,
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
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _make_org(session, name="Org3868"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org3868-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_story(session, org_id, project_id, title="S"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="in-review")
    session.add(story)
    await session.commit()
    return story


async def _make_member(session, org_id, project_id, *, org_role="member", name="member"):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=org_role)
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name=name)
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_gate(
    session, org_id, *, work_item_type, work_item_id, gate_type, status="pending", neutral_facts=None,
):
    from app.models.gate import Gate
    g = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type=work_item_type,
        gate_type=gate_type, status=status, neutral_facts=neutral_facts or {},
    )
    session.add(g)
    await session.commit()
    return g


async def _make_doc(session, org_id, project_id, *, title="D", author_id):
    from app.models.doc import Doc
    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}", status="pending", created_by=author_id,
    )
    session.add(doc)
    await session.commit()
    return doc


async def _set_posture(session, org_id, posture: str):
    from app.models.hitl_config import OrgGatePolicy
    session.add(OrgGatePolicy(org_id=org_id, posture=posture))
    await session.commit()


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
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
        return AuthContext(user_id=str(user_id), email="human@test", claims={"app_metadata": {"org_id": str(org_id)}})

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def test_doc_approval_conservative_posture_yields_signature_realdb():
    """AC2(a) — doc_approval은 2차축 자체가 high 멤버지만, 1차축(posture=conservative)이
    이미 그걸 보장한다는 것까지 명시 확인(1차축 우선순위 그대로 유지 확인 겸용).
    doc_approval 게이트는 rule A(can_approve_doc_gate_reason) 대상이라 work_item_id가
    실제 Doc을 가리켜야 하고, 결재자(caller)가 상신자 본인이면 안 된다(SoD) — 별도
    requester 멤버로 doc을 만들어 caller와 분리한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            requester_id, _ = await _make_member(s, org.id, project.id, org_role="member", name="requester")
            await _set_posture(s, org.id, "conservative")

            doc = await _make_doc(s, org.id, project.id, title="doc 결재", author_id=requester_id)
            await _make_gate(
                s, org.id, work_item_type="doc", work_item_id=doc.id, gate_type="doc_approval",
                neutral_facts={"requested_by_member_id": str(requester_id)},
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            items = resp.json()["needs_me"]
            item = next(i for i in items if i["work_item"]["id"] == str(doc.id))
            assert item["kind"] == "signature" and item["risk"] == "high"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_needs_me_items_carry_their_own_project_id_realdb():
    """story #4241 — 「오늘」은 조직 전체 목록이다. needs-me 항목이 **자기** 프로젝트 id를 싣는다(FE 행 링크 `/gates/{id}?p=`의
    원천). 두 프로젝트(C·D)에 문서 결재를 하나씩 두고, 각 항목이 자기 프로젝트를 싣는지(현재 프로젝트로 뭉개지지 않는지) 본다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_c = await _make_project(s, org.id, name="C")
            project_d = await _make_project(s, org.id, name="D")
            caller_id, caller_user_id = await _make_member(s, org.id, project_c.id, org_role="owner")
            requester_id, _ = await _make_member(s, org.id, project_c.id, org_role="member", name="requester")
            doc_c = await _make_doc(s, org.id, project_c.id, title="C 문서", author_id=requester_id)
            doc_d = await _make_doc(s, org.id, project_d.id, title="D 문서", author_id=requester_id)
            for doc in (doc_c, doc_d):
                await _make_gate(
                    s, org.id, work_item_type="doc", work_item_id=doc.id, gate_type="doc_approval",
                    neutral_facts={"requested_by_member_id": str(requester_id)},
                )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            by_work_item = {i["work_item"]["id"]: i for i in resp.json()["needs_me"]}
            assert by_work_item[str(doc_c.id)]["project_id"] == str(project_c.id)
            assert by_work_item[str(doc_d.id)]["project_id"] == str(project_d.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_external_publish_permissive_posture_yields_approval_realdb():
    """AC2(b) — posture=permissive가 1차축을 이겨 external_publish(2차축 high 멤버)도
    low로 내린다. 옛 규칙(gate_type=="external_publish" 리터럴 비교)으로 되돌리면
    이 assert가 그대로 RED가 되는 고정점(뮤테이션 없이도 이 테스트 자체가 회귀가드)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            await _set_posture(s, org.id, "permissive")

            story = await _make_story(s, org.id, project.id, title="외부발행(저위험 조직)")
            await _make_gate(s, org.id, work_item_type="story", work_item_id=story.id, gate_type="external_publish")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            items = resp.json()["needs_me"]
            item = next(i for i in items if i["work_item"]["id"] == str(story.id))
            assert item["kind"] == "approval" and item["risk"] == "low", (
                f"posture=permissive면 external_publish도 low여야 한다: {item}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_unclassified_gate_type_falls_back_to_high_realdb():
    """AC2(c) — posture 미설정(balanced 기본값)+미분류 gate_type은 derive_risk_grade의
    보수적 폴백(둘 다 미확定=high, doc §2.3 안전판) 그대로 signature/high."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")

            story = await _make_story(s, org.id, project.id, title="신규 게이트 종류")
            await _make_gate(
                s, org.id, work_item_type="story", work_item_id=story.id, gate_type="brand_new_gate_type_3868",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            items = resp.json()["needs_me"]
            item = next(i for i in items if i["work_item"]["id"] == str(story.id))
            assert item["kind"] == "signature" and item["risk"] == "high"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_today_kind_matches_gate_page_risk_grade_cross_check_realdb():
    """AC2(d) 교차 1 — 같은 fixture(external_publish+permissive posture, (b)와 동형)로
    today의 kind와 GET /gates/{id}가 돌려주는 risk_grade가 같은 SSOT에서 나왔는지
    직접 대조한다. FE gate-risk.ts::usesSignatureFlow(risk)=risk!=='low'와 동일 판정
    (today kind==='signature' ⇔ gate risk_grade==='high')을 BE에서도 명시 확인."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            await _set_posture(s, org.id, "permissive")

            story = await _make_story(s, org.id, project.id, title="교차대조")
            gate = await _make_gate(s, org.id, work_item_type="story", work_item_id=story.id, gate_type="external_publish")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            today_resp = await client.get("/api/v2/today")
            assert today_resp.status_code == 200, today_resp.text
            today_item = next(
                i for i in today_resp.json()["needs_me"] if i["work_item"]["id"] == str(story.id)
            )

            gate_resp = await client.get(f"/api/v2/gates/{gate.id}")
            assert gate_resp.status_code == 200, gate_resp.text
            gate_risk_grade = gate_resp.json()["risk_grade"]

            assert today_item["risk"] == gate_risk_grade, (
                f"today risk({today_item['risk']}) != gate risk_grade({gate_risk_grade}) — 같은 SSOT가 아니다"
            )
            uses_signature_flow = gate_risk_grade != "low"
            assert (today_item["kind"] == "signature") == uses_signature_flow, (
                "today kind와 FE usesSignatureFlow(risk_grade) 판정이 어긋난다"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
