"""E-SECURITY 스캐너 #6 서브시스템(story aa365768) — dependencies create/delete/list/graph
project-scope IDOR, 실 PG.

갭: dependency 서브시스템 전체가 project-blind였다(project_id 컬럼 없음·create/delete/list/graph
전부 org-scope만). caller가 접근권 없는 project의 아이템 간 의존성을 생성/삭제하거나(무단 mutation)
그 로스터/그래프를 열람(read exposure)할 수 있었다. fix: 아이템(epic/sprint/story)→project 해소 후
공통 게이트 — create/delete=양쪽 아이템(from+to) 접근권·list=조회 아이템 접근권·graph=응답을
caller-accessible project로 필터(사이클/그래프 계산은 org-wide 보존·설계의도 (a) cross-project 허용).
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


def _story(org_id, project_id, title):
    from app.models.pm import Story
    return Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)


async def _seed(session):
    """org(project_a[caller grant]·project_b[무접근]) + story a1/a2(project_a)·b1/b2(project_b) +
    dep_aa(a1→a2)·dep_bb(b1→b2). item_type=story."""
    from app.models.dependency import ItemDependency
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add_all([pa, pb])
    await session.commit()
    a1, a2, a3 = _story(org.id, pa.id, "A1"), _story(org.id, pa.id, "A2"), _story(org.id, pa.id, "A3")
    b1, b2 = _story(org.id, pb.id, "B1"), _story(org.id, pb.id, "B2")
    session.add_all([a1, a2, a3, b1, b2])
    await session.commit()
    dep_aa = ItemDependency(id=uuid.uuid4(), org_id=org.id, from_id=a1.id, to_id=a2.id, dep_type="blocks", item_type="story")
    dep_bb = ItemDependency(id=uuid.uuid4(), org_id=org.id, from_id=b1.id, to_id=b2.id, dep_type="blocks", item_type="story")
    session.add_all([dep_aa, dep_bb])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=pa.id, org_member_id=om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "caller_id": caller_id,
        "a1": a1.id, "a2": a2.id, "a3": a3.id, "b1": b1.id, "b2": b2.id,
        "dep_aa": dep_aa.id, "dep_bb": dep_bb.id,
    }


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


async def _dep_count(Session, dep_id):
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(
            text("SELECT count(*) FROM item_dependency WHERE id = :i"), {"i": dep_id}
        )).scalar_one()


# ── create ────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_dependency_own_project_201():
    """회귀0: project_a 아이템끼리 의존성 생성 → 201."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/dependencies", json={
                "from_id": str(seeded["a2"]), "to_id": str(seeded["a3"]),
                "dep_type": "blocks", "item_type": "story",
            })
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_dependency_cross_project_blocked_404():
    """봉인: 접근권 없는 project_b 아이템끼리 의존성 생성 시도 → 404(양쪽 무접근)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/dependencies", json={
                "from_id": str(seeded["b1"]), "to_id": str(seeded["b2"]),
                "dep_type": "blocks", "item_type": "story",
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_dependency_mixed_one_inaccessible_blocked_404():
    """봉인(양쪽-아이템 규칙·비-동어반복): from=접근O(a1)·to=접근X(b1) 혼합 → 404(한쪽만 무접근도
    차단). 반쪽 게이트였다면 통과했을 케이스."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/dependencies", json={
                "from_id": str(seeded["a1"]), "to_id": str(seeded["b1"]),
                "dep_type": "blocks", "item_type": "story",
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── delete ────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_delete_dependency_own_project_200():
    """회귀0: project_a 의존성 삭제 → 200."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/dependencies/{seeded['dep_aa']}")
            assert resp.status_code == 200, resp.text
            assert await _dep_count(Session, seeded["dep_aa"]) == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_dependency_cross_project_blocked_404_not_deleted():
    """봉인: 접근권 없는 project_b 의존성 삭제 시도 → 404 + **미삭제 직조회**."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/dependencies/{seeded['dep_bb']}")
            assert resp.status_code == 404, resp.text
            assert await _dep_count(Session, seeded["dep_bb"]) == 1, "cross-project 의존성이 삭제됨(IDOR)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── list ──────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_dependencies_cross_project_blocked_404():
    """봉인(read exposure): 접근권 없는 project_b 아이템의 의존성 로스터 조회 시도 → 404."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/dependencies?item_type=story&item_id={seeded['b1']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── update/PATCH (story #2258 AC3: 「수정」이지 「삭제 후 생성」이 아니다) ──────────

async def _dep_row(Session, dep_id):
    from sqlalchemy import text
    async with Session() as s:
        row = (await s.execute(
            text("SELECT id, created_at, dep_type FROM item_dependency WHERE id = :i"), {"i": dep_id}
        )).one_or_none()
        return None if row is None else {"id": row[0], "created_at": row[1], "dep_type": row[2]}


@pytest.mark.anyio
async def test_update_dependency_own_project_200_same_id_and_created_at():
    """AC3 본체: dep_type이 바뀌어도 id·created_at이 그대로다(같은 행 UPDATE — delete+create였다면
    created_at이 갱신되거나 id가 바뀌었을 것)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        before = await _dep_row(Session, seeded["dep_aa"])
        assert before["dep_type"] == "blocks"

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/dependencies/{seeded['dep_aa']}", json={"dep_type": "depends_on"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["dep_type"] == "depends_on"
        finally:
            await client.aclose()

        after = await _dep_row(Session, seeded["dep_aa"])
        assert after["id"] == before["id"], "id가 바뀜 — delete+create로 흉내낸 것"
        assert after["created_at"] == before["created_at"], "created_at이 바뀜 — delete+create로 흉내낸 것"
        assert after["dep_type"] == "depends_on"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_dependency_cross_project_blocked_404_not_changed():
    """봉인: 접근권 없는 project_b 의존성 PATCH 시도 → 404 + **미변경 직조회**."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/dependencies/{seeded['dep_bb']}", json={"dep_type": "depends_on"},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
        row = await _dep_row(Session, seeded["dep_bb"])
        assert row["dep_type"] == "blocks", "cross-project 의존성이 변경됨(IDOR)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_dependency_not_found_404():
    """존재하지 않는 id → 404(반쪽 게이트가 아니라 조회 자체가 없음)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/dependencies/{uuid.uuid4()}", json={"dep_type": "depends_on"},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_dependency_invalid_dep_type_422():
    """dep_type 화이트리스트 밖 값 → 422(생성 경로와 동일 검증)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/dependencies/{seeded['dep_aa']}", json={"dep_type": "not-a-type"},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── graph (AC3: 응답 필터·사이클 org-wide 보존) ─────────────────────────────────

@pytest.mark.anyio
async def test_dependency_graph_filters_inaccessible_project():
    """봉인(graph read-exposure·AC3): org-wide graph 조회 시 응답이 caller-accessible project로
    필터돼 접근권 없는 project_b의 노드(b1/b2)·엣지(dep_bb)가 노출되지 않는다. project_a 것만 보임."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/dependencies/graph?item_type=story")
            assert resp.status_code == 200, resp.text
            body = resp.text
            # project_b 노드는 응답 바디에 verbatim 미노출.
            assert str(seeded["b1"]) not in body, "graph가 접근권 없는 project 노드 노출(exposure)"
            assert str(seeded["b2"]) not in body
            # project_a 노드는 보임(회귀0).
            data = resp.json()
            node_strs = {str(n) for n in data["nodes"]}
            assert str(seeded["a1"]) in node_strs and str(seeded["a2"]) in node_strs
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── locale(story #3786 — 공용 i18n 카탈로그 슬라이스 1) ─────────────────────────
# 카디르 판정 기준: "치환한 자리에 Accept-Language: en 요청 시 en detail이 실제로 내려오는
# 통합 테스트(양성대조: ko 요청은 ko)". 실 영문 문장이 아니라 "요청 로케일에 따라 카탈로그가
# 실제로 갈린다"를 검증한다 — en 문장 자체는 유나 定(PENDING이어도 이 테스트는 무변으로
# 통과해야 한다, 값이 무엇이든 ko와 달라야 한다는 것만 본다).


@pytest.mark.anyio
async def test_update_dependency_not_found_detail_follows_accept_language_ko():
    from app.main import app
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/dependencies/{uuid.uuid4()}", json={"dep_type": "depends_on"},
                headers={"Accept-Language": "ko"},
            )
            assert resp.status_code == 404, resp.text
            assert resp.json()["error"]["message"] == t("dependencies.not_found", "ko")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_dependency_not_found_detail_follows_accept_language_en():
    """⭐양성대조 — en 요청은 en 카탈로그 값(ko와 다른 값)을 받는다. 되돌리면(라우트가 로케일을
    무시하고 ko를 고정 반환하면) 이 테스트가 실패한다(뮤테이션 자리 — PR CHANGES 라운드에서
    Accept-Language 배선 자체를 지워 실측 확認할 것)."""
    from app.main import app
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/dependencies/{uuid.uuid4()}", json={"dep_type": "depends_on"},
                headers={"Accept-Language": "en"},
            )
            assert resp.status_code == 404, resp.text
            detail = resp.json()["error"]["message"]
            assert detail == t("dependencies.not_found", "en")
            assert detail != t("dependencies.not_found", "ko"), (
                "en 요청인데 ko와 같은 문구가 내려옴 — 로케일 배선이 실제로 안 먹히고 있다."
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── explicit code(story #3786, 유나 定 §2) — FE story-detail-panel.tsx:750이 예전엔
# message 문자열에서 "사이클"을 찾아 cycle/self-reference를 갈랐다. en 로케일 착지가 그
# 반창고를 깨므로(en message엔 "사이클"이 없음) BE가 explicit code를 실어 FE가 그 code로
# 가르게 한다 — 아래는 그 code가 실제로 내려오는지 봉인.

@pytest.mark.anyio
async def test_create_dependency_self_reference_has_explicit_code():
    from app.main import app
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/dependencies", json={
                "from_id": str(seeded["a3"]), "to_id": str(seeded["a3"]),
                "dep_type": "blocks", "item_type": "story",
            })
            assert resp.status_code == 422, resp.text
            error = resp.json()["error"]
            assert error["code"] == "DEPENDENCY_SELF_REFERENCE"
            assert error["message"] == t("dependencies.self_reference_not_allowed", "ko")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_dependency_cycle_has_explicit_code():
    """⭐dep_aa(a1→a2)가 이미 있는 상태에서 역방향(a2→a1)을 걸면 cycle — code로 갈린다."""
    from app.main import app
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/dependencies", json={
                "from_id": str(seeded["a2"]), "to_id": str(seeded["a1"]),
                "dep_type": "blocks", "item_type": "story",
            })
            assert resp.status_code == 422, resp.text
            error = resp.json()["error"]
            assert error["code"] == "DEPENDENCY_CYCLE"
            assert error["message"] == t("dependencies.cycle_not_allowed", "ko")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_dependency_cycle_en_message_has_no_korean_word(
):
    """story #3786(유나 定 §2·확인 축2) — en Accept-Language로 사이클을 실제로 일으켰을 때
    응답 message에 한글 "사이클" 낱말이 없어야 한다(문자열 매칭 반창고를 code로 갈아탄
    증거 — 예전 FE는 이 문자열에 의존했다). code 자체는 로케일 무관 상수."""
    from app.main import app
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/dependencies",
                json={
                    "from_id": str(seeded["a2"]), "to_id": str(seeded["a1"]),
                    "dep_type": "blocks", "item_type": "story",
                },
                headers={"Accept-Language": "en"},
            )
            assert resp.status_code == 422, resp.text
            error = resp.json()["error"]
            assert error["code"] == "DEPENDENCY_CYCLE"
            assert error["message"] == t("dependencies.cycle_not_allowed", "en")
            assert "사이클" not in error["message"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
