"""SID 301ee45d/#2047 AC3: 실DB 회귀 테스트 3종 — 증거 없는(ci=None·pr_number=0) merge 게이트
경로에서 명시 ask 정책이 더 이상 우회되지 않는지 실제 Postgres 왕복으로 확인한다.

배경(선생님 지시 2026-07-20, P0): `merge_verdict_gate.evaluate_merge_gate`의 no-substance
chokepoint가 'ask'를 시스템 기본값이든 조직이 명시 설정했든 구분 없이 취급해, "코드가 아닌 일에는
사람 결재가 원리적으로 안 걸리는" 결함이었다(댄 어윈 실측). `resolve_disposition`이 이제
(disposition, source)를 돌려주고, source가 SYSTEM_DEFAULT가 아니면(=조직/멤버가 어떤 형태로든
명시) 'ask'도 'deny'와 동일하게 substance로 인정해 게이트를 만든다.

균형점(AC2): 명시하지 않은 조직은 지금과 동일하게 게이트가 안 선다 — 빈 shell 박멸 의도 보존.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    return _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )


async def _engine_and_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_story_with_participation(session, *, org, project, story_id, member, role_id):
    from sqlalchemy import text as _text
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story

    await session.execute(_text("SET session_replication_role = replica"))
    session.add_all([
        ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
        Story(id=story_id, org_id=org, project_id=project, title="#2047 AC3", status="in-review", story_points=3),
        Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
    ])
    await session.commit()


@pytest.mark.anyio
async def test_explicit_org_policy_ask_materializes_gate_without_evidence():
    """ⓐ 명시 ask(org posture) + 증거 없음(ci=None·pr=0) → 게이트 생성·requires_human=true.

    이게 이 스토리의 핵심 회귀 게이트 — 댄 어윈이 실측한 그 시나리오(콘텐츠 프로젝트·PR/CI 없음)를
    그대로 재현한다."""
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.hitl_config import OrgGatePolicy
    from app.services.merge_verdict_gate import ASK_HUMAN, AUTO_MERGE, evaluate_merge_gate

    engine, Session = await _engine_and_session()
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    member, role_id = uuid.uuid4(), uuid.uuid4()
    try:
        async with Session() as s:
            await _seed_story_with_participation(
                s, org=org, project=project, story_id=story_id, member=member, role_id=role_id,
            )
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(OrgGatePolicy(org_id=org, posture="conservative"))  # → 명시 ask(org_policy).
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            decision = await evaluate_merge_gate(
                s, org, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        assert decision.decision != AUTO_MERGE
        assert decision.decision == ASK_HUMAN
        assert decision.gate_id is not None, "명시 ask 정책은 증거 없어도 게이트가 서야 한다"

        async with Session() as s:
            meta = (await s.execute(
                _text("SELECT requires_human, status FROM gate WHERE work_item_id=:sid AND gate_type='merge'"),
                {"sid": story_id},
            )).one()
            assert meta.requires_human is True
            assert meta.status == "pending"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_unset_org_no_gate_without_evidence():
    """ⓑ 정책 미설정(SYSTEM_DEFAULT ask) + 증거 없음 → 게이트 미생성(row 0)·현행 유지.

    빈 shell 박멸 의도 보존 — AC2의 균형점을 지키는 회귀 게이트."""
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.services.merge_verdict_gate import AUTO_MERGE, evaluate_merge_gate

    engine, Session = await _engine_and_session()
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    member, role_id = uuid.uuid4(), uuid.uuid4()
    try:
        async with Session() as s:
            await _seed_story_with_participation(
                s, org=org, project=project, story_id=story_id, member=member, role_id=role_id,
            )
            # OrgGatePolicy 행 없음 — precedence 4단(SYSTEM_DEFAULT)로 떨어진다.

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            decision = await evaluate_merge_gate(
                s, org, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        assert decision.decision == AUTO_MERGE
        assert decision.gate_id is None
        assert "no-substance" in decision.reason

        async with Session() as s:
            count = (await s.execute(
                _text("SELECT count(*) FROM gate WHERE work_item_id=:sid AND gate_type='merge'"),
                {"sid": story_id},
            )).scalar()
            assert count == 0, "명시 안 한 조직은 빈 shell 게이트가 생기면 안 된다"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_explicit_deny_still_materializes_gate_unchanged():
    """ⓒ 명시 deny(org_gate_override) → 증거 없어도 게이트 생성(기존 동작 무회귀).

    deny는 이 스토리 이전에도 substance로 인정됐다 — 그 경로가 이번 변경으로 안 깨지는지 확인."""
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.hitl_config import OrgGateOverride
    from app.services.merge_verdict_gate import AUTO_MERGE, evaluate_merge_gate

    engine, Session = await _engine_and_session()
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    member, role_id = uuid.uuid4(), uuid.uuid4()
    try:
        async with Session() as s:
            await _seed_story_with_participation(
                s, org=org, project=project, story_id=story_id, member=member, role_id=role_id,
            )
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(OrgGateOverride(org_id=org, role_id=role_id, gate_type="merge", disposition="deny"))
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            decision = await evaluate_merge_gate(
                s, org, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        assert decision.decision != AUTO_MERGE
        assert decision.gate_id is not None

        async with Session() as s:
            count = (await s.execute(
                _text("SELECT count(*) FROM gate WHERE work_item_id=:sid AND gate_type='merge'"),
                {"sid": story_id},
            )).scalar()
            assert count == 1
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
