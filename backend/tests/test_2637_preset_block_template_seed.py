"""story #2637 §범위5(0-b 준용) — migration 0249: 프리셋 4종 block_template 시드.

검증: 실 마이그 실행으로 4종 전부 block_template이 채워지는지 + 그 콘텐츠가 자체
validate_block_template 게이트를 통과하는지(시드가 스스로 어긴 계약을 심으면 안 된다 —
자기모순 방지) + 재실행 멱등(같은 값 재대입, 부작용 없음).
"""
from __future__ import annotations

import importlib.util
import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0249_event_definitions_preset_block_templates.py"
)

pytestmark = pytest.mark.destructive_schema


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0249", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_all_seed_templates_pass_own_validation_gate():
    """시드가 스스로 어긴 계약을 심으면 안 된다 — 자기모순 방지 회귀 가드."""
    from app.services.event_definition_registry import validate_block_template

    mig = _load_migration()
    for key, template in mig._TEMPLATES.items():
        validate_block_template(template)  # no raise


def test_seed_covers_exactly_the_4_presets():
    mig = _load_migration()
    assert set(mig._TEMPLATES.keys()) == {
        "preset.gate.verdict", "preset.work.status_changed",
        "preset.work.assigned", "preset.goal.measured",
    }


def _run_migration_fn(eng, mig, fn_name: str) -> None:
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    with eng.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            getattr(mig, fn_name)()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_migration_seeds_all_4_presets_and_is_idempotent():
    import uuid
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS event_definitions"))
            c.execute(sa.text(
                "CREATE TABLE event_definitions (id uuid PRIMARY KEY, org_id uuid, key text NOT NULL, "
                "block_template jsonb)"
            ))
            for key in mig._TEMPLATES:
                c.execute(sa.text(
                    "INSERT INTO event_definitions (id, org_id, key) VALUES (:id, NULL, :key)"
                ), {"id": str(uuid.uuid4()), "key": key})
            # org 커스텀 행(다른 org_id) — 이 마이그가 절대 안 건드려야 함(WHERE org_id IS NULL).
            org_id = uuid.uuid4()
            c.execute(sa.text(
                "INSERT INTO event_definitions (id, org_id, key) VALUES (:id, :org_id, 'org.acme.thing.done')"
            ), {"id": str(uuid.uuid4()), "org_id": str(org_id)})

        _run_migration_fn(eng, mig, "upgrade")

        with eng.begin() as c:
            rows = c.execute(sa.text("SELECT key, block_template, org_id FROM event_definitions")).fetchall()
        by_key = {r[0]: r[1] for r in rows}
        for key, template in mig._TEMPLATES.items():
            assert by_key[key] == template
        # org 커스텀 행은 손대지 않음.
        assert by_key["org.acme.thing.done"] is None

        # 재실행 — 멱등(같은 값 재대입).
        _run_migration_fn(eng, mig, "upgrade")
        with eng.begin() as c:
            rows2 = c.execute(sa.text("SELECT key, block_template FROM event_definitions")).fetchall()
        assert {r[0]: r[1] for r in rows2} == by_key | {"org.acme.thing.done": None}

        # downgrade — 전부 NULL로.
        _run_migration_fn(eng, mig, "downgrade")
        with eng.begin() as c:
            rows3 = c.execute(sa.text("SELECT key, block_template FROM event_definitions")).fetchall()
        for key, tmpl in rows3:
            if key in mig._TEMPLATES:
                assert tmpl is None
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS event_definitions"))
        eng.dispose()
