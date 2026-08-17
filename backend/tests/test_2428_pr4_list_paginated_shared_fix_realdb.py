"""story #2428 PR④ — BaseRepository.list_paginated() 공용 fix 양성대조(실 Postgres).

페드루 AC 리뷰(2026-08-17, PR③/#3157에서 최초 발견) — `list_paginated()` 자체가 count_q에
cursor를 안 넣어 마지막 페이지에서도 has_more(=X-Total-Count>len(items))가 영구 참이던
결함. TaskRepository.list_in_projects()는 이 공용 메서드를 안 쓰고 자체 구현이라 별도 fix가
필요했지만, `GoalRepository.list_goals()`는 기본 order_by 분기에서 `super().list_paginated()`를
그대로 위임한다 — 즉 이미 머지·QA-approved된 list_goals가 같은 결함을 갖고 있었다.

이 파일은 공용 fix(app/repositories/base.py)가 **실제로 그 기존 소비자(list_goals)를
고쳤다**는 양성대조 하나(페드루 조건②) — GET /api/v2/goals를 limit=2로 3페이지 끝까지
실제로 걸어 마지막 페이지에서 X-Total-Count == 그 페이지 건수임을 확認한다.

tasks.py의 story_id 스코프 분기(#3157)도 `repo.list_paginated()`를 그대로 호출하므로
(app/routers/tasks.py — `tasks, total = await repo.list_paginated(limit=limit,
cursor=cursor_dt, **filters)`) 이 공용 fix로 동일하게 소급 커버된다 — 별도 테스트 불요
(조건③, cross-check만).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed(session, *, n: int = 5):
    from app.models.organization import Organization
    from app.models.pm import Goal
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org2428PR4", slug=f"org2428pr4-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    # 단일 트랜잭션 내 다건은 Postgres now()가 동일값이라(server_default=func.now())
    # created_at 커서 비교(<)가 동일-timestamp 행을 스킵한다 — 명시 override로 결정적 스태거
    # (test_2428_pr3_tasks_pagination_realdb.py와 동형 대책).
    base = datetime.now(timezone.utc)
    for i in range(n):
        g = Goal(
            id=uuid.uuid4(), org_id=org.id, project_id=project.id, title=f"goal-{i}",
            created_at=base - timedelta(seconds=n - i),
        )
        session.add(g)
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller_id}


@pytest.mark.anyio
async def test_list_goals_last_page_x_total_count_matches_remaining_not_grand_total():
    """공용 list_paginated() fix 양성대조 — 5건을 limit=2로 GET /api/v2/goals 페이지 끝까지
    실제로 걸어, 마지막 페이지에서 X-Total-Count == 그 페이지 건수(has_more=False로 정확히
    떨어짐)까지 확認한다. fix 前엔 이 assert가 실패했을 것(3157과 동일 실패 모양)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=5)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_total = None
            last_len = None
            while True:
                params = {"limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/api/v2/goals", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                pages += 1
                seen_ids.update(g["id"] for g in body)
                last_total = int(resp.headers["x-total-count"])
                last_len = len(body)
                has_more = last_total > last_len
                cursor = resp.headers.get("x-next-cursor")
                if not has_more or not body:
                    break
                assert pages < 10, "무한 루프 방지"

            assert len(seen_ids) == 5, f"5건이 페이지 전체에 걸쳐 정확히 다 나와야: {seen_ids}"
            assert pages == 3, f"5건/limit=2 → 3페이지(2+2+1)여야: {pages}"
            assert last_total == last_len, (
                f"마지막 페이지 X-Total-Count({last_total})가 그 페이지 건수({last_len})와 "
                f"같아야 has_more=False로 정확히 떨어진다 — grand total(5) 고정이면 여기서 어긋남"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
