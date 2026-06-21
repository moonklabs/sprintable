"""E-DG S34: workflow line admin editor BE — version history list + draft in-place update.

핵심: ①GET /versions(scope+entity_type history·version desc) ②PATCH draft config in-place 갱신(editor 저장)
③⭐published 동결·draft 가변: status!='draft' 면 immutable(422)·draft 면 config_hash+lint 재계산 ④diff 는
FE-only(BE 무). 마이그0(WorkflowLineDefinitionVersion 재사용).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


_CFG = {"steps": [{"from_status": "backlog", "to_status": "ready", "mode": "auto"}]}


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_list_versions_scope_ordered():
    """scope+entity_type 의 전 버전 history(version desc)·다른 scope/entity 격리."""
    from app.services.workflow_line_config import create_draft, list_versions
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj = uuid.uuid4()
        for _ in range(3):
            await create_draft(s, org, proj, "story", _CFG, uuid.uuid4())
        # 다른 entity_type / scope 는 안 섞임
        await create_draft(s, org, proj, "doc", _CFG, uuid.uuid4())
        await create_draft(s, org, None, "story", _CFG, uuid.uuid4())  # org-scope
        await s.commit()
        rows = await list_versions(s, org, proj, "story")
        assert len(rows) == 3
        assert [r.version for r in rows] == [3, 2, 1]   # desc
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_update_draft_recomputes_hash_and_lint():
    """⭐draft config in-place 갱신(증식 아님)·config_hash+lint 재계산."""
    from app.services.workflow_line_config import create_draft, update_draft_config
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        v = await create_draft(s, org, None, "story", _CFG, uuid.uuid4())
        old_hash, old_ver = v.config_hash, v.version
        await s.commit()
        new_cfg = {"steps": [{"from_status": "in-review", "to_status": "done", "mode": "human"}]}
        updated = await update_draft_config(s, v, new_cfg)
        await s.commit()
        assert updated.id == v.id and updated.version == old_ver   # in-place(새 버전 아님)
        assert updated.config == new_cfg
        assert updated.config_hash != old_hash                     # hash 재계산
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_update_published_immutable_422():
    """⭐published/approved 등 non-draft 는 immutable → ValueError(수정=새 draft)."""
    from app.services.workflow_line_config import create_draft, update_draft_config
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        v = await create_draft(s, org, None, "story", _CFG, uuid.uuid4())
        v.status = "published"   # 동결 상태로
        await s.commit()
        with pytest.raises(ValueError, match="immutable|draft 만"):
            await update_draft_config(s, v, {"steps": []})
    await engine.dispose()


# ── 엔드포인트 게이팅(CI-runnable) ────────────────────────────────────────────
@pytest.mark.anyio
async def test_patch_endpoint_non_author_403():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import workflow_line_config as mod
    from app.routers.workflow_line_config import PatchDraftRequest, update_draft_version

    async def _deny(*a, **k):
        raise HTTPException(status_code=403, detail="admin required")

    with patch.object(mod, "_load_version", AsyncMock(return_value=SimpleNamespace(project_id=None))), \
         patch.object(mod, "_require_draft_author", _deny):
        with pytest.raises(HTTPException) as ei:
            await update_draft_version(
                version_id=uuid.uuid4(), body=PatchDraftRequest(config={"steps": []}),
                session=AsyncMock(), org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_list_endpoint_invalid_entity_type_422():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from fastapi import HTTPException
    from app.routers.workflow_line_config import list_versions_endpoint
    with pytest.raises(HTTPException) as ei:
        await list_versions_endpoint(
            entity_type="not_a_real_entity", project_id=None,
            session=AsyncMock(), org_id=uuid.uuid4(),
            auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 422


@pytest.mark.anyio
async def test_patch_endpoint_published_immutable_422():
    """⭐nit①(까심): 엔드포인트-레벨 immutability — published/approved version PATCH → 422
    (service ValueError 가 라우터서 422 로 전파·draft-only 가드 끝단 PIN)."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import workflow_line_config as mod
    from app.routers.workflow_line_config import PatchDraftRequest, update_draft_version

    async def _noop(*a, **k):
        return None

    pub = SimpleNamespace(project_id=None, status="published")
    with patch.object(mod, "_load_version", AsyncMock(return_value=pub)), \
         patch.object(mod, "_require_draft_author", _noop), \
         patch.object(mod, "update_draft_config",
                      AsyncMock(side_effect=ValueError("draft 만 수정 가능합니다 (published 는 immutable)"))):
        with pytest.raises(HTTPException) as ei:
            await update_draft_version(
                version_id=uuid.uuid4(), body=PatchDraftRequest(config={"steps": []}),
                session=AsyncMock(), org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 422


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_load_version_cross_org_404():
    """⭐nit②(까심): cross-org IDOR — 다른 org 의 version_id 로드 → 404(_load_version org_id 스코프)."""
    from app.services.workflow_line_config import create_draft
    from app.routers.workflow_line_config import _load_version
    from fastapi import HTTPException
    engine, Session = await _session()
    async with Session() as s:
        org_a, org_b = uuid.uuid4(), uuid.uuid4()
        v = await create_draft(s, org_a, None, "story", _CFG, uuid.uuid4())
        await s.commit()
        # 같은 org 는 로드 성공
        assert (await _load_version(s, org_a, v.id)).id == v.id
        # 다른 org 는 404(IDOR 차단)
        with pytest.raises(HTTPException) as ei:
            await _load_version(s, org_b, v.id)
        assert ei.value.status_code == 404
    await engine.dispose()
