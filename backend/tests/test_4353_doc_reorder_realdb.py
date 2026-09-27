"""story #4353 — 문서 순서를 한 트랜잭션으로(`POST /api/v2/docs/reorder {doc_id, parent_id, after_id?}`).

예전 `PATCH /{id} {sort_order}`는 그 한 문서 값만 바꿔 형제 번호가 0 동률(dev 1,305개 중 1,295개)이면 끌어도 순서가 안 바뀌었다.
시드: project A(부르는 사람 접근) · B(접근 없음). A 최상위에 sort_order 전부 0인 형제 넷(dev 현실), 폴더 F 밑 자식 하나.
"""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import select

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
    from app.models.doc import Doc
    from app.models.organization import Organization
    from app.models.project import Project

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
            _member_id, member_user = await _make_member(s, org.id, pa.id)
            ids = sorted(uuid.uuid4() for _ in range(4))  # id 순 = 동률일 때 보이는 순서
            for i, doc_id in enumerate(ids):
                s.add(Doc(id=doc_id, org_id=org.id, project_id=pa.id, title=f"d{i}", slug=f"d{i}-{doc_id.hex[:6]}", sort_order=0))
            folder, child = uuid.uuid4(), uuid.uuid4()
            s.add(Doc(id=folder, org_id=org.id, project_id=pa.id, title="F", slug=f"f-{folder.hex[:6]}", sort_order=0))
            await s.commit()
            s.add(Doc(id=child, org_id=org.id, project_id=pa.id, parent_id=folder, title="c", slug=f"c-{child.hex[:6]}", sort_order=0))
            other = uuid.uuid4()
            s.add(Doc(id=other, org_id=org.id, project_id=pb.id, title="B-doc", slug=f"b-{other.hex[:6]}", sort_order=0))
            await s.commit()
        yield Session, {"org": org.id, "pa": pa.id, "user": member_user, "ids": ids, "folder": folder, "child": child, "other": other}
    finally:
        await engine.dispose()


async def _post(Session, seeded, body):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(seeded["user"]), email="h@test",
            claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            return await c.post("/api/v2/docs/reorder", json={k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in body.items()})
    finally:
        app.dependency_overrides.clear()


async def _children(Session, project_id, parent_id):
    """새 세션에서 목록 정렬 그대로((sort_order, id)) 다시 읽는다."""
    from app.models.doc import Doc

    async with Session() as s:
        cond = Doc.parent_id.is_(None) if parent_id is None else Doc.parent_id == parent_id
        rows = (await s.execute(
            select(Doc.id, Doc.sort_order).where(Doc.project_id == project_id, cond, Doc.deleted_at.is_(None)).order_by(Doc.sort_order, Doc.id)
        )).all()
    return [r.id for r in rows], [r.sort_order for r in rows]


async def test_tied_siblings_reorder_sticks_after_reload():
    """AC2 · AC3 — 전원 0 동률에서 맨 뒤 문서를 맨 앞으로: 새 세션에서 그 순서 · 번호 0..n-1(중복 0).
    뮤테이션: 형제 번호를 안 다시 매기고 옮긴 문서만 바꾸면(예전 PATCH 방식) 새로고침 순서가 id 순으로 돌아가 RED."""
    async with _world() as (Session, seeded):
        top_before, _ = await _children(Session, seeded["pa"], None)
        moving = seeded["ids"][-1]
        r = await _post(Session, seeded, {"doc_id": moving, "parent_id": None, "after_id": None})
        assert r.status_code == 200, r.text
        order, numbers = await _children(Session, seeded["pa"], None)
        assert order[0] == moving
        assert order[1:] == [d for d in top_before if d != moving]
        assert numbers == list(range(len(order)))
        assert [s["id"] for s in r.json()["siblings"]] == [str(d) for d in order]


async def test_after_id_places_right_behind_and_omitted_means_end():
    async with _world() as (Session, seeded):
        a, b, c, d = seeded["ids"]
        r = await _post(Session, seeded, {"doc_id": a, "parent_id": None, "after_id": c})
        assert r.status_code == 200, r.text
        order, _ = await _children(Session, seeded["pa"], None)
        assert order.index(a) == order.index(c) + 1
        r = await _post(Session, seeded, {"doc_id": b, "parent_id": None})  # after_id 생략 = 맨 끝
        assert r.status_code == 200, r.text
        order, _ = await _children(Session, seeded["pa"], None)
        assert order[-1] == b


async def test_move_into_folder_and_cycle_refused():
    async with _world() as (Session, seeded):
        a = seeded["ids"][0]
        r = await _post(Session, seeded, {"doc_id": a, "parent_id": seeded["folder"]})
        assert r.status_code == 200, r.text
        kids, numbers = await _children(Session, seeded["pa"], seeded["folder"])
        assert kids == [seeded["child"], a] and numbers == [0, 1]
        top, _ = await _children(Session, seeded["pa"], None)
        assert a not in top
        # 폴더를 자기 자식 밑으로 — 순환.
        r = await _post(Session, seeded, {"doc_id": seeded["folder"], "parent_id": seeded["child"]})
        assert r.status_code == 400 and r.json()["error"]["code"] == "DOC_REORDER_CYCLE", r.text
        r = await _post(Session, seeded, {"doc_id": a, "parent_id": a})
        assert r.status_code == 400, r.text


async def test_anchor_not_a_sibling_is_409_and_nothing_changes():
    async with _world() as (Session, seeded):
        before = await _children(Session, seeded["pa"], None)
        r = await _post(Session, seeded, {"doc_id": seeded["ids"][0], "parent_id": None, "after_id": seeded["child"]})
        assert r.status_code == 409 and r.json()["error"]["code"] == "DOC_REORDER_ANCHOR_NOT_SIBLING", r.text
        assert await _children(Session, seeded["pa"], None) == before


