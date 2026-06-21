"""E-DG S29 followup: GET /workflow-line-config/active — 좌-pane 데이터소스(현 published 라인 config)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_invalid_entity_type_422_unit():
    """entity_type 검증은 DB 전 — 미등록 타입 422(ENTITY_TYPES 가드)."""
    from app.models.workflow_line import ENTITY_TYPES
    assert "widget" not in ENTITY_TYPES
    assert "story" in ENTITY_TYPES


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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_active_line_returns_published_config():
    """활성 published 라인의 config(steps) 반환(엔진 헬퍼 재사용)."""
    from app.services.workflow_line_engine import _active_definition, _published_config
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story",
                                      name="L", is_active=True, version=1)
        s.add(defn)
        await s.flush()
        s.add(WorkflowLineDefinitionVersion(
            line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story", version=1,
            status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
            config={"rollout_mode": "shadow", "steps": [{"from_status": "a", "to_status": "b"}]}))
        await s.commit()
        d = await _active_definition(s, org, None, "story")
        assert d is not None
        cfg = await _published_config(s, d)
        assert cfg.get("steps") == [{"from_status": "a", "to_status": "b"}]
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_active_line_returns_none():
    """활성 라인 없으면 None(엔드포인트는 has_active=false)."""
    from app.services.workflow_line_engine import _active_definition
    engine, Session = await _session()
    async with Session() as s:
        assert await _active_definition(s, uuid.uuid4(), None, "story") is None
    await engine.dispose()
