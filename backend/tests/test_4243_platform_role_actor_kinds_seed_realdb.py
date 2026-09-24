"""story #4243 — 플랫폼 레시피의 역할별 사람/에이전트 선언(role_actor_kinds) 전수 가드(migrated DB · non-destructive).

시드 마이그레이션(0403)이 실은 선언을 실제 행에서 본다. 클래스 가드: 플랫폼 사이클형 프리셋(`preset.*` · org_id NULL · stage_metadata
있음)은 **모든 역할**에 kind를 선언한다 — 선언 빠진 새 프리셋은 여기서 RED(범용 적용 창이 그 역할을 에이전트로만 묶게 되는 클래스
재발 방지)."""
from __future__ import annotations

import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

# PO 판단(2026-09-24 · 까디르 QA P1) — 사람 완료 경로가 없는 역할은 human/either로 선언하지 않는다. 워크플로우 8종은 지금
# 모든 역할에 경로가 없어 agent(either 복원은 story 4249).
_EXPECTED_WORKFLOW = {
    "preset.workflow.agent_solo": {"Agent": "agent"},
    "preset.workflow.solo": {"Worker": "agent"},
    "preset.workflow.kanban": {"Member": "agent"},
    "preset.workflow.kanban_simple": {"Any": "agent", "Dev": "agent", "Lead": "agent"},
    "preset.workflow.scrum_3step": {"PO": "agent", "Dev": "agent", "QA": "agent"},
    "preset.workflow.two_step": {"Maker": "agent", "Reviewer": "agent"},
    "preset.workflow.three_step": {"Executor": "agent", "Reviewer": "agent", "Approver": "agent"},
    "preset.workflow.loop_agency": {"Human": "agent", "PO": "agent", "Agent": "agent", "Any": "agent"},
}

# 사람이 stage를 끝낼 화면 경로 = 레시피 게이트 승인(recipe_gate_hooks가 게이트를 열고 결재함에서 승인) 또는 서버가 완료를 잇는 승인
# 자리(`approval.surface = draft_gate` — 블로그 초안 게이트 승인 → 서버 발행 → 다음 stage, 4572). `doc_approval`은 지금 표시용 선언이라
# (레시피 stage를 잇는 훅 없음) 경로가 아니다.
_STAGE_COMPLETING_SURFACES = {"draft_gate"}


def _has_human_completion_path(stage_meta: dict) -> bool:
    return bool(stage_meta.get("gate")) or (stage_meta.get("approval") or {}).get("surface") in _STAGE_COMPLETING_SURFACES


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _platform_rows():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return (await conn.execute(text(
                "SELECT key, stage_metadata, role_actor_kinds FROM event_definitions "
                "WHERE org_id IS NULL AND key LIKE 'preset.%' AND stage_metadata <> '{}'::jsonb"
            ))).all()
    finally:
        await engine.dispose()


async def test_every_platform_recipe_declares_a_kind_for_every_role():
    from app.services.event_definition_registry import validate_role_actor_kinds

    rows = await _platform_rows()
    missing = []
    for key, meta, kinds in rows:
        validate_role_actor_kinds(meta, kinds)  # 선언이 모양 검증도 통과(닫힌 어휘 · 실재하는 role)
        roles = {m.get("role") for m in (meta or {}).values() if isinstance(m, dict) and m.get("role")}
        missing += [f"{key}:{role}" for role in sorted(roles) if role not in (kinds or {})]
    assert missing == [], f"role_actor_kinds 선언이 없는 플랫폼 레시피 역할: {missing}"


async def test_human_or_either_roles_have_a_human_completion_path_on_every_stage():
    """클래스 가드(까디르 QA P1 · PO) — human/either로 선언한 역할은 그 역할의 모든 stage에 사람 완료 경로가 있어야 한다. 경로 없는
    역할을 사람 쪽으로 선언하면 이벤트는 가지만 사람이 끝낼 방법이 없다(«라우팅만 참»)."""
    missing = []
    for key, meta, kinds in await _platform_rows():
        for role, kind in (kinds or {}).items():
            if kind not in ("human", "either"):
                continue
            for stage, stage_meta in (meta or {}).items():
                if isinstance(stage_meta, dict) and stage_meta.get("role") == role and not _has_human_completion_path(stage_meta):
                    missing.append(f"{key}:{role}({kind}):{stage}")
    assert missing == [], f"사람 완료 경로 없이 human/either로 선언된 역할 stage: {missing}"


