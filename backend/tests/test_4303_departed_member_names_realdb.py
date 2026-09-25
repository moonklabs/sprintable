"""story #4303(PO 06:39Z · 1안 + role `member` 고정) — 조직을 떠난 사람의 이름이 옛 기록에서 풀린다.

떠남 = `delete_org_member`: org_members.deleted_at + members.is_active=false(이름은 남음) + project_access 삭제. 조직 범위
`GET /api/v2/team-members?include_inactive=true`(4300 이름 훅의 조직 원천)는 에이전트는 비활성까지 싣는데 휴먼 갈래는 늘
`om.deleted_at IS NULL`이라 떠난 사람만 빠졌다 → 옛 기록 작성 · 담당 · 승인 칸이 «알 수 없는 구성원».

- `include_inactive=true`일 때만 떠난 사람도 싣는다 — 이름 · 종류만(user_id · avatar_url null · role `member` · is_active false).
- 기본 로스터(`include_inactive` 없음) · `type=agent` · `/api/v2/members`는 그대로(고르기 목록에 섞이지 않음).
- 다른 조직의 떠난 사람은 0.
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

import pytest

_RAW_URL = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC_URL = _RAW_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _ASYNC_URL, reason="real-DB URL 미설정 — skip")

_LEFT_AT = datetime(2020, 1, 1, tzinfo=UTC)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _seed(session):
    """조직 A: 호출자(owner) · 남은 사람 B · 떠난 사람 D(옛 역할 admin · 아바타 있음). 조직 B: 떠난 사람 X."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    ids: dict[str, uuid.UUID] = {}
    orgs = {}
    for key in ("a", "b"):
        org = Organization(id=uuid.uuid4(), name=f"Org {key}", slug=f"org-{uuid.uuid4().hex[:8]}")
        session.add(org)
        await session.commit()
        orgs[key] = org.id
    people = (
        ("caller", "a", "owner", "호출자", False),
        ("stayer", "a", "member", "남은 사람", False),
        ("departed", "a", "admin", "떠난 사람", True),
        ("other_departed", "b", "member", "다른 조직의 떠난 사람", True),
    )
    for key, org_key, role, name, left in people:
        uid = uuid.uuid4()
        session.add(User(id=uid, email=f"{key}-{uid.hex[:8]}@test.com", hashed_password="x", display_name=name))
        await session.commit()
        om = OrgMember(id=uuid.uuid4(), org_id=orgs[org_key], user_id=uid, role=role, deleted_at=_LEFT_AT if left else None)
        session.add(om)
        await session.commit()
        session.add(Member(
            id=om.id, org_id=orgs[org_key], type="human", user_id=uid, name=name, is_active=not left,
            avatar_url=f"https://example.test/{key}.png",
        ))
        await session.commit()
        ids[key] = om.id
        ids[f"{key}_user"] = uid
    return orgs, ids


async def _get(Session, orgs, ids, path: str):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(ids["caller_user"]), email="caller@test", claims={"app_metadata": {"org_id": str(orgs["a"])}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r = await client.get(path)
        assert r.status_code == 200, r.text
        return r.json()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_departed_member_names_only_with_include_inactive():
    """AC1 · AC2 — include_inactive면 떠난 D가 이름만 실려 온다(user_id · avatar null · role member · is_active false) · 다른 조직의
    떠난 X는 0 · 남은 사람 B 행은 그대로. 뮤테이션: 떠난 행 비우기를 빼면(옛 역할 · 아바타 · user_id 실림) RED."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            orgs, ids = await _seed(s)
        rows = await _get(Session, orgs, ids, "/api/v2/team-members?include_inactive=true")
        by_id = {r["id"]: r for r in rows}
        departed = by_id[str(ids["departed"])]
        assert (departed["name"], departed["type"], departed["is_active"]) == ("떠난 사람", "human", False)
        assert (departed["user_id"], departed["avatar_url"], departed["role"]) == (None, None, "member")
        assert "@" not in str(departed)
        assert str(ids["other_departed"]) not in by_id
        stayer = by_id[str(ids["stayer"])]
        assert (stayer["is_active"], stayer["user_id"]) == (True, str(ids["stayer_user"]))

        typed = await _get(Session, orgs, ids, "/api/v2/team-members?type=human&include_inactive=true")
        assert str(ids["departed"]) in {r["id"] for r in typed}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pickers_and_rosters_never_carry_departed_members():
    """AC3 — 고르기 목록 · 로스터 원천엔 떠난 사람이 없다: 기본 team-members · `type=agent&include_inactive=true`(에이전트 관리)
    · `/api/v2/members`. 뮤테이션: `include_departed`를 늘 켜면 기본 로스터에 D가 섞여 RED."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            orgs, ids = await _seed(s)
        departed = str(ids["departed"])
        for path in ("/api/v2/team-members", "/api/v2/team-members?type=agent&include_inactive=true", "/api/v2/members"):
            rows = await _get(Session, orgs, ids, path)
            items = rows["items"] if isinstance(rows, dict) and "items" in rows else rows
            seen = {str(r.get("id")) for r in items}
            assert departed not in seen, path
            # 공허 통과 방지 — 사람 목록인 두 원천은 남은 사람 B를 실제로 싣는다.
            if "type=agent" not in path:
                assert str(ids["stayer"]) in seen, (path, seen)
    finally:
        await engine.dispose()
