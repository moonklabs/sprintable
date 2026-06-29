"""f5ee8387 H2 audit 정밀화 검증 — cut REGRESSION 게이트가 '깨지는 키'만 잡고 'dead 키'는 INFO 로 분리,
(b) parity 가 project-default 드리프트를 잡는지 락. DB env 없으면 skip(CI alembic-fresh).

PO dev audit 적발: 기존 (a)가 legacy 도 이미 401 인 dead 키(inactive tm)까지 위반으로 inflation(team_members
projection VIEW dup 포함). 정밀화 = (a) regression(legacy 200·anchor 401)만 게이트·dead 는 count(DISTINCT) INFO.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from scripts.jobs.audit_apikey_member_anchor import AUDIT_SQL, DEAD_KEYS_SQL, PARITY_SQL

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("a5000000-0000-0000-0000-000000000001")
P1 = uuid.UUID("a5000000-0000-0000-0000-0000000000a1")  # P1 < P2 (legacy ORDER BY project_id → P1)
P2 = uuid.UUID("a5000000-0000-0000-0000-0000000000b2")
M_OK = uuid.UUID("a5000000-0000-0000-0000-0000000000e1")        # 단일프로젝트·일치
M_DIVERGE = uuid.UUID("a5000000-0000-0000-0000-0000000000d1")   # 멀티프로젝트·드리프트
M_REG = uuid.UUID("a5000000-0000-0000-0000-0000000000c1")       # active(legacy 200)
M_INACTIVE = uuid.UUID("a5000000-0000-0000-0000-0000000000c2")  # inactive anchor(K_REG 가 가리킴 → anchor 401)
M_DEAD = uuid.UUID("a5000000-0000-0000-0000-0000000000f1")      # inactive(legacy·anchor 둘 다 401)
K_OK = uuid.UUID("a5000000-0000-0000-0000-00000000ba01")
K_DIV = uuid.UUID("a5000000-0000-0000-0000-00000000ba02")
K_REG = uuid.UUID("a5000000-0000-0000-0000-00000000ba03")
K_DEAD = uuid.UUID("a5000000-0000-0000-0000-00000000ba04")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s):
    for sql in [
        f"DELETE FROM agent_api_keys WHERE id IN ('{K_OK}','{K_DIV}','{K_REG}','{K_DEAD}')",
        f"DELETE FROM agent_project_profiles WHERE member_id IN "
        f"('{M_OK}','{M_DIVERGE}','{M_REG}','{M_DEAD}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A5','a5org','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{P1}','{ORG}','P1'),('{P2}','{ORG}','P2')",
        "INSERT INTO members (id,org_id,type,name,is_active) VALUES "
        f"('{M_OK}','{ORG}','agent','Ok',true),('{M_DIVERGE}','{ORG}','agent','Div',true),"
        f"('{M_REG}','{ORG}','agent','Reg',true),('{M_INACTIVE}','{ORG}','agent','Inact',false),"
        f"('{M_DEAD}','{ORG}','agent','Dead',false)",
        # agent_project_profiles → team_members(view) 행. M_DIVERGE: P2 가 더 일찍 생성(anchor=created_at→P2)·legacy=P1.
        "INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port,created_at) VALUES "
        f"(gen_random_uuid(),'{M_OK}','{P1}','dev',9803,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_DIVERGE}','{P2}','dev',9801,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_DIVERGE}','{P1}','dev',9802,'2026-02-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_REG}','{P1}','dev',9804,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_DEAD}','{P1}','dev',9805,'2026-01-01T00:00:00+00')",
        # 키: K_REG = legacy(M_REG active) 200 · anchor(M_INACTIVE) 401 → regression.
        #     K_DEAD = legacy(M_DEAD inactive)·anchor 둘 다 401 → dead(INFO).
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,created_at) VALUES "
        f"('{K_OK}','{M_OK}','{M_OK}','sk_o','h_o',now()),"
        f"('{K_DIV}','{M_DIVERGE}','{M_DIVERGE}','sk_d','h_d',now()),"
        f"('{K_REG}','{M_REG}','{M_INACTIVE}','sk_r','h_r',now()),"
        f"('{K_DEAD}','{M_DEAD}','{M_DEAD}','sk_x','h_x',now())",
    ]:
        await s.execute(text(sql))
    await s.commit()


@pytest.mark.anyio
async def test_audit_regression_gate_and_parity():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            reg = {r["api_key_id"] for r in (await s.execute(text(AUDIT_SQL))).mappings().all()}
            dead = (await s.execute(text(DEAD_KEYS_SQL))).scalar_one()
            parity = {r["member_id"]: r for r in (await s.execute(text(PARITY_SQL))).mappings().all()}

            # (a) regression: legacy 200·anchor 401 인 K_REG 만. dead/ok/valid 는 제외.
            assert K_REG in reg, f"regression 미적출: {reg}"
            assert K_DEAD not in reg, "dead 키가 regression 으로 오분류(flip 무관인데)"
            assert K_OK not in reg and K_DIV not in reg, "정상 키 false-positive"
            # dead 키(K_DEAD)는 INFO count 로만(≥1·DISTINCT 라 dup inflation 없음).
            assert dead >= 1, f"dead 키 INFO 미집계: {dead}"
            # (b) parity: 멀티프로젝트 드리프트 M_DIVERGE 만(proj_mismatch).
            assert M_DIVERGE in parity and parity[M_DIVERGE]["proj_mismatch"] is True
            assert M_OK not in parity, "단일프로젝트 일치 agent false-positive"
    finally:
        await engine.dispose()
