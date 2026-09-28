"""story #4299 — 한 요청이 내는 SQL 수 상한(보드 목록 · 글랜스 attention). 실 PG · 진짜 JWT로 의존성(인증 · project 스코프)까지 전 경로.

dev 실측(db_timing): GET /api/v2/stories 한 번에 SQL 24 · /glance/attention 17 — 행마다 도는 조회(N+1)는 없고 고정 비용이 두꺼웠다.
이번에 걷어낸 중복 읽기(사람 JWT 기준 stories 18 → 14 · attention 13 → 12):
- project 스코프: projects.org_id 조회와 has_project_access가 따로(단명 세션 둘) → `project_org_and_access` 한 SQL
- evidence gate_approval 전 행을 `_attach_has_evidence`와 trust 수집이 두 번 → 맵을 넘겨받음
- trust 수집이 이미 읽은 stories를 재조회 → 읽은 행을 넘겨받음
- org slug · project slug 두 번 → `resolve_org_and_project_slugs` 한 번
- attention의 story_activities max 두 번(in-review 진입 · 마지막 상태 변화) → 한 번

가드: 목록 행 10 → 100에서 SQL 수가 같다(N+1 0) · 수가 상한 이하다(위 중 하나라도 되돌리면 RED).
에이전트 키 요청은 응답 뒤 기록(tool_calls INSERT · agent_runs 조회)이 다음 요청의 창에 섞여 수가 흔들려 사람 JWT로 잰다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]

STORIES_SQL_MAX = 14
ATTENTION_SQL_MAX = 12


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s, n: int) -> dict:
    org, other_org, user, outsider = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    proj, other_proj = uuid.uuid4(), uuid.uuid4()
    agents = [uuid.uuid4() for _ in range(3)]
    stmts = [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','O','o-{org.hex[:12]}','free')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{other_org}','O2','o-{other_org.hex[:12]}','free')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{proj}','{org}','P','p-{proj.hex[:12]}','warn')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{other_proj}','{other_org}','P2','p-{other_proj.hex[:12]}','warn')",
    ]
    for uid, role in ((user, "admin"), (outsider, "member")):
        stmts.append(
            "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
            f"VALUES ('{uid}','u{uid.hex[:12]}@s4299.test','x','U',true,true,0,false,0)"
        )
        stmts.append(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{org}','{uid}','{role}')")
    for a in agents:
        stmts.append(f"INSERT INTO members (id,org_id,type,name) VALUES ('{a}','{org}','agent','A{a.hex[:6]}')")
        stmts.append(f"INSERT INTO agent_project_profiles (member_id,project_id) VALUES ('{a}','{proj}')")
    statuses = ["backlog", "ready-for-dev", "in-progress", "in-review", "done"]
    prev = None
    for i in range(n):
        sid = uuid.uuid4()
        a = agents[i % 3]
        stmts.append(
            f"INSERT INTO stories (id,org_id,project_id,title,status,priority,assignee_id) "
            f"VALUES ('{sid}','{org}','{proj}','S{i}','{statuses[i % 5]}','medium','{a}')"
        )
        stmts.append(f"INSERT INTO story_assignees (id,org_id,story_id,member_id) VALUES (gen_random_uuid(),'{org}','{sid}','{a}')")
        stmts.append(
            "INSERT INTO story_activities (story_id,org_id,project_id,activity_type,new_value,created_by,created_at) "
            f"VALUES ('{sid}','{org}','{proj}','status_changed','{statuses[i % 5]}','{a}',now() - interval '5 days')"
        )
        if i % 5 in (3, 4):
            etype = "gate_approval" if i % 2 else "pr"
            stmts.append(
                "INSERT INTO evidence (id,org_id,work_item_id,work_item_type,type,ref,created_by) "
                f"VALUES (gen_random_uuid(),'{org}','{sid}','story','{etype}','r{i}','{agents[1]}')"
            )
        if i % 5 == 3:
            stmts.append(
                "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,neutral_facts,status_entered_at,requires_human) "
                f"VALUES (gen_random_uuid(),'{org}','{sid}','story','merge','pending','{{}}',now(),true)"
            )
        if i % 5 == 2 and prev is not None:
            stmts.append(
                "INSERT INTO item_dependency (id,org_id,from_id,to_id,dep_type,item_type) "
                f"VALUES (gen_random_uuid(),'{org}','{prev}','{sid}','blocks','story')"
            )
        prev = sid
    for sql in stmts:
        await s.execute(text(sql))
    await s.commit()
    return {"org": org, "other_org": other_org, "user": user, "outsider": outsider, "proj": proj, "other_proj": other_proj}


async def _cleanup(s, seeded: dict) -> None:
    """시드한 행을 org id로 지운다(공유 parity DB를 더럽히지 않게 · 까디르 4758 리뷰). 자식 → 부모 순."""
    orgs = f"('{seeded['org']}','{seeded['other_org']}')"
    for table in ("story_activities", "evidence", "gate", "item_dependency", "story_assignees"):
        await s.execute(text(f"DELETE FROM {table} WHERE org_id IN {orgs}"))
    await s.execute(text(f"DELETE FROM agent_project_profiles WHERE member_id IN (SELECT id FROM members WHERE org_id IN {orgs})"))
    for table in ("stories", "members", "org_members", "projects"):
        await s.execute(text(f"DELETE FROM {table} WHERE org_id IN {orgs}"))
    await s.execute(text(f"DELETE FROM organizations WHERE id IN {orgs}"))
    await s.execute(text(f"DELETE FROM users WHERE id IN ('{seeded['user']}','{seeded['outsider']}')"))
    await s.commit()


async def _measure(n: int) -> dict:
    from httpx import ASGITransport, AsyncClient

    import app.dependencies.auth as auth_module
    from app.core.security import create_access_token
    from app.main import app
    from tests.conftest import override_db_and_read

    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    counting: list[str] | None = None

    @event.listens_for(eng.sync_engine, "before_cursor_execute")
    def _count(conn, cursor, statement, parameters, context, executemany):
        if counting is not None:
            counting.append(statement)

    saved_factory = auth_module.async_session_factory
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
            seeded = await _seed(s, n)

        def _h(uid):
            tok = create_access_token(str(uid), email="u@s4299.test", app_metadata={"org_id": str(seeded["org"])})
            return {"Authorization": f"Bearer {tok}"}

        out: dict = {"seeded": seeded}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            for name, path in (
                ("stories", f"/api/v2/stories?project_id={seeded['proj']}"),
                ("attention", f"/api/v2/glance/attention?project_id={seeded['proj']}"),
            ):
                await c.get(path, headers=_h(seeded["user"]))  # 컴파일 캐시 데우기
                counting = []
                r = await c.get(path, headers=_h(seeded["user"]))
                out[name] = (r.status_code, r.json(), len(counting))
                counting = None
            out["outsider"] = (await c.get(f"/api/v2/stories?project_id={seeded['proj']}", headers=_h(seeded["outsider"]))).status_code
            out["cross_org"] = (await c.get(f"/api/v2/stories?project_id={seeded['other_proj']}", headers=_h(seeded["user"]))).status_code
        return out
    finally:
        app.dependency_overrides.clear()
        auth_module.async_session_factory = saved_factory
        if seeded is not None:
            async with Session() as s:
                await _cleanup(s, seeded)
        await eng.dispose()


async def test_stories_list_sql_count_is_bounded_and_flat():
    few, many = await _measure(10), await _measure(100)
    (code_few, body_few, sql_few), (code_many, body_many, sql_many) = few["stories"], many["stories"]
    assert (code_few, len(body_few)) == (200, 10) and (code_many, len(body_many)) == (200, 100), "시드가 목록에 다 나와야 가드가 헛돌지 않는다"
    # 가드가 붙이기 경로(trust · evidence)를 실제로 태우는지 — 값이 비면 중복 제거를 되돌려도 수만 같아 보일 수 있다.
    assert any(item.get("human_verified") for item in body_many)
    assert {item.get("trust_stage") for item in body_many} >= {"queued", "running", "merge_ready"}
    assert sql_few == sql_many, f"행 10 → 100에서 SQL {sql_few} → {sql_many} — 행마다 조회가 붙었다(N+1)"
    assert sql_many <= STORIES_SQL_MAX, f"stories 목록 SQL {sql_many}개 > 상한 {STORIES_SQL_MAX} — 걷어낸 중복 읽기가 돌아왔다"


async def test_attention_sql_count_is_bounded_and_flat():
    few, many = await _measure(10), await _measure(100)
    (code_few, body_few, sql_few), (code_many, body_many, sql_many) = few["attention"], many["attention"]
    assert code_few == code_many == 200
    kinds = {item["kind"] for item in body_many["items"]}
    assert {"blocked", "merge_ready", "stalled"} <= kinds, f"신호가 다 나와야 가드가 헛돌지 않는다 — {kinds}"
    assert len(body_many["items"]) > len(body_few["items"])
    assert sql_few == sql_many, f"항목 {len(body_few['items'])} → {len(body_many['items'])}에서 SQL {sql_few} → {sql_many} — N+1"
    assert sql_many <= ATTENTION_SQL_MAX, f"attention SQL {sql_many}개 > 상한 {ATTENTION_SQL_MAX} — 걷어낸 중복 읽기가 돌아왔다"


async def test_merged_project_scope_check_still_denies():
    """org 조회 · 접근 판정을 한 SQL로 합친 뒤에도 거부가 그대로: 같은 org 비멤버(member 역할 · grant 없음) 403 ·
    다른 org 프로젝트 403."""
    out = await _measure(1)
    assert out["stories"][0] == 200
    assert out["outsider"] == 403
    assert out["cross_org"] == 403
