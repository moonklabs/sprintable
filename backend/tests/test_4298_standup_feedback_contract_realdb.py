"""story #4298(PO 06:15Z) — 스탠드업 피드백 · «안 쓴 사람»이 화면 계약대로 실 BE에서 돈다.

- 작성: 화면은 엔트리 id · 종류 · 본문(+ 보는 프로젝트)만 보낸다 — 조직 · 작성자는 서버가 인증 문맥에서 채운다(예전엔 422).
- 수정 · 삭제: 작성자만(남의 것 403 · 다른 조직/없는 id 404) — 예전엔 BE 경로가 없어 404.
- «안 쓴 사람»: `[{id, name}]`(이름 = members.name → 사람의 표시 이름 · 이메일 폴백 0 · 모르면 null) — 예전엔 UUID 배열이라 화면이 늘 빈 칸.
  MCP `standup_missing`도 같은 모양을 그대로 넘긴다.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import date
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_e_security_sec_s8_ee_standup_impersonation_oss_seed_realdb import (
    _client_for,
    _session_factory,
    _setup_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")]

_DAY = date(2026, 9, 25)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _seed(session):
    """조직 하나 · 프로젝트 하나 · 사람 셋(작성자 A · 다른 사람 B(이름 있음) · 이름 없는 C) · A의 스탠드업 엔트리."""
    from sqlalchemy import select

    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.standup import StandupEntry, StandupEntryProject
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    people = {}
    for key, display in (("a", "에이"), ("b", "비"), ("c", None)):
        uid = uuid.uuid4()
        session.add(User(id=uid, email=f"{key}-{uid.hex[:8]}@test.com", hashed_password="x", display_name=display))
        await session.commit()
        om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uid, role="member")
        session.add(om)
        await session.commit()
        session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="member"))
        await session.commit()
        if (await session.execute(select(Member.id).where(Member.id == om.id))).scalar_one_or_none() is None:
            session.add(Member(id=om.id, org_id=org.id, type="human", user_id=uid, name=None))
            await session.commit()
        people[key] = {"user_id": uid, "member_id": om.id}
    entry = StandupEntry(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, author_id=people["a"]["member_id"], date=_DAY,
        done="d", plan="p", blockers=None, plan_story_ids=[],
    )
    session.add(entry)
    await session.commit()
    session.add(StandupEntryProject(entry_id=entry.id, project_id=project.id, org_id=org.id))
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "entry_id": entry.id, **people}


@pytest.mark.anyio
async def test_feedback_create_edit_delete_with_the_screen_contract():
    """AC1 — 화면 본문 그대로 작성 201(작성자 = 호출자) · 작성자 PATCH 200 · 남의 PATCH/DELETE 403 · 프로젝트 접근권 없음 404 · 없는 id 404 · 작성자 DELETE 204.
    뮤테이션: `_assert_feedback_author`의 작성자 검사를 빼면 B의 PATCH가 200으로 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed(s)
        await _setup_app(app, Session, w["a"]["user_id"], w["org_id"])
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/standups/{w['entry_id']}/feedback", json={
                "review_type": "comment", "feedback_text": "좋아요", "project_id": str(w["project_id"]),
            })
            assert r.status_code == 201, r.text
            created = r.json()
            assert created["feedback_by_id"] == str(w["a"]["member_id"])
            fid = created["id"]
            r = await client.patch(f"/api/v2/standups/feedback/{fid}", json={"feedback_text": "고쳤어요"})
            assert (r.status_code, r.json()["feedback_text"]) == (200, "고쳤어요"), r.text
            r = await client.patch(f"/api/v2/standups/feedback/{uuid.uuid4()}", json={"feedback_text": "x"})
            assert r.status_code == 404, r.text

        await _setup_app(app, Session, w["b"]["user_id"], w["org_id"])
        async with _client_for(app) as client:
            r = await client.patch(f"/api/v2/standups/feedback/{fid}", json={"feedback_text": "남의 것"})
            assert r.status_code == 403, r.text
            assert (await client.delete(f"/api/v2/standups/feedback/{fid}")).status_code == 403

        # 같은 조직이어도 그 프로젝트 접근권이 없으면 존재도 비노출(404) — 작성자 검사보다 먼저.
        async with Session() as s:
            from sqlalchemy import delete

            from app.models.project_access import ProjectAccess

            await s.execute(delete(ProjectAccess).where(ProjectAccess.org_member_id == w["b"]["member_id"]))
            await s.commit()
        await _setup_app(app, Session, w["b"]["user_id"], w["org_id"])
        async with _client_for(app) as client:
            r = await client.patch(f"/api/v2/standups/feedback/{fid}", json={"feedback_text": "남의 것"})
            assert r.status_code == 404, r.text

        await _setup_app(app, Session, w["a"]["user_id"], w["org_id"])
        async with _client_for(app) as client:
            assert (await client.delete(f"/api/v2/standups/feedback/{fid}")).status_code == 204
            listed = await client.get("/api/v2/standups/feedback", params={"project_id": str(w["project_id"]), "date": _DAY.isoformat()})
            assert listed.status_code == 200 and listed.json() == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_missing_carries_names_and_the_mcp_tool_passes_the_same_shape():
    """AC2 — «안 쓴 사람»은 `[{id, name}]`: B는 표시 이름 · C는 이름 없음(null · 이메일 0) · 쓴 A는 없음. MCP `standup_missing`은 이 응답을
    그대로 넘긴다(도구 응답 모양 = `[{id, name}]`)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed(s)
        await _setup_app(app, Session, w["a"]["user_id"], w["org_id"])
        async with _client_for(app) as client:
            r = await client.get("/api/v2/standups/missing", params={"project_id": str(w["project_id"]), "date": _DAY.isoformat()})
        assert r.status_code == 200, r.text
        missing = {m["id"]: m["name"] for m in r.json()}
        assert missing == {str(w["b"]["member_id"]): "비", str(w["c"]["member_id"]): None}
        assert "@" not in json.dumps(r.json())

        from sprintable_mcp.tools.standup import StandupDateInput, standup_missing

        with patch("sprintable_mcp.tools.standup.client") as mock_client:
            mock_client.require_project_id = lambda: str(w["project_id"])
            mock_client.get = AsyncMock(return_value=r.json())
            out = await standup_missing(StandupDateInput(date=_DAY.isoformat()))
        shaped = json.loads(out[0].text)
        assert all(set(item) == {"id", "name"} for item in shaped) and len(shaped) == 2
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
