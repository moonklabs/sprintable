"""B2(9f27af8f): retro 아이템 그룹핑(parent_item_id) + vote_count 근본수정 — realdb 실증.

핵심 3가지는 mock으로 증명 불가:
1. vote() 원자 +1이 실제로 vote_count를 정확히 유지하는지.
2. 그룹핑 시 vote 이관·dedupe·parent vote_count 재계산이 실 트랜잭션에서 맞는지.
3. **SAVEPOINT(begin_nested) 없이 IntegrityError를 catch하면 async 세션이 poison** 된다는
   이 레포의 기존 교훈(E-DG S3 P0-1)을 재현하지 않는지 — 실제 DB unique 제약 위반을
   결정론적으로 강제(이미 커밋된 투표에 pre-check 없이 직접 재-INSERT)해 vote()와 동일한
   begin_nested 패턴이 세션을 poison시키지 않는지 실증한다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("cc000000-0000-0000-0000-000000000001")
USER = uuid.UUID("cc000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("cc000000-0000-0000-0000-0000000000b1")
PROJ = uuid.UUID("cc000000-0000-0000-0000-0000000000c1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _seed_org_project(s):
    for sql in [
        f"DELETE FROM retro_votes WHERE item_id IN "
        f"(SELECT id FROM retro_items WHERE session_id IN "
        f"(SELECT id FROM retro_sessions WHERE org_id='{ORG}'))",
        f"DELETE FROM retro_items WHERE session_id IN (SELECT id FROM retro_sessions WHERE org_id='{ORG}')",
        f"DELETE FROM retro_sessions WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','CC','cc-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@cc.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_session_with_items(s, *, n_items: int = 1, category: str = "good"):
    from app.models.retro import RetroItem, RetroSession

    sess = RetroSession(id=uuid.uuid4(), org_id=ORG, project_id=PROJ, title="r", phase="vote")
    s.add(sess)
    await s.flush()
    items = []
    for i in range(n_items):
        item = RetroItem(id=uuid.uuid4(), session_id=sess.id, category=category, text=f"i{i}")
        s.add(item)
        items.append(item)
    await s.flush()
    await s.commit()
    return sess.id, [i.id for i in items]


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_vote_increments_vote_count_atomically():
    from app.repositories.retro import RetroVoteRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            session_id, [item_id] = await _seed_session_with_items(s)

        async with Session() as s:
            await RetroVoteRepository(s).vote(item_id, uuid.uuid4())
            await RetroVoteRepository(s).vote(item_id, uuid.uuid4())
            await s.commit()

        async with Session() as s:
            from app.models.retro import RetroItem
            item = (await s.execute(select(RetroItem).where(RetroItem.id == item_id))).scalar_one()
            assert item.vote_count == 2
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_duplicate_vote_rejected_and_count_unaffected():
    from app.repositories.retro import RetroVoteRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            session_id, [item_id] = await _seed_session_with_items(s)

        voter = uuid.uuid4()
        async with Session() as s:
            await RetroVoteRepository(s).vote(item_id, voter)
            await s.commit()

        async with Session() as s:
            with pytest.raises(ValueError, match="DUPLICATE_VOTE"):
                await RetroVoteRepository(s).vote(item_id, voter)

        async with Session() as s:
            from app.models.retro import RetroItem
            item = (await s.execute(select(RetroItem).where(RetroItem.id == item_id))).scalar_one()
            assert item.vote_count == 1
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_savepoint_prevents_session_poisoning_on_integrity_error():
    """SAVEPOINT(begin_nested) 없이 IntegrityError를 catch하면 async 세션이 poison되고 후속
    write가 PendingRollbackError로 죽는다는 이 레포 기존 교훈(E-DG S3 P0-1)을 정확히 재현하지
    않는지 직접 실증.

    asyncio.gather로 진짜 두 커넥션을 동시 INSERT시키면 Postgres가 두 번째 요청을 (에러가
    아니라) 첫 트랜잭션 커밋까지 **행(row-lock wait)**시켜 non-deterministic pytest 타임아웃
    위험이 있다 — 그래서 여기선 app-level pre-check를 의도적으로 우회해 실제 DB unique 제약
    위반을 **결정론적으로** 강제한다(이미 커밋된 투표에 대해 pre-check 없이 바로 INSERT를
    시도 → 실제 IntegrityError). `vote()` 안의 정확히 같은 begin_nested 패턴을 그대로 재사용해
    검증하므로 프로덕션 코드 경로와 동형이다."""
    from app.models.retro import RetroVote
    from app.repositories.retro import RetroVoteRepository
    from sqlalchemy.exc import IntegrityError

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            session_id, [item_id] = await _seed_session_with_items(s)

        voter = uuid.uuid4()
        async with Session() as s:
            # 정상 경로로 1표 커밋(이미 존재하는 투표를 실제로 만든다).
            await RetroVoteRepository(s).vote(item_id, voter)
            await s.commit()

        async with Session() as s:
            # app-level pre-check를 건너뛰고 vote()와 동일한 begin_nested 패턴만 직접 재현 —
            # 이미 커밋된 (item_id, voter) 쌍이라 unique 제약이 반드시 위반된다(결정론적).
            duplicate = RetroVote(item_id=item_id, voter_id=voter)
            with pytest.raises(IntegrityError):
                async with s.begin_nested():
                    s.add(duplicate)
                    await s.flush()

            # 핵심 실증: SAVEPOINT 덕에 세션이 poison 안 됐으면 이 커밋+후속 쿼리가 정상 동작.
            # (SAVEPOINT 없이 바깥 트랜잭션에서 바로 flush했다면 여기서 PendingRollbackError.)
            await s.commit()
            probe = await s.execute(text("SELECT 1"))
            assert probe.scalar() == 1

        async with Session() as s:
            from app.models.retro import RetroItem
            item = (await s.execute(select(RetroItem).where(RetroItem.id == item_id))).scalar_one()
            assert item.vote_count == 1  # 실패한 중복 삽입은 vote_count에 반영 안 됨
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_group_moves_votes_dedupes_and_recomputes_parent_count():
    from app.repositories.retro import RetroItemRepository, RetroVoteRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            session_id, item_ids = await _seed_session_with_items(s, n_items=2)
        parent_id, child_id = item_ids[0], item_ids[1]

        shared_voter = uuid.uuid4()
        only_parent_voter = uuid.uuid4()
        only_child_voter = uuid.uuid4()

        async with Session() as s:
            vr = RetroVoteRepository(s)
            await vr.vote(parent_id, shared_voter)
            await vr.vote(parent_id, only_parent_voter)
            await vr.vote(child_id, shared_voter)  # 중복(양쪽 투표) — dedupe 대상
            await vr.vote(child_id, only_child_voter)
            await s.commit()

        async with Session() as s:
            item_repo = RetroItemRepository(s)
            merged = await item_repo.group_under_parent(session_id, child_id, parent_id)
            await s.commit()
            assert merged.parent_item_id == parent_id
            assert merged.vote_count == 0

        async with Session() as s:
            from app.models.retro import RetroItem, RetroVote
            parent = (await s.execute(select(RetroItem).where(RetroItem.id == parent_id))).scalar_one()
            # parent 원 2표 + child only_child_voter 1표 이관 = 3(shared_voter 중복은 dedupe).
            assert parent.vote_count == 3
            votes = (
                await s.execute(select(RetroVote.voter_id).where(RetroVote.item_id == parent_id))
            ).scalars().all()
            assert set(votes) == {shared_voter, only_parent_voter, only_child_voter}
            child_votes = (
                await s.execute(select(RetroVote).where(RetroVote.item_id == child_id))
            ).scalars().all()
            assert child_votes == []  # child에는 vote row가 하나도 안 남아야
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_group_rejects_chain_and_self_and_category_mismatch():
    from app.repositories.retro import RetroItemRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            session_id, item_ids = await _seed_session_with_items(s, n_items=3, category="good")
        a, b, c = item_ids

        async with Session() as s:
            item_repo = RetroItemRepository(s)
            # a→self 금지.
            with pytest.raises(ValueError, match="ITEM_CANNOT_GROUP_UNDER_SELF"):
                await item_repo.group_under_parent(session_id, a, a)

            # b를 a 아래로 병합.
            await item_repo.group_under_parent(session_id, b, a)
            await s.commit()

        async with Session() as s:
            item_repo = RetroItemRepository(s)
            # c를 이미 child인 b 아래로 병합 시도 — b가 top-level 아니므로 거부(체인 방지).
            with pytest.raises(ValueError, match="PARENT_MUST_BE_TOP_LEVEL"):
                await item_repo.group_under_parent(session_id, c, b)

        # category 다른 item으로 체크.
        async with Session() as s:
            from app.models.retro import RetroItem
            other_cat = RetroItem(id=uuid.uuid4(), session_id=session_id, category="bad", text="x")
            s.add(other_cat)
            await s.flush()
            await s.commit()
            other_cat_id = other_cat.id

        async with Session() as s:
            item_repo = RetroItemRepository(s)
            with pytest.raises(ValueError, match="CATEGORY_MISMATCH"):
                await item_repo.group_under_parent(session_id, other_cat_id, a)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_get_session_hides_grouped_children_and_blocks_child_vote():
    from app.repositories.retro import RetroItemRepository, RetroSessionRepository
    from app.routers.retros import get_session, vote_item

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            session_id, item_ids = await _seed_session_with_items(s, n_items=2)
        parent_id, child_id = item_ids

        async with Session() as s:
            await RetroItemRepository(s).group_under_parent(session_id, child_id, parent_id)
            await s.commit()

        async with Session() as s:
            out = await get_session(
                id=session_id, db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG)
            )
            assert [i.id for i in out.items] == [parent_id]
            assert out.items[0].grouped_item_ids == [child_id]

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await vote_item(
                    id=session_id, item_id=child_id, voter_id=uuid.uuid4(),
                    db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG),
                )
            assert ei.value.status_code == 400
    finally:
        await eng.dispose()