async def test_migration_0403_is_idempotent_and_reversible():
    """까디르 QA P2 — 0403을 이미 적용한 DB에 upgrade를 한 번 더 돌려도 version이 안 오르고, downgrade는 선언을 걷고 version을
    되돌린다. 까디르 4606 P3 — 공유 migrated DB라 전부 **한 트랜잭션** 안에서 돌리고 끝에 rollback한다(중간에 실패해도 다른
    테스트가 보는 행은 그대로)."""
    import importlib.util
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    path = next((Path(__file__).resolve().parents[1] / "alembic" / "versions").glob("0403_*.py"))
    spec = importlib.util.spec_from_file_location("_m0403", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)

    url = _REAL_DB_URL
    for prefix in ("postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg2://" + url[len(prefix):]
            break
    engine = sa.create_engine(url)
    _STATE_SQL = sa.text(
        "SELECT version, role_actor_kinds, stage_metadata->'brief_doc_approval'->'approval' FROM event_definitions "
        "WHERE org_id IS NULL AND key = 'preset.workflow.loop_agency'"
    )
    try:
        with engine.connect() as conn:
            before = tuple(conn.execute(_STATE_SQL).one())
            conn.rollback()
        with engine.connect() as conn:
            transaction = conn.begin()
            try:
                def _run(fn):
                    with Operations.context(MigrationContext.configure(conn)):
                        fn()

                def _state():
                    return conn.execute(_STATE_SQL).one()

                applied = _state()
                assert applied[1] is not None and applied[2] == {"surface": "doc_approval"}
                _run(m.upgrade)
                assert _state() == applied, "이미 적용된 DB에 upgrade를 다시 돌리면 아무것도(version 포함) 안 바뀌어야 한다"
                _run(m.downgrade)
                down = _state()
                assert down[1] is None and down[2] is None and down[0] == applied[0] - 2
                _run(m.upgrade)
                assert _state() == applied
                # 트랜잭션 끝 상태를 일부러 «내려간» 쪽에 둔다 — 위 순서는 결국 제자리라, 여기서 한 번 더 내리지 않으면 rollback 대신
                # 커밋해도 뒤의 «전과 같음» 단언이 통과해 버린다(뮤테이션을 못 잡는다).
                _run(m.downgrade)
            finally:
                transaction.rollback()
        with engine.connect() as conn:
            after = tuple(conn.execute(_STATE_SQL).one())
        # 까디르 4606 델타 P2 — version · 선언 · 승인 메타까지 전과 같아야 한다(rollback을 빼거나 커밋하면 version이 +2 · 선언이
        # 바뀐 채 남아 RED).
        assert after == before, (before, after)
    finally:
        engine.dispose()


async def test_workflow_presets_carry_the_po_confirmed_table():
    by_key = {key: kinds for key, _meta, kinds in await _platform_rows()}
    for key, expected in _EXPECTED_WORKFLOW.items():
        assert by_key.get(key) == expected, key


async def test_loop_agency_brief_declares_document_approval_surface_and_validates():
    """D3 — loop_agency «브리프»의 승인은 결재함의 문서 결재(`approval.surface = doc_approval`) · 게이트 없음 · 모양 검증 통과 ·
    다른 stage엔 선언 없음."""
    from app.services.event_definition_registry import validate_stage_metadata

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            meta, schema = (await conn.execute(text(
                "SELECT stage_metadata, payload_schema FROM event_definitions "
                "WHERE org_id IS NULL AND key = 'preset.workflow.loop_agency'"
            ))).one()
    finally:
        await engine.dispose()
    validate_stage_metadata(schema, meta)
    assert meta["brief_doc_approval"]["approval"] == {"surface": "doc_approval"}
    assert "gate" not in meta["brief_doc_approval"]
    assert [s for s, m in meta.items() if "approval" in m] == ["brief_doc_approval"]
