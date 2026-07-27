"""merge gate reject → 재제출 re-open (doc-gate 48f064e5 선례 이식).

uq(work_item_id, gate_type)=게이트 1행 + rejected=terminal + create_gate 멱등(상태필터 없음)
→ reject 후 report-done 재제출이 기존 rejected gate 를 그대로 받아 _decide 가
"policy disposition=deny" BLOCK(409)를 영구 반환했다. void/override 는 pending 전용이라
복구 경로 0 — README 데모 플로우(reject → 수정 → 재제출 → approve)가 API 상 불가능
(2026-07-10 gate smoke E2E 실측).

fix: evaluate_merge_gate 가 terminal(rejected/voided) gate 를 만나면 새 결재 사이클로
pending re-open — 이전 결재를 neutral_facts.decision_history 에 append(감사 보존), 해소
필드 clear, 새 평가 facts 로 갱신. approved 는 그대로(이미 landed 작업의 재보고는 무해).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

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


def _engine_url() -> str:
    return _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )


async def _seed_story_with_gate(Session, *, org, project, story_id, member, role_id, gate_id,
                                gate_status, resolution_note=None):
    from datetime import datetime, timezone

    from sqlalchemy import text as _text

    from app.models.gate import Gate
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story

    resolver = uuid.uuid4()
    async with Session() as s:
        await s.execute(_text("SET session_replication_role = replica"))  # 시드 FK 우회.
        s.add_all([
            ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
            Story(id=story_id, org_id=org, project_id=project, title="재제출 스토리", status="in-review"),
            Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
            Gate(
                id=gate_id, org_id=org, work_item_id=story_id, work_item_type="story",
                gate_type="merge", status=gate_status,
                resolver_id=resolver,
                resolved_at=datetime.now(timezone.utc),
                resolution_note=resolution_note,
                neutral_facts={"pr_number": 8, "ci_result": "pass"},
            ),
        ])
        await s.commit()
    return resolver


@pytest.mark.anyio
async def test_rejected_gate_reopens_on_resubmit():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import ASK_HUMAN, evaluate_merge_gate

    engine = create_async_engine(_engine_url())
    org, project, story_id, member, role_id, gate_id = (uuid.uuid4() for _ in range(6))

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        prior_resolver = await _seed_story_with_gate(
            Session, org=org, project=project, story_id=story_id, member=member,
            role_id=role_id, gate_id=gate_id, gate_status="rejected",
            resolution_note="add expired-token coverage first",
        )

        with patch("app.services.verdict_capture.fetch_pr_review_rounds", AsyncMock(return_value=0)):
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                res = await evaluate_merge_gate(
                    s, org, story_id, pr_number=8, repo="o/r", ci_result="pass", pr_result="pass"
                )
                await s.commit()

        # 재제출 = 새 결재 사이클: BLOCK 이 아니라 사람 보류(cold start ask)여야 한다.
        assert res.decision == ASK_HUMAN, f"재제출은 재결재 사이클이어야, got {res.decision} ({res.reason})"
        assert res.gate_id == gate_id  # 같은 gate 행 재사용(uq 유지).

        async with Session() as s:
            gate = (await s.execute(
                _text("SELECT status, resolver_id, resolved_at, resolution_note, neutral_facts "
                      "FROM gate WHERE id=:g"), {"g": gate_id}
            )).one()
            assert gate.status == "pending", f"re-open 이어야, got {gate.status}"
            assert gate.resolver_id is None and gate.resolved_at is None and gate.resolution_note is None
            history = (gate.neutral_facts or {}).get("decision_history") or []
            assert history, "이전 반려가 decision_history 로 보존돼야(감사)"
            assert history[-1]["status"] == "rejected"
            assert history[-1]["resolver_id"] == str(prior_resolver)
            assert history[-1]["resolution_note"] == "add expired-token coverage first"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_approved_gate_not_reopened():
    """approved 는 landed 작업 — 재평가가 기존 결재를 무효화하면 안 된다."""
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.services.merge_verdict_gate import evaluate_merge_gate

    engine = create_async_engine(_engine_url())
    org, project, story_id, member, role_id, gate_id = (uuid.uuid4() for _ in range(6))

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        resolver = await _seed_story_with_gate(
            Session, org=org, project=project, story_id=story_id, member=member,
            role_id=role_id, gate_id=gate_id, gate_status="approved",
        )

        with patch("app.services.verdict_capture.fetch_pr_review_rounds", AsyncMock(return_value=0)):
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                await evaluate_merge_gate(
                    s, org, story_id, pr_number=8, repo="o/r", ci_result="pass", pr_result="pass"
                )
                await s.commit()

        async with Session() as s:
            gate = (await s.execute(
                _text("SELECT status, resolver_id FROM gate WHERE id=:g"), {"g": gate_id}
            )).one()
            assert gate.status == "approved" and str(gate.resolver_id) == str(resolver)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
