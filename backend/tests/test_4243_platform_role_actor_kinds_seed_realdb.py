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

# PO 확정표(4243 첫 판 · commit 659287e20). 0403이 «사람 완료 경로 없음»으로 agent까지 줄였다가(까디르 QA P1), story 4249가 그
# 경로(«이 단계 완료» · «다음 단계 시작»)를 만들어 0407이 되돌렸다.
_EXPECTED_WORKFLOW = {
    "preset.workflow.agent_solo": {"Agent": "agent"},
    "preset.workflow.solo": {"Worker": "either"},
    "preset.workflow.kanban": {"Member": "either"},
    "preset.workflow.kanban_simple": {"Any": "either", "Dev": "either", "Lead": "either"},
    "preset.workflow.scrum_3step": {"PO": "either", "Dev": "either", "QA": "either"},
    "preset.workflow.two_step": {"Maker": "either", "Reviewer": "either"},
    "preset.workflow.three_step": {"Executor": "either", "Reviewer": "either", "Approver": "either"},
    "preset.workflow.loop_agency": {"Human": "human", "PO": "either", "Agent": "agent", "Any": "either"},
}


def _has_human_completion_path(key: str, meta: dict, payload_schema: dict, stage: str) -> bool:
    """story #4249 — 규칙 사본을 두지 않고 엔드포인트 · 적용 창과 같은 함수를 읽는다(까디르 P3)."""
    from types import SimpleNamespace

    from app.services.recipe_stage_completion import human_completion_path

    return human_completion_path(SimpleNamespace(key=key, stage_metadata=meta, payload_schema=payload_schema), stage)


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
                "SELECT key, stage_metadata, role_actor_kinds, payload_schema FROM event_definitions "
                "WHERE org_id IS NULL AND key LIKE 'preset.%' AND stage_metadata <> '{}'::jsonb"
            ))).all()
    finally:
        await engine.dispose()


async def test_every_platform_recipe_declares_a_kind_for_every_role():
    from app.services.event_definition_registry import validate_role_actor_kinds

    rows = await _platform_rows()
    missing = []
    for key, meta, kinds, _schema in rows:
        validate_role_actor_kinds(meta, kinds)  # 선언이 모양 검증도 통과(닫힌 어휘 · 실재하는 role)
        roles = {m.get("role") for m in (meta or {}).values() if isinstance(m, dict) and m.get("role")}
        missing += [f"{key}:{role}" for role in sorted(roles) if role not in (kinds or {})]
    assert missing == [], f"role_actor_kinds 선언이 없는 플랫폼 레시피 역할: {missing}"


async def test_human_or_either_roles_have_a_human_completion_path_on_every_stage():
    """클래스 가드(까디르 QA P1 · PO) — human/either로 선언한 역할은 그 역할의 모든 stage에 사람 완료 경로가 있어야 한다. 경로 없는
    역할을 사람 쪽으로 선언하면 이벤트는 가지만 사람이 끝낼 방법이 없다(«라우팅만 참»)."""
    missing = []
    for key, meta, kinds, schema in await _platform_rows():
        for role, kind in (kinds or {}).items():
            if kind not in ("human", "either"):
                continue
            for stage, stage_meta in (meta or {}).items():
                if isinstance(stage_meta, dict) and stage_meta.get("role") == role and not _has_human_completion_path(key, meta, schema, stage):
                    missing.append(f"{key}:{role}({kind}):{stage}")
    assert missing == [], f"사람 완료 경로 없이 human/either로 선언된 역할 stage: {missing}"


def _load_migration(pattern: str):
    import importlib.util
    from pathlib import Path

    path = next((Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(pattern))
    spec = importlib.util.spec_from_file_location(f"_m_{path.stem}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_migration_0403_is_idempotent_and_reversible():
    """까디르 QA P2 — 0403을 이미 적용한 DB에 upgrade를 한 번 더 돌려도 version이 안 오르고, downgrade는 선언을 걷고 version을
    되돌린다. 까디르 4606 P3 — 공유 migrated DB라 전부 **한 트랜잭션** 안에서 돌리고 끝에 rollback한다(중간에 실패해도 다른
    테스트가 보는 행은 그대로)."""
    import importlib.util
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    m = _load_migration("0403_*.py")
    # story #4249 — 0407이 0403 값을 PO 확정표로 되돌려 둔다. 0403의 downgrade는 자기 값인 행만 걷으므로, 트랜잭션 안에서 0407을
    # 먼저 내려 0403 직후 상태에서 잰다(그 뒤 rollback이라 공유 DB는 그대로).
    m_restore = _load_migration("*_workflow_preset_role_actor_kinds_either_restore.py")

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

                _run(m_restore.downgrade)
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
    by_key = {key: kinds for key, _meta, kinds, _schema in await _platform_rows()}
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


async def test_either_restore_migration_is_idempotent_and_reversible():
    """story #4249 — 0407(either 복원): 이미 적용된 DB에 다시 돌려도 무변 · downgrade는 0403 값(agent)으로 · 다시 올리면 제자리.
    공유 migrated DB라 한 트랜잭션 + rollback(끝 상태를 일부러 내린 쪽에 둬 커밋 뮤테이션도 RED)."""
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    m = _load_migration("*_workflow_preset_role_actor_kinds_either_restore.py")
    url = _REAL_DB_URL
    for prefix in ("postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg2://" + url[len(prefix):]
            break
    engine = sa.create_engine(url)
    state_sql = sa.text(
        "SELECT version, role_actor_kinds FROM event_definitions WHERE org_id IS NULL AND key = 'preset.workflow.loop_agency'"
    )
    try:
        with engine.connect() as conn:
            before = tuple(conn.execute(state_sql).one())
            conn.rollback()
        assert before[1] == _EXPECTED_WORKFLOW["preset.workflow.loop_agency"]
        with engine.connect() as conn:
            transaction = conn.begin()
            try:
                def _run(fn):
                    with Operations.context(MigrationContext.configure(conn)):
                        fn()

                _run(m.upgrade)
                assert tuple(conn.execute(state_sql).one()) == before, "이미 적용된 DB에 다시 돌리면 무변이어야 한다"
                _run(m.downgrade)
                down = conn.execute(state_sql).one()
                assert down[1] == m.NARROWED["preset.workflow.loop_agency"] and down[0] == before[0] + 1
                _run(m.upgrade)
                assert conn.execute(state_sql).one()[1] == before[1]
                _run(m.downgrade)
            finally:
                transaction.rollback()
        with engine.connect() as conn:
            assert tuple(conn.execute(state_sql).one()) == before
    finally:
        engine.dispose()