async def test_other_project_is_404_like_missing():
    async with _world() as (Session, seeded):
        for body in (
            {"doc_id": seeded["other"], "parent_id": None},  # 접근 없는 프로젝트의 문서
            {"doc_id": seeded["ids"][0], "parent_id": seeded["other"]},  # 다른 프로젝트 부모
            {"doc_id": seeded["ids"][0], "parent_id": None, "after_id": seeded["other"]},  # 다른 프로젝트 앵커
            {"doc_id": uuid.uuid4(), "parent_id": None},
        ):
            r = await _post(Session, seeded, body)
            assert r.status_code == 404, (body, r.text)


async def test_concurrent_reorders_leave_no_duplicate_or_missing_numbers():
    """AC3 — 같은 형제 묶음에 동시 두 재정렬 → 번호 0..n-1 · 중복 0 · 누락 0.
    (in-process 요청 둘은 실제로 겹치지 않아 잠금을 빼도 이 테스트는 초록 — 잠금 유무는 아래 `test_reorder_waits_on_the_sibling_lock`이 가른다.)"""
    async with _world() as (Session, seeded):
        a, b, c, d = seeded["ids"]
        for _ in range(5):
            r1, r2 = await asyncio.gather(
                _post(Session, seeded, {"doc_id": a, "parent_id": None, "after_id": d}),
                _post(Session, seeded, {"doc_id": d, "parent_id": None, "after_id": None}),
            )
            assert r1.status_code == 200 and r2.status_code == 200, (r1.text, r2.text)
            order, numbers = await _children(Session, seeded["pa"], None)
            assert sorted(numbers) == list(range(len(order))), numbers
            assert len(set(order)) == len(order) == 5


async def test_reorder_does_not_touch_updated_at():
    """형제를 다시 매겨도 `updated_at`은 그대로 — 그 문서를 편집 중인 사람에게 거짓 DOC_CONFLICT가 나지 않게."""
    from app.models.doc import Doc

    async with _world() as (Session, seeded):
        async with Session() as s:
            before = dict((await s.execute(select(Doc.id, Doc.updated_at).where(Doc.project_id == seeded["pa"]))).all())
        r = await _post(Session, seeded, {"doc_id": seeded["ids"][2], "parent_id": None, "after_id": None})
        assert r.status_code == 200, r.text
        async with Session() as s:
            after = dict((await s.execute(select(Doc.id, Doc.updated_at).where(Doc.project_id == seeded["pa"]))).all())
        assert after == before


async def test_reorder_waits_on_the_sibling_lock():
    """동시 재정렬의 번호 겹침을 막는 것은 형제 묶음 잠금(프로젝트 + 부모 키 advisory lock)이다 — 같은 잠금을 다른 거래가 쥐고 있으면
    재정렬은 기다렸다가, 풀리면 끝난다(결정적 대조 · in-process 요청 둘로는 경합이 안 나 위 반복 테스트만으로는 잠금 유무를 못 가른다).
    뮤테이션: 잠금을 빼면 쥐고 있는 동안에도 요청이 끝나 RED."""
    from sqlalchemy import text

    async with _world() as (Session, seeded):
        async with Session() as holder:
            await holder.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"doc-siblings:{seeded['pa']}:root"})
            task = asyncio.create_task(_post(Session, seeded, {"doc_id": seeded["ids"][3], "parent_id": None, "after_id": None}))
            await asyncio.sleep(1.0)
            assert not task.done(), "잠금을 쥐고 있는데 재정렬이 끝났다 — 형제 묶음 잠금이 없다"
            await holder.commit()  # 거래 끝 = 잠금 해제
        r = await asyncio.wait_for(task, timeout=10)
        assert r.status_code == 200, r.text


async def test_two_crossing_moves_cannot_make_a_cycle():
    """까디르(4736 P2) — «A를 B 밑» · «B를 A 밑»이 동시에 와도 순환 0 · 하나는 400.
    엇갈림을 결정적으로 만든다: 테스트가 두 새 부모 묶음 잠금을 쥔 채 두 이동을 동시에 시작하고, 둘 다 묶음 잠금 앞까지 온 뒤 풀어 준다.
    고친 코드는 부모가 바뀌는 이동이 프로젝트 잠금을 먼저 잡고 그 안에서 순환을 보므로 둘째가 첫째의 커밋을 보고 400.
    뮤테이션: 프로젝트 잠금을 빼면 둘 다 순환 검사를 통과한 채 묶음 잠금에서 기다리다 풀리면 둘 다 커밋 → A ↔ B 순환으로 RED."""
    from sqlalchemy import text

    from app.models.doc import Doc

    async with _world() as (Session, seeded):
        a, b = seeded["ids"][0], seeded["ids"][1]
        async with Session() as holder:
            for parent in (a, b):
                await holder.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"doc-siblings:{seeded['pa']}:{parent}"})
            t1 = asyncio.create_task(_post(Session, seeded, {"doc_id": a, "parent_id": b}))
            t2 = asyncio.create_task(_post(Session, seeded, {"doc_id": b, "parent_id": a}))
            await asyncio.sleep(1.0)
            await holder.commit()
        r1, r2 = await asyncio.wait_for(asyncio.gather(t1, t2), timeout=15)
        assert sorted([r1.status_code, r2.status_code]) == [200, 400], (r1.text, r2.text)
        async with Session() as s:
            parents = dict((await s.execute(select(Doc.id, Doc.parent_id).where(Doc.id.in_([a, b])))).all())
        assert not (parents[a] == b and parents[b] == a), f"A ↔ B 순환이 커밋됐다: {parents}"
