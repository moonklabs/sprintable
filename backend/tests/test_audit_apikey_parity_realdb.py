"""f5ee8387 H2 audit (b) parity — anchor≠legacy 해소 드리프트 적출 검증. DB env 없으면 skip(CI alembic-fresh).

핵심 리스크: 멀티프로젝트 agent 의 cut-on 기본 프로젝트가 legacy(team_members ORDER BY project_id)와
anchor(agent_project_profiles ORDER BY created_at)서 갈릴 수 있다. PARITY_SQL 이 그 드리프트를 잡는지 락.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from scripts.jobs.audit_apikey_member_anchor import PARITY_SQL

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("a5000000-0000-0000-0000-000000000001")
# P1 < P2 (legacy ORDER BY project_id → P1 선택)
P1 = uuid.UUID("a5000000-0000-0000-0000-0000000000a1")
P2 = uuid.UUID("a5000000-0000-0000-0000-0000000000b2")
M_DIVERGE = uuid.UUID("a5000000-0000-0000-0000-0000000000d1")  # 멀티프로젝트·드리프트
M_OK = uuid.UUID("a5000000-0000-0000-0000-0000000000e1")       # 단일프로젝트·일치


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s):
    for sql in [
        f"DELETE FROM agent_api_keys WHERE member_id IN ('{M_DIVERGE}','{M_OK}')",
        f"DELETE FROM agent_project_profiles WHERE member_id IN ('{M_DIVERGE}','{M_OK}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A5','a5org','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{P1}','{ORG}','P1'),('{P2}','{ORG}','P2')",
        "INSERT INTO members (id,org_id,type,name,is_active) VALUES "
        f"('{M_DIVERGE}','{ORG}','agent','Diverge',true),('{M_OK}','{ORG}','agent','Ok',true)",
        # M_DIVERGE: P2 프로파일이 더 일찍 생성(anchor=created_at ASC → P2)·legacy=ORDER BY project_id → P1 → 드리프트.
        "INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port,created_at) VALUES "
        f"(gen_random_uuid(),'{M_DIVERGE}','{P2}','dev',9801,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_DIVERGE}','{P1}','dev',9802,'2026-02-01T00:00:00+00')",
        # M_OK: 단일 프로젝트 → legacy=anchor=P1.
        "INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port,created_at) VALUES "
        f"(gen_random_uuid(),'{M_OK}','{P1}','dev',9803,'2026-01-01T00:00:00+00')",
        # agent_api_keys: member_id=team_member_id(0075 정합)·active.
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,created_at) VALUES "
        f"(gen_random_uuid(),'{M_DIVERGE}','{M_DIVERGE}','sk_d','hash_d',now()),"
        f"(gen_random_uuid(),'{M_OK}','{M_OK}','sk_o','hash_o',now())",
    ]:
        await s.execute(text(sql))
    await s.commit()


@pytest.mark.anyio
async def test_parity_catches_project_default_drift():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            rows = (await s.execute(text(PARITY_SQL))).mappings().all()
            flagged = {r["member_id"]: r for r in rows}
            # 드리프트 agent 는 잡히고(proj_mismatch·legacy P1·anchor P2)·일치 agent 는 미적출.
            assert M_DIVERGE in flagged, f"드리프트 미적출: {list(flagged)}"
            d = flagged[M_DIVERGE]
            assert d["proj_mismatch"] is True
            assert str(d["legacy_proj"]) == str(P1) and str(d["anchor_proj"]) == str(P2)
            assert not d["id_mismatch"] and not d["org_mismatch"]  # id/org 는 일치(proj 만 드리프트)
            assert M_OK not in flagged, "단일프로젝트 일치 agent 가 false-positive"
    finally:
        await engine.dispose()
