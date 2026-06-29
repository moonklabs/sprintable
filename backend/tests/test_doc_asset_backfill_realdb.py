"""S4 Phase2 backfill — 실DB 통합(scan→put(mock)→register→rewrite). DB env 없으면 skip(CI alembic-fresh).

put_object/head_object 는 mock(합성 객체·실 GCS 없음). register(sync_attachment_assets reconcile=False)·
content rewrite·멱등·부분실패는 실DB로 검증.
"""
from __future__ import annotations

import base64
import os
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("b4000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("b4000000-0000-0000-0000-0000000000c1")
B64 = base64.b64encode(b"hello-bytes").decode()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _mock_storage(monkeypatch):
    prov = MagicMock()
    prov.put_object = AsyncMock(return_value=True)
    prov.head_object = AsyncMock(return_value=11)  # sync authoritative size(합성 객체)
    monkeypatch.setattr("app.services.storage.get_storage_provider", lambda: prov)
    return prov


async def _seed(s, content):
    doc_id = uuid.uuid4()
    for sql in [
        f"DELETE FROM asset_links WHERE org_id='{ORG}'",
        f"DELETE FROM assets WHERE org_id='{ORG}'",
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','B4','b4org','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
    ]:
        await s.execute(text(sql))
    await s.execute(text(
        "INSERT INTO docs (id,org_id,project_id,title,slug,content,content_format) "
        f"VALUES ('{doc_id}','{ORG}','{PROJ}','T','slug-{doc_id}',:c,'markdown')"
    ), {"c": content})
    await s.commit()
    return doc_id


def _file_node():
    return (f'<div data-type="fileAttachment" data-filename="a.pdf" data-size="11" '
            f'data-mime-type="application/pdf" data-file-data="data:application/pdf;base64,{B64}"></div>')


@pytest.mark.anyio
async def test_dry_run_counts_no_write():
    from app.services.doc_asset_backfill import backfill_doc
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            content = _file_node() + f"\n![cat](data:image/png;base64,{B64})"
            did = await _seed(s, content)
            r = await backfill_doc(s, doc_id=did, org_id=ORG, project_id=PROJ, content=content, apply=False)
            assert r["found"] == 2 and r["converted"] == 0
            # 쓰기 없음 — content/asset 불변.
            n_assets = (await s.execute(text(f"SELECT count(*) FROM assets WHERE org_id='{ORG}'"))).scalar_one()
            assert n_assets == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_converts_registers_rewrites_idempotent():
    from app.services.doc_asset_backfill import backfill_doc
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            content = _file_node() + f"\n![cat](data:image/png;base64,{B64})"
            did = await _seed(s, content)
            r = await backfill_doc(s, doc_id=did, org_id=ORG, project_id=PROJ, content=content, apply=True)
            await s.commit()
            assert r["found"] == 2 and r["converted"] == 2 and r["failed"] == 0
            new = (await s.execute(text(f"SELECT content FROM docs WHERE id='{did}'"))).scalar_one()
            assert "data:" not in new and "data-file-data" not in new  # base64 제거
            assert new.count("data-asset-id=") == 2  # ref 2개
            n_assets = (await s.execute(text(f"SELECT count(*) FROM assets WHERE org_id='{ORG}'"))).scalar_one()
            n_links = (await s.execute(text(
                f"SELECT count(*) FROM asset_links WHERE org_id='{ORG}' AND source_type='doc'"))).scalar_one()
            assert n_assets == 2 and n_links == 2
            # 멱등: 변환된 content 재처리 → 0.
            r2 = await backfill_doc(s, doc_id=did, org_id=ORG, project_id=PROJ, content=new, apply=True)
            assert r2["found"] == 0 and r2["converted"] == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_partial_failure_keeps_base64(_mock_storage):
    from app.services.doc_asset_backfill import backfill_doc
    _mock_storage.put_object = AsyncMock(side_effect=[True, False])  # 2번째 노드 put 실패
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            content = f"![a](data:image/png;base64,{B64})\n![b](data:image/jpeg;base64,{B64})"
            did = await _seed(s, content)
            r = await backfill_doc(s, doc_id=did, org_id=ORG, project_id=PROJ, content=content, apply=True)
            await s.commit()
            assert r["converted"] == 1 and r["failed"] == 1
            new = (await s.execute(text(f"SELECT content FROM docs WHERE id='{did}'"))).scalar_one()
            assert new.count("data-asset-id=") == 1 and new.count("data:image") == 1  # 실패 노드 base64 유지
    finally:
        await engine.dispose()
