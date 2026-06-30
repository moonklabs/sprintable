"""f5ee8387 H2 audit 검증 — cut REGRESSION 게이트('깨지는 키'만·dead 는 INFO) + parity(정렬 정합 後
멀티프로젝트 무드리프트 + id_mismatch 적출). DB env 없으면 skip(CI alembic-fresh).

prod audit가 (b)서 산티아고 멀티프로젝트 agent 기본프로젝트 드리프트(legacy project_id ASC vs anchor
created_at ASC) 적발 → anchor 정렬을 legacy 와 동일 project_id ASC 로 정합(auth.py + PARITY_SQL).
정합 後엔 정상 데이터면 proj 드리프트 0(M_DIVERGE 미적출)·id_mismatch 만 parity 가 잡는다.
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
P1 = uuid.UUID("a5000000-0000-0000-0000-0000000000a1")  # P1 < P2 (project_id ASC → P1)
P2 = uuid.UUID("a5000000-0000-0000-0000-0000000000b2")
M_OK = uuid.UUID("a5000000-0000-0000-0000-0000000000e1")        # 단일프로젝트
M_DIVERGE = uuid.UUID("a5000000-0000-0000-0000-0000000000d1")   # 멀티프로젝트(정렬 정합 後 무드리프트)
M_REG = uuid.UUID("a5000000-0000-0000-0000-0000000000c1")       # active(legacy 200)
M_INACTIVE = uuid.UUID("a5000000-0000-0000-0000-0000000000c2")  # inactive anchor(K_REG 가 가리킴 → anchor 401)
M_DEAD = uuid.UUID("a5000000-0000-0000-0000-0000000000f1")      # inactive(legacy·anchor 둘 다 401)
M_TMSIDE = uuid.UUID("a5000000-0000-0000-0000-0000000000aa")    # K_IDD legacy 측(active)
M_ANCHORSIDE = uuid.UUID("a5000000-0000-0000-0000-0000000000bb")  # K_IDD anchor 측(active·다른 id)
K_OK = uuid.UUID("a5000000-0000-0000-0000-00000000ba01")
K_DIV = uuid.UUID("a5000000-0000-0000-0000-00000000ba02")
K_REG = uuid.UUID("a5000000-0000-0000-0000-00000000ba03")
K_DEAD = uuid.UUID("a5000000-0000-0000-0000-00000000ba04")
K_IDD = uuid.UUID("a5000000-0000-0000-0000-00000000ba05")       # member_id≠team_member_id(id_mismatch)


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s):
    keys = f"'{K_OK}','{K_DIV}','{K_REG}','{K_DEAD}','{K_IDD}'"
    for sql in [
        f"DELETE FROM agent_api_keys WHERE id IN ({keys})",
        f"DELETE FROM agent_project_profiles WHERE member_id IN "
        f"('{M_OK}','{M_DIVERGE}','{M_REG}','{M_DEAD}','{M_TMSIDE}','{M_ANCHORSIDE}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A5','a5org','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{P1}','{ORG}','P1'),('{P2}','{ORG}','P2')",
        "INSERT INTO members (id,org_id,type,name,is_active) VALUES "
        f"('{M_OK}','{ORG}','agent','Ok',true),('{M_DIVERGE}','{ORG}','agent','Div',true),"
        f"('{M_REG}','{ORG}','agent','Reg',true),('{M_INACTIVE}','{ORG}','agent','Inact',false),"
        f"('{M_DEAD}','{ORG}','agent','Dead',false),('{M_TMSIDE}','{ORG}','agent','TmSide',true),"
        f"('{M_ANCHORSIDE}','{ORG}','agent','AnchorSide',true)",
        # M_DIVERGE: P2 프로파일이 더 일찍 생성 — created_at 정렬이면 P2(legacy P1과 드리프트)였으나,
        # project_id 정렬 정합 後엔 anchor 도 P1(최소 project_id) → 드리프트 0.
        "INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port,created_at) VALUES "
        f"(gen_random_uuid(),'{M_OK}','{P1}','dev',9803,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_DIVERGE}','{P2}','dev',9801,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_DIVERGE}','{P1}','dev',9802,'2026-02-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_REG}','{P1}','dev',9804,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_DEAD}','{P1}','dev',9805,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_TMSIDE}','{P1}','dev',9806,'2026-01-01T00:00:00+00'),"
        f"(gen_random_uuid(),'{M_ANCHORSIDE}','{P1}','dev',9807,'2026-01-01T00:00:00+00')",
        # K_REG=regression(legacy 200·anchor 401) · K_DEAD=dead(INFO) · K_IDD=id_mismatch(member≠tm).
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,created_at) VALUES "
        f"('{K_OK}','{M_OK}','{M_OK}','sk_o','h_o',now()),"
        f"('{K_DIV}','{M_DIVERGE}','{M_DIVERGE}','sk_d','h_d',now()),"
        f"('{K_REG}','{M_REG}','{M_INACTIVE}','sk_r','h_r',now()),"
        f"('{K_DEAD}','{M_DEAD}','{M_DEAD}','sk_x','h_x',now()),"
        f"('{K_IDD}','{M_TMSIDE}','{M_ANCHORSIDE}','sk_i','h_i',now())",
    ]:
        await s.execute(text(sql))
    await s.commit()


@pytest.mark.anyio
async def test_audit_regression_gate_and_aligned_parity():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            reg = {r["api_key_id"] for r in (await s.execute(text(AUDIT_SQL))).mappings().all()}
            dead = (await s.execute(text(DEAD_KEYS_SQL))).scalar_one()
            parity = {r["api_key_id"]: r for r in (await s.execute(text(PARITY_SQL))).mappings().all()}

            # (a) regression: legacy 200·anchor 401 인 K_REG 만. dead/ok/valid 는 제외.
            assert K_REG in reg, f"regression 미적출: {reg}"
            assert K_DEAD not in reg, "dead 키가 regression 으로 오분류"
            assert K_OK not in reg and K_DIV not in reg, "정상 키 false-positive"
            assert dead >= 1, f"dead 키 INFO 미집계: {dead}"

            # (b) 정렬 정합 後: 멀티프로젝트 M_DIVERGE 는 anchor 도 project_id ASC → P1 = legacy → 무드리프트.
            assert K_DIV not in parity, "정렬 정합 後에도 멀티프로젝트 드리프트(정합 미적용?)"
            assert K_OK not in parity, "단일프로젝트 false-positive"
            # parity 는 여전히 id_mismatch(0075 파손) 를 잡는다 — K_IDD(member≠tm).
            assert K_IDD in parity and parity[K_IDD]["id_mismatch"] is True
            assert parity[K_IDD]["proj_mismatch"] is False  # 둘 다 P1 → proj 는 정합
    finally:
        await engine.dispose()
