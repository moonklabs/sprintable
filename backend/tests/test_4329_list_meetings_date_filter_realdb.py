"""story #4329 AC1 — `GET /api/v2/meetings`가 `date_from` · `date_to`를 실제로 읽는다.

MCP `sprintable_list_meetings`는 이 둘을 쿼리로 보내 왔는데 라우터가 `meeting_type`만 받아 FastAPI가 조용히 버렸다 → 에이전트는
날짜로 거른 줄 알고 전체 목록을 받았다. 이제 양 끝 포함 범위로 거르고, 오프셋 규칙은 4294와 같다(오프셋 없으면 422
`DATETIME_OFFSET_REQUIRED`).

실 DB: KST 하루(9/18) 경계 — 경계 값 정확히 같은 회의는 포함 · 그 1초 밖은 제외 · naive는 422 · from > to는 422 · 거름 없으면 전부(회귀 0).
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime
from urllib.parse import quote

import pytest
from sqlalchemy import text

from tests.test_e_security_sec_s8_ratchet_round7_activity_logs_stream_realdb import (
    _client_for,
    _session_factory,
    _setup_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# KST 9/18 하루 = 2026-09-17T15:00:00Z ~ 2026-09-18T14:59:59Z
_MEETINGS = {
    "kst-17-2359": datetime(2026, 9, 17, 14, 59, 59, tzinfo=UTC),  # 하루 1초 전 — 제외
    "kst-18-0000": datetime(2026, 9, 17, 15, 0, 0, tzinfo=UTC),  # date_from과 정확히 같음 — 포함
    "kst-18-1200": datetime(2026, 9, 18, 3, 0, 0, tzinfo=UTC),
    "kst-18-2359": datetime(2026, 9, 18, 14, 59, 59, tzinfo=UTC),  # date_to와 정확히 같음 — 포함
    "kst-19-0000": datetime(2026, 9, 18, 15, 0, 0, tzinfo=UTC),  # 하루 다음 — 제외
}
_FROM = "2026-09-18T00:00:00+09:00"
_TO = "2026-09-18T23:59:59+09:00"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _seed(session):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    # meetings.meeting_type은 DB에선 PG enum이라 raw SQL + 캐스트로 심는다(기존 realdb 관례 — test_e_security_sec_s8_g).
    for title, when in _MEETINGS.items():
        await session.execute(
            text(
                "INSERT INTO meetings (id, project_id, title, meeting_type, date, participants, decisions, action_items) "
                "VALUES (:id, :pid, :title, CAST(:kind AS meeting_type), :date, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)"
            ),
            {"id": uuid.uuid4(), "pid": project.id, "title": title, "kind": "standup" if title == "kst-18-1200" else "general", "date": when},
        )
    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"m-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="member"))
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "user_id": user_id}


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_list_meetings_filters_by_an_inclusive_offset_aware_date_window():
    """뮤테이션: 라우터가 date_from/date_to를 repo에 안 넘기면(옛 동작) 다섯 개가 다 와서 RED · `>=`를 `>`로 바꾸면 경계 회의가 빠져 RED ·
    `require_aware` 거절을 빼면 naive가 200으로 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed(s)
        await _setup_app(app, Session, w["user_id"], w["org_id"])
        client = _client_for(app)
        try:
            base = f"/api/v2/meetings?project_id={w['project_id']}"

            r = await client.get(base)
            assert r.status_code == 200, r.text
            assert sorted(m["title"] for m in r.json()) == sorted(_MEETINGS), "거름 없으면 전부(회귀 0)"

            r = await client.get(f"{base}&date_from={quote(_FROM)}&date_to={quote(_TO)}")
            assert r.status_code == 200, r.text
            assert [m["title"] for m in r.json()] == ["kst-18-2359", "kst-18-1200", "kst-18-0000"], "KST 9/18 하루 · 양 끝 포함 · 최신순"

            r = await client.get(f"{base}&date_from={quote(_FROM)}")
            assert sorted(m["title"] for m in r.json()) == ["kst-18-0000", "kst-18-1200", "kst-18-2359", "kst-19-0000"]
            r = await client.get(f"{base}&date_to={quote(_TO)}")
            assert sorted(m["title"] for m in r.json()) == ["kst-17-2359", "kst-18-0000", "kst-18-1200", "kst-18-2359"]

            r = await client.get(f"{base}&date_from={quote(_FROM)}&date_to={quote(_TO)}&meeting_type=standup")
            assert [m["title"] for m in r.json()] == ["kst-18-1200"], "종류 거름과 함께"

            r = await client.get(f"{base}&date_from=2026-09-18T00:00:00", headers={"Accept-Language": "en"})
            assert r.status_code == 422, r.text
            err = r.json()["error"]
            assert (err["code"], err["param"]) == ("DATETIME_OFFSET_REQUIRED", "date_from")
            r = await client.get(f"{base}&date_to=2026-09-18")
            assert r.status_code == 422, r.text
            assert r.json()["error"]["param"] == "date_to"

            r = await client.get(f"{base}&date_from={quote(_TO)}&date_to={quote(_FROM)}")
            assert r.status_code == 422, r.text

            r = await client.get(f"{base}&date_from={quote(_FROM)}&date_to={quote(_TO)}&limit=2")
            assert [m["title"] for m in r.json()] == ["kst-18-2359", "kst-18-1200"], "limit — 최신순 앞에서"
            for bad in ("0", "201"):
                assert (await client.get(f"{base}&limit={bad}")).status_code == 422
            assert (await client.get(f"{base}&meeting_type=planning")).status_code == 422, "enum 밖 종류는 422(DB 500 아님)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_meeting_type_works_against_the_real_enum_column_on_create_and_filter():
    """`meetings.meeting_type`은 DB에선 PG enum(`alembic/baseline/schema.sql`)인데 모델이 `Text`였다 → ORM이 varchar로 보내
    삽입(`POST`) · 거름(`?meeting_type=`)이 `meeting_type = character varying`으로 500. 기존 realdb 테스트는 raw SQL 캐스트로 우회해 못 잡았다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed(s)
        await _setup_app(app, Session, w["user_id"], w["org_id"])
        client = _client_for(app)
        try:
            r = await client.post("/api/v2/meetings", json={
                "project_id": str(w["project_id"]), "title": "made-by-api", "meeting_type": "review",
                "date": "2026-09-18T05:00:00+09:00",
            })
            assert r.status_code == 201, r.text
            assert r.json()["meeting_type"] == "review"

            r = await client.get(f"/api/v2/meetings?project_id={w['project_id']}&meeting_type=review")
            assert r.status_code == 200, r.text
            assert [m["title"] for m in r.json()] == ["made-by-api"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_meetings_at_the_same_time_come_back_in_a_stable_order():
    """까디르 — 같은 시각 회의가 여럿이면 `date`만으로는 순서가 정해지지 않아 `limit` 경계가 흔들린다 → `id` 내림차순으로 끊는다.
    작은 id를 먼저 심어(물리 순서 = 작은 id 먼저) 끊개 없이는 작은 id가 앞에 오게 한다 — 뮤테이션: `Meeting.id.desc()`를 빼면 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed(s)
            same = datetime(2026, 9, 20, 3, 0, 0, tzinfo=UTC)
            low, high = uuid.UUID(int=1), uuid.UUID(int=(1 << 128) - 1)
            for mid, title in ((low, "same-low"), (high, "same-high")):
                await s.execute(
                    text(
                        "INSERT INTO meetings (id, project_id, title, meeting_type, date, participants, decisions, action_items) "
                        "VALUES (:id, :pid, :title, CAST('general' AS meeting_type), :date, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)"
                    ),
                    {"id": mid, "pid": w["project_id"], "title": title, "date": same},
                )
            await s.commit()
        await _setup_app(app, Session, w["user_id"], w["org_id"])
        client = _client_for(app)
        try:
            window = f"date_from={quote('2026-09-20T12:00:00+09:00')}&date_to={quote('2026-09-20T12:00:00+09:00')}"
            base = f"/api/v2/meetings?project_id={w['project_id']}&{window}"
            r = await client.get(base)
            assert r.status_code == 200, r.text
            assert [m["title"] for m in r.json()] == ["same-high", "same-low"]
            r = await client.get(f"{base}&limit=1")
            assert [m["title"] for m in r.json()] == ["same-high"], "limit 경계 — 같은 시각이면 큰 id"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
