"""story #4376 — 사이드바 문서 트리는 한 번에(`GET /api/v2/docs?project_id&tree=true`) + meta.total.

dev: 트리가 층 구분 없는 평면 목록을 20개씩 받았다 — 정렬이 `(sort_order, id)`이고 sort_order 0이 거의 전부라 사실상 uuid 순.
1,065개 · 54쪽에서 방금 만든 문서 · 폴더가 뒤 쪽에 떨어져 새로고침 뒤 트리에서 사라졌고, 부모가 자기보다 뒤 쪽인 자식 37개는 부모가 올
때까지 안 보였다. 여기서는 실 PG · 진짜 JWT로 전 경로를 태워:
- 트리 요청 한 번에 프로젝트의 살아 있는 문서 전부(형제 30개 넘는 폴더 · 부모가 뒤에 정렬되는 자식 · 방금 만든 문서) + total —
  예전 기본 쪽 크기(500)보다 많은 600개를 두어 옛 코드(tree 무시 → 500개 · total 없음)에서 RED.
- 태그 필터도 같은 한 번에 + total.
- 상한을 넘는 갈래(잘 안 쓰여 썩기 쉬운 쪽 · PO 요청): 상한을 작게 두고 has_more · next_cursor · total(따로 셈)로 이어 받아 전부 · 중복 0.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]

N_DOCS = 600


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _uuid_after(floor: uuid.UUID) -> uuid.UUID:
    while True:
        u = uuid.uuid4()
        if u > floor:
            return u


async def _seed(s) -> dict:
    org, user, proj = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','O','o-{org.hex[:12]}','free')"))
    await s.execute(text(
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{user}','u{user.hex[:8]}@s4376.test','x','U',true,true,0,false,0)"
    ))
    await s.execute(text(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{org}','{user}','admin')"))
    await s.execute(text(f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{proj}','{org}','P','p-{proj.hex[:12]}','warn')"))
    # 폴더 하나에 자식 40개(한 쪽 20개보다 많은 형제) · 그 폴더 id는 자식들보다 **뒤**에 정렬되게(부모가 뒤 쪽인 옛 배치).
    child_ids = sorted(uuid.uuid4() for _ in range(40))
    folder = _uuid_after(child_ids[-1])
    rows = [(folder, None, "folder", "Folder", 0, "{}")]
    rows += [(cid, folder, "page", f"child {i}", 0, "{}") for i, cid in enumerate(child_ids)]
    tagged = []
    while len(rows) < N_DOCS - 2:
        did = uuid.uuid4()
        tag = "{spec}" if len(rows) % 7 == 0 else "{}"
        if tag != "{}":
            tagged.append(did)
        rows.append((did, None, "page", f"doc {len(rows)}", 0, tag))
    # 방금 만든 문서(가장 큰 uuid → 옛 평면 목록의 맨 끝) · 부모가 지워진 문서
    newest = _uuid_after(max(r[0] for r in rows))
    rows.append((newest, None, "page", "just created", 0, "{}"))
    gone_parent, orphan = uuid.uuid4(), uuid.uuid4()
    for did, parent, dtype, title, so, tags in rows:
        p = f"'{parent}'" if parent else "NULL"
        await s.execute(text(
            "INSERT INTO docs (id,org_id,project_id,parent_id,title,slug,sort_order,tags,doc_type) "
            f"VALUES ('{did}','{org}','{proj}',{p},:t,'d-{did.hex[:20]}',{so},'{tags}','{dtype}')"
        ), {"t": title})
    await s.execute(text(
        "INSERT INTO docs (id,org_id,project_id,title,slug,doc_type,deleted_at) "
        f"VALUES ('{gone_parent}','{org}','{proj}','gone','d-{gone_parent.hex[:20]}','folder',now())"
    ))
    await s.execute(text(
        "INSERT INTO docs (id,org_id,project_id,parent_id,title,slug,doc_type) "
        f"VALUES ('{orphan}','{org}','{proj}','{gone_parent}','orphan','d-{orphan.hex[:20]}','page')"
    ))
    await s.commit()
    return {"org": org, "user": user, "proj": proj, "folder": folder, "children": child_ids, "newest": newest,
            "orphan": orphan, "gone_parent": gone_parent, "tagged": tagged}


async def _cleanup(s, seeded) -> None:
    await s.execute(text(f"DELETE FROM docs WHERE org_id = '{seeded['org']}'"))
    await s.execute(text(f"DELETE FROM org_members WHERE org_id = '{seeded['org']}'"))
    await s.execute(text(f"DELETE FROM projects WHERE org_id = '{seeded['org']}'"))
    await s.execute(text(f"DELETE FROM organizations WHERE id = '{seeded['org']}'"))
    await s.execute(text(f"DELETE FROM users WHERE id = '{seeded['user']}'"))
    await s.commit()


async def _with_client(fn):
    from httpx import ASGITransport, AsyncClient

    import app.dependencies.auth as auth_module
    from app.core.security import create_access_token
    from app.main import app
    from tests.conftest import override_db_and_read

    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    saved = auth_module.async_session_factory
    auth_module.async_session_factory = Session

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)
    seeded = None
    try:
        async with Session() as s:
            seeded = await _seed(s)
        tok = create_access_token(str(seeded["user"]), email="u@s4376.test", app_metadata={"org_id": str(seeded["org"])})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            async def get(query: str):
                r = await c.get(f"/api/v2/docs?project_id={seeded['proj']}&{query}", headers={"Authorization": f"Bearer {tok}"})
                assert r.status_code == 200, r.text
                return r.json()
            await fn(get, seeded)
    finally:
        app.dependency_overrides.clear()
        auth_module.async_session_factory = saved
        if seeded is not None:
            async with Session() as s:
                await _cleanup(s, seeded)
        await eng.dispose()


async def test_tree_request_returns_the_whole_project_with_total():
    async def check(get, seeded):
        body = await get("tree=true")
        ids = {d["id"] for d in body["data"]}
        live = N_DOCS  # 살아 있는 문서 600(부모가 지워진 문서 포함 · 지워진 부모 자신은 제외)
        assert body["meta"] == {"has_more": False, "next_cursor": None, "total": live}
        assert len(body["data"]) == live
        # 방금 만든 문서 · 부모가 뒤에 정렬되는 폴더와 그 자식 40개 · 부모가 지워진 문서가 전부 한 번에
        assert str(seeded["newest"]) in ids
        assert str(seeded["folder"]) in ids and {str(c) for c in seeded["children"]} <= ids
        assert str(seeded["orphan"]) in ids and str(seeded["gone_parent"]) not in ids
        # 정렬 규약 그대로((sort_order, id))
        keys = [(d["sort_order"], d["id"]) for d in body["data"]]
        assert keys == sorted(keys)

    await _with_client(check)


async def test_tree_request_with_tag_filter_is_whole_too():
    async def check(get, seeded):
        body = await get("tree=true&tags=spec")
        assert {d["id"] for d in body["data"]} == {str(t) for t in seeded["tagged"]}
        assert body["meta"] == {"has_more": False, "next_cursor": None, "total": len(seeded["tagged"])}

    await _with_client(check)


async def test_projects_over_the_cap_continue_by_cursor_with_a_counted_total(monkeypatch):
    import app.routers.docs as docs_router

    monkeypatch.setattr(docs_router, "_TREE_CAP", 250)

    async def check(get, seeded):
        seen: list[str] = []
        body = await get("tree=true")
        pages = 0
        while True:
            pages += 1
            assert body["meta"]["total"] == N_DOCS  # 상한을 넘으면 따로 센 총량(쪽마다 같다)
            seen += [d["id"] for d in body["data"]]
            if not body["meta"]["has_more"]:
                break
            assert len(body["data"]) == 250 and body["meta"]["next_cursor"]
            body = await get(f"tree=true&cursor={body['meta']['next_cursor']}")
        assert pages == 3
        assert len(seen) == len(set(seen)) == N_DOCS
        assert str(seeded["newest"]) in seen

    await _with_client(check)
