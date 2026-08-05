"""story #2459 prod 회귀 재현 — PO 2026-08-05: PATCH /stories/{id}가 MissingGreenlet 500으로
죽었다(prod rev 롤백). 기존 realdb 테스트는 전부 get_current_user를 dependency_overrides로
바이패스하거나(app.dependency_overrides[get_current_user] = ...) 라우터 함수를 직접 호출해서
(Depends() 그래프 자체를 안 탐) — get_current_user가 **실제로** 자기 단명 세션을 여닫는 전
과정이 handler의 get_db 세션과 같은 요청 안에서 실행되는 경로를 아무도 안 쟀다. 이 파일은
override 없이 진짜 Bearer JWT로 실제 get_current_user → get_project_scoped_org_id → handler
전체를 태워 그 경로를 고정한다.
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


async def _seed(session):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(
        id=user_id, email=f"s2459-{user_id.hex[:8]}@test.com", hashed_password="x",
        is_active=True, email_verified=True,
    )
    session.add(user)
    await session.commit()

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="admin"))
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Original title")
    session.add(story)
    await session.commit()

    return {"user_id": user_id, "org_id": org.id, "project_id": project.id, "story_id": story.id}


@pytest.mark.anyio
async def test_update_story_full_request_cycle_no_missing_greenlet(monkeypatch):
    """get_current_user는 override 안 함 — 진짜 Bearer JWT로 get_current_user/
    get_verified_org_id/get_project_scoped_org_id가 실제로 실행되고 StoryResponse.
    model_validate까지 200으로 완주해야 한다(#2459 prod 회귀: 여기서 MissingGreenlet 500이
    났었다). handler의 get_db만 오버라이드(기존 realdb 관례)하고, auth.py의 단명 세션
    (async_session_factory)은 같은 테스트 엔진으로 monkeypatch — 두 세션이 «다른 객체·같은
    물리 DB»로 동시에 살아있는 실제 prod 조건을 그대로 재현한다."""
    import app.dependencies.auth as auth_module
    from app.core.security import create_access_token
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from tests.conftest import override_db_and_read

    async_url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if async_url.startswith(prefix):
            async_url = "postgresql+asyncpg://" + async_url[len(prefix):]
            break

    # prod와 동형 조건 재현 — DB_PGBOUNCER=true 下 statement_cache_size=0(database.py
    # _build_engine_kwargs()와 동일). 이 값 없이는 pgbouncer transaction-mode 특유의
    # asyncpg 동작(연결 재사용 시 prepared-statement 캐시 불일치)이 안 재현된다.
    import os as _os
    _connect_args = {"statement_cache_size": 0} if _os.environ.get("DB_PGBOUNCER") == "true" else {}
    engine = create_async_engine(async_url, connect_args=_connect_args)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        seeded = await _seed(s)

    monkeypatch.setattr(auth_module, "async_session_factory", Session)

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)
    try:
        token = create_access_token(
            str(seeded["user_id"]), email="s2459@test.com",
            app_metadata={"org_id": str(seeded["org_id"])},
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.patch(
                f"/api/v2/stories/{seeded['story_id']}?project_id={seeded['project_id']}",
                json={"title": "Updated title"},
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Org-Id": str(seeded["org_id"]),
                    "X-Project-Id": str(seeded["project_id"]),
                },
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["title"] == "Updated title"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_story_concurrent_requests_no_missing_greenlet(monkeypatch):
    """동시성 재현 시도 — 여러 요청이 동시에 get_current_user 단명세션 + handler get_db 세션을
    같은 커넥션풀/엔진에서 동시에 여닫을 때 MissingGreenlet 이 뜨는지."""
    import asyncio

    import app.dependencies.auth as auth_module
    from app.core.security import create_access_token
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from tests.conftest import override_db_and_read

    async_url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if async_url.startswith(prefix):
            async_url = "postgresql+asyncpg://" + async_url[len(prefix):]
            break

    import os as _os
    _connect_args = {"statement_cache_size": 0} if _os.environ.get("DB_PGBOUNCER") == "true" else {}
    engine = create_async_engine(async_url, connect_args=_connect_args, pool_size=3, max_overflow=1)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    N = 20
    seeds = []
    async with Session() as s:
        for _ in range(N):
            seeds.append(await _seed(s))

    monkeypatch.setattr(auth_module, "async_session_factory", Session)

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)
    try:
        async def _one(seeded, i):
            token = create_access_token(
                str(seeded["user_id"]), email="s2459@test.com",
                app_metadata={"org_id": str(seeded["org_id"])},
            )
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.patch(
                    f"/api/v2/stories/{seeded['story_id']}",
                    json={"title": f"Updated title {i}"},
                    headers={"Authorization": f"Bearer {token}"},
                )
            return resp

        results = await asyncio.gather(*[_one(seeded, i) for i, seeded in enumerate(seeds)])
        failures = [(i, r.status_code, r.text[:500]) for i, r in enumerate(results) if r.status_code != 200]
        assert not failures, f"{len(failures)}/{N} failed:\n" + "\n".join(
            f"[{i}] {code}: {text}" for i, code, text in failures
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_story_with_slow_attachment_fetch_under_small_pool_no_missing_greenlet(monkeypatch):
    """prod 실사고 재구성 — 실패한 두 PATCH 모두 story에 첨부이미지가 딸려 있었고(같은 story의
    attachments/authorize 호출이 실패 직후 관측) latency가 평소(~0.2s) 대비 5~10배(1.1~1.5s)
    였다. update_story는 attachments 제공 시 repo.update() 前에 measure_image_dimensions()로
    실 스토리지 다운로드를 기다린다 — 그동안 handler의 get_db 커넥션은 아무 쿼리도 안 하면서
    체크아웃된 채로 오래 대기한다. prod DB_PGBOUNCER=true 下 앱사이드 풀은 pool_size=2/
    overflow=1(database.py _build_engine_kwargs 문서화값)로 아주 작다 — #2459가 요청당
    커넥션 개수를 늘린 상태(auth 단명세션 + handler 세션)에서, 여러 요청이 동시에 이 좁은
    풀을 다투면(그 중 하나가 첨부 fetch로 오래 붙잡고 있으면) 병목이 커진다. 이 조건을
    작은 풀 + 인위적 지연 + 동시 트래픽으로 재구성한다."""
    import asyncio

    import app.dependencies.auth as auth_module
    from app.core.security import create_access_token
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from tests.conftest import override_db_and_read

    async_url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if async_url.startswith(prefix):
            async_url = "postgresql+asyncpg://" + async_url[len(prefix):]
            break

    import os as _os
    _connect_args = {"statement_cache_size": 0} if _os.environ.get("DB_PGBOUNCER") == "true" else {}
    # prod와 동형 — DB_PGBOUNCER=true 下 pool_size=2, max_overflow=1(database.py 문서화값).
    engine = create_async_engine(async_url, connect_args=_connect_args, pool_size=2, max_overflow=1)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    N = 10
    seeds = []
    async with Session() as s:
        for _ in range(N):
            seeds.append(await _seed(s))

    monkeypatch.setattr(auth_module, "async_session_factory", Session)

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)

    # 실 스토리지 다운로드 대신 인위적 지연(~1s) — prod 실측 latency(1.1~1.5s)와 동형.
    async def _slow_measure(content_type, stored_url):
        await asyncio.sleep(1.0)
        return (800, 600)

    # update_story는 함수 내부에서 매번 `from app.services.image_dimensions import
    # measure_image_dimensions`로 지역 import하므로 소스 모듈 쪽을 패치해야 실제로 먹힌다.
    import app.services.image_dimensions as image_dimensions_module
    monkeypatch.setattr(image_dimensions_module, "measure_image_dimensions", _slow_measure)

    try:
        async def _patch_with_attachment(seeded, i):
            token = create_access_token(
                str(seeded["user_id"]), email="s2459@test.com",
                app_metadata={"org_id": str(seeded["org_id"])},
            )
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.patch(
                    f"/api/v2/stories/{seeded['story_id']}",
                    json={
                        "title": f"Updated {i}",
                        "attachments": [{
                            "url": f"https://storage.example.com/org/x/project/y/story/{seeded['story_id']}/img{i}.png",
                            "name": f"img{i}.png",
                            "content_type": "image/png",
                            "size": 12345,
                        }],
                    },
                    headers={"Authorization": f"Bearer {token}"},
                )
            return resp

        async def _plain_get(seeded):
            token = create_access_token(
                str(seeded["user_id"]), email="s2459@test.com",
                app_metadata={"org_id": str(seeded["org_id"])},
            )
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                return await client.get(
                    f"/api/v2/stories/{seeded['story_id']}",
                    headers={"Authorization": f"Bearer {token}"},
                )

        tasks = [_patch_with_attachment(seeded, i) for i, seeded in enumerate(seeds)]
        tasks += [_plain_get(seeded) for seeded in seeds]
        results = await asyncio.gather(*tasks)
        failures = [(i, r.status_code, r.text[:800]) for i, r in enumerate(results) if r.status_code != 200]
        assert not failures, f"{len(failures)}/{len(results)} failed:\n" + "\n".join(
            f"[{i}] {code}: {text}" for i, code, text in failures
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_story_survives_forced_attribute_expiry_before_serialize(monkeypatch):
    """메커니즘-재현(PO 요청, 2026-08-05) — 실 프로덕션 트리거는 광범위한 재현 시도(순차/동시
    요청·pgbouncer transaction-mode+statement_cache_size=0·소형 풀·느린 첨부-다운로드 시뮬
    레이션 전부 조합)에도 로컬에서 못 잡았다. 트리거를 몰라도 **증상 자체**(story.updated_at이
    model_validate 直前 unloaded 상태가 되면 500 대신 200으로 완주해야 한다)는 결정론적으로
    고정할 수 있다 — BaseRepository.update()의 refresh() 직후 강제로 session.expire(obj,
    ["updated_at"])를 걸어 "그 뒤 무언가가 다시 unload시킨다"는 실패조건을 재현한다.

    양성대조(2026-08-05 확認): 방어fix(model_validate 直前 명시 refresh) 적용 前엔 이 테스트가
    정확히 prod와 동일한 `MissingGreenlet ... updated_at` 500으로 실패했다 — fix 적용 後 200.
    """
    import app.dependencies.auth as auth_module
    from app.core.security import create_access_token
    from app.main import app
    from app.repositories.base import BaseRepository
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from tests.conftest import override_db_and_read

    async_url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if async_url.startswith(prefix):
            async_url = "postgresql+asyncpg://" + async_url[len(prefix):]
            break

    engine = create_async_engine(async_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        seeded = await _seed(s)

    monkeypatch.setattr(auth_module, "async_session_factory", Session)

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)

    # story #2459 회귀 정확 재현: update() 자체는 정상 동작(flush+refresh)하되, 그 *직후*
    # updated_at이 다시 unloaded 상태가 되는 경우를 강제한다.
    _orig_update = BaseRepository.update

    async def _update_then_expire(self, id, **data):
        obj = await _orig_update(self, id, **data)
        if obj is not None:
            self.session.expire(obj, ["updated_at"])
        return obj

    monkeypatch.setattr(BaseRepository, "update", _update_then_expire)

    try:
        token = create_access_token(
            str(seeded["user_id"]), email="s2459@test.com",
            app_metadata={"org_id": str(seeded["org_id"])},
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.patch(
                f"/api/v2/stories/{seeded['story_id']}",
                json={"title": "Forced-expire repro"},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200, resp.text
        assert resp.json()["title"] == "Forced-expire repro"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
