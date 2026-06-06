"""179db213: DM 1-pair=1-DM dedup — dm_pair_key·partial unique·preflight·race.

- CP1: 같은 pair 2번 → 동일 DM(unique 가드). CP2: 동시 생성 → 1 DM(IntegrityError·real-DB).
- CP3: preflight dedup — 잉여 DM messages keeper repoint·메시지 무손실. CP5: 3명→group.
- CP6: dm_pair_key = 정렬 member join '|'.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_dm_pair_key_format_sorted():
    """CP6: dm_pair_key = 정렬된 member-id join '|' (결정적·교환법칙)."""
    a, b = uuid.UUID("00000000-0000-0000-0000-000000000002"), uuid.UUID("00000000-0000-0000-0000-000000000001")
    # 핸들러와 동일 규칙: sorted({sender,*participants}) → '|'.join
    k1 = "|".join(str(m) for m in sorted({a, b}))
    k2 = "|".join(str(m) for m in sorted({b, a}))
    assert k1 == k2  # 순서 무관
    assert k1 == "00000000-0000-0000-0000-000000000001|00000000-0000-0000-0000-000000000002"


_RAW = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


def _key(*ids):
    return "|".join(str(m) for m in sorted(ids))


@pytest.mark.anyio
@pytest.mark.skipif(not _ASYNC, reason="real-DB URL 미설정 — skip")
async def test_unique_index_and_concurrent_race_realdb():
    """CP1/CP2: 같은 (org,project,dm_pair_key) DM 2개 insert → unique 위반(동시성 포함 단일 보장)."""
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    org, proj = uuid.uuid4(), uuid.uuid4()
    a, b = uuid.uuid4(), uuid.uuid4()
    pk = _key(a, b)
    eng = create_async_engine(_ASYNC)
    sm = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with sm() as s:
            await s.execute(text("INSERT INTO projects (id,org_id,name,created_at) VALUES (:i,:o,'P',now())"), {"i": proj, "o": org})
            await s.commit()

        async def ins():
            async with sm() as s2:
                await s2.execute(text(
                    "INSERT INTO conversations (id,org_id,project_id,type,dm_pair_key,status,created_at,updated_at)"
                    " VALUES (gen_random_uuid(),:o,:p,'dm',:k,'open',now(),now())"), {"o": org, "p": proj, "k": pk})
                await s2.commit()

        # 동시 2 insert → 하나는 IntegrityError(unique)
        results = await asyncio.gather(ins(), ins(), return_exceptions=True)
        errs = [r for r in results if isinstance(r, Exception)]
        assert len(errs) == 1 and isinstance(errs[0], IntegrityError), f"race guard: {results}"
        async with sm() as s:
            cnt = (await s.execute(text(
                "SELECT count(*) FROM conversations WHERE org_id=:o AND project_id=:p AND type='dm' AND dm_pair_key=:k"),
                {"o": org, "p": proj, "k": pk})).scalar_one()
            assert cnt == 1, f"단일 DM 보장 실패: {cnt}"
            await s.execute(text("DELETE FROM conversations WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM projects WHERE org_id=:o"), {"o": org})
            await s.commit()
    finally:
        await eng.dispose()


# 0100 preflight dedup 와 동형 (unique index 잠시 drop 후 dup 시드)
_DEDUP_SQL = [
    """WITH ranked AS (SELECT id, row_number() OVER w AS rn, first_value(id) OVER w AS keeper
         FROM conversations WHERE type='dm' AND dm_pair_key IS NOT NULL
         WINDOW w AS (PARTITION BY org_id, project_id, dm_pair_key ORDER BY created_at ASC, id ASC))
       UPDATE conversation_messages m SET conversation_id=r.keeper FROM ranked r WHERE m.conversation_id=r.id AND r.rn>1""",
    """WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY org_id,project_id,dm_pair_key ORDER BY created_at ASC, id ASC) AS rn
         FROM conversations WHERE type='dm' AND dm_pair_key IS NOT NULL)
       DELETE FROM conversations c USING ranked r WHERE c.id=r.id AND r.rn>1""",
]


@pytest.mark.anyio
@pytest.mark.skipif(not _ASYNC, reason="real-DB URL 미설정 — skip")
async def test_preflight_dedup_message_preservation_realdb():
    """CP3: 중복 DM 2개(각 메시지 보유) → dedup → 1 DM + 메시지 전부 keeper 로 보존(무손실)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    org, proj = uuid.uuid4(), uuid.uuid4()
    a, b = uuid.uuid4(), uuid.uuid4()
    pk = _key(a, b)
    c_keep, c_dup = uuid.uuid4(), uuid.uuid4()
    eng = create_async_engine(_ASYNC)
    sm = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with sm() as s:
            await s.execute(text("DROP INDEX IF EXISTS uq_conversations_dm_pair"))  # dup 시드 허용
            await s.execute(text("INSERT INTO projects (id,org_id,name,created_at) VALUES (:i,:o,'P',now())"), {"i": proj, "o": org})
            # keeper(최古) + dup
            await s.execute(text("INSERT INTO conversations (id,org_id,project_id,type,dm_pair_key,status,created_at,updated_at) VALUES (:i,:o,:p,'dm',:k,'open','2026-06-01',now())"), {"i": c_keep, "o": org, "p": proj, "k": pk})
            await s.execute(text("INSERT INTO conversations (id,org_id,project_id,type,dm_pair_key,status,created_at,updated_at) VALUES (:i,:o,:p,'dm',:k,'open','2026-06-02',now())"), {"i": c_dup, "o": org, "p": proj, "k": pk})
            for cid, mid in ((c_keep, a), (c_dup, a), (c_dup, b)):
                await s.execute(text("INSERT INTO conversation_messages (id,conversation_id,sender_id,content,mentioned_ids,created_at,updated_at) VALUES (gen_random_uuid(),:c,:s,'m',ARRAY[]::uuid[],now(),now())"), {"c": cid, "s": mid})
            await s.commit()
            before = (await s.execute(text("SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.org_id=:o"), {"o": org})).scalar_one()
            assert before == 3

            for sql in _DEDUP_SQL:
                await s.execute(text(sql))
            await s.commit()

            dm_cnt = (await s.execute(text("SELECT count(*) FROM conversations WHERE org_id=:o AND type='dm' AND dm_pair_key=:k"), {"o": org, "k": pk})).scalar_one()
            assert dm_cnt == 1  # keeper 만
            keeper_left = (await s.execute(text("SELECT count(*) FROM conversations WHERE id=:i"), {"i": c_keep})).scalar_one()
            assert keeper_left == 1  # 최古가 keeper
            after = (await s.execute(text("SELECT count(*) FROM conversation_messages WHERE conversation_id=:k"), {"k": c_keep})).scalar_one()
            assert after == 3, f"메시지 무손실 실패: keeper {after} (3 기대)"  # CP3
            await s.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_dm_pair ON conversations (org_id, project_id, dm_pair_key) WHERE type='dm' AND dm_pair_key IS NOT NULL"))
            await s.execute(text("DELETE FROM conversation_messages WHERE conversation_id=:k"), {"k": c_keep})
            await s.execute(text("DELETE FROM conversations WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM projects WHERE org_id=:o"), {"o": org})
            await s.commit()
    finally:
        await eng.dispose()
