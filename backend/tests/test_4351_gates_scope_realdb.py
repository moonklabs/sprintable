"""story #4351 PR A — 게이트 목록 · 결재함이 접근 권한 없는 프로젝트의 게이트 · 결재를 싣지 않는다.

`GET /api/v2/gates`(work_item_id · ids 없이) · `GET /api/v2/gates/inbox`(assigned_to_me 없이)가 org 전체 게이트(작업 제목 · 봉인
문서 제목)와 HITL 결재(title · prompt)를 돌려줬다. PO 규칙(2026-09-26): 접근이 제한된 caller는 접근 가능 프로젝트의 게이트 + 어느
프로젝트에도 안 걸린 org 수준 게이트만 · 전체 접근(owner/admin)은 옛 동작 그대로.
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import pytest

from tests.conftest import override_db_and_read
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_e_security_sec_s8_g_cross_project_access_realdb import _REAL_DB_URL, _session_factory

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@asynccontextmanager
async def _world():
    """project A · B · 스토리 각 1 · 각 스토리 게이트 + org 수준 게이트(모르는 종류) + 각 프로젝트 결재. 사람(A만) · owner."""
    from app.models.gate import Gate
    from app.models.hitl import HitlRequest
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.user import User

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
            pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
            s.add_all([pa, pb])
            await s.commit()
            member_id, member_user = await _make_member(s, org.id, pa.id)
            owner_user = uuid.uuid4()
            s.add(User(id=owner_user, email=f"o-{owner_user.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user, role="owner"))
            story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=pa.id, title="VISIBLE-A-story")
            story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=pb.id, title="SECRET-B-story")
            s.add_all([story_a, story_b])
            await s.commit()
            gates = {}
            for key, wtype, wid in (("a", "story", story_a.id), ("b", "story", story_b.id), ("org", "unknown_org_level", uuid.uuid4())):
                g = Gate(
                    id=uuid.uuid4(), org_id=org.id, work_item_id=wid, work_item_type=wtype,
                    gate_type="merge", status="pending", neutral_facts={},
                )
                s.add(g)
                gates[key] = str(g.id)
            for proj, mark in ((pa, "VISIBLE-A"), (pb, "SECRET-B")):
                s.add(HitlRequest(
                    id=uuid.uuid4(), org_id=org.id, project_id=proj.id, agent_id=member_id, request_type="gate_approval",
                    title=f"{mark}-hitl-title", prompt=f"{mark}-hitl-prompt", requested_for=member_id, status="pending",
                ))
            await s.commit()
        yield Session, {"org": org.id, "pa": pa.id, "member_user": member_user, "owner_user": owner_user, "gates": gates}
    finally:
        await engine.dispose()


async def _get(Session, seeded, path, user):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(user), email="u@test",
            claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(path)
        assert resp.status_code == 200, resp.text[:400]
        return resp
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("path", ["/api/v2/gates", "/api/v2/gates/inbox"])
async def test_restricted_member_sees_only_accessible_and_org_level_gates(path):
    async with _world() as (Session, seeded):
        resp = await _get(Session, seeded, path, seeded["member_user"])
        ids = {item["id"] for item in resp.json()}
        assert seeded["gates"]["a"] in ids
        assert seeded["gates"]["org"] in ids, "어느 프로젝트에도 안 걸린 org 수준 게이트는 그대로 보인다"
        assert seeded["gates"]["b"] not in ids, "접근 권한 없는 프로젝트(B)의 게이트가 섞이면 안 된다"
        assert "SECRET-B" not in resp.text


@pytest.mark.parametrize("path", ["/api/v2/gates", "/api/v2/gates/inbox"])
async def test_full_access_owner_is_unchanged(path):
    async with _world() as (Session, seeded):
        resp = await _get(Session, seeded, path, seeded["owner_user"])
        ids = {item["id"] for item in resp.json()}
        assert {seeded["gates"]["a"], seeded["gates"]["b"], seeded["gates"]["org"]} <= ids, "전체 접근은 옛 동작 그대로"


async def test_inbox_hitl_rows_follow_the_same_rule():
    async with _world() as (Session, seeded):
        member = await _get(Session, seeded, "/api/v2/gates/inbox", seeded["member_user"])
        owner = await _get(Session, seeded, "/api/v2/gates/inbox", seeded["owner_user"])
        assert "VISIBLE-A-hitl-prompt" in member.text and "SECRET-B-hitl" not in member.text
        assert "SECRET-B-hitl-prompt" in owner.text
