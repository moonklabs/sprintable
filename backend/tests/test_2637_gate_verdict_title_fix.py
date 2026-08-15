"""story #2637 AC4 후속(페드루 지시, 2026-08-14) — migration 0251: preset.gate.verdict
block_template의 "대상" 필드를 work_item_id → work_item_title로 정정 + payload_schema에
work_item_title 추가(additive·non-required).

검증: 새 block_template/payload_schema가 자체 검증 게이트를 통과하는지(자기모순 방지) +
실 마이그 실행으로 preset.gate.verdict «만» 바뀌고(다른 3개 프리셋·org 커스텀 행은 무변경) +
version이 PATCH 엔드포인트와 동형으로 1만 오르는지 + downgrade가 원상복구(version 포함)하는지.
"""
from __future__ import annotations

import importlib.util
import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0251_gate_verdict_work_item_title.py"
)

pytestmark = pytest.mark.destructive_schema


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0251", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_new_block_template_passes_own_validation_gate():
    from app.services.event_definition_registry import validate_block_template

    mig = _load_migration()
    validate_block_template(mig._NEW_BLOCK_TEMPLATE)  # no raise


def test_new_payload_schema_is_valid_and_additionalproperties_false():
    import jsonschema

    mig = _load_migration()
    validator_cls = jsonschema.validators.validator_for(mig._NEW_PAYLOAD_SCHEMA)
    validator_cls.check_schema(mig._NEW_PAYLOAD_SCHEMA)  # no raise
    assert mig._NEW_PAYLOAD_SCHEMA["additionalProperties"] is False


def test_work_item_title_added_but_not_required():
    mig = _load_migration()
    assert "work_item_title" in mig._NEW_PAYLOAD_SCHEMA["properties"]
    assert "work_item_title" not in mig._NEW_PAYLOAD_SCHEMA["required"]


def test_target_field_value_switches_from_id_to_title():
    mig = _load_migration()
    fields = mig._NEW_BLOCK_TEMPLATE["blocks"][2]["fields"]
    target_field = next(f for f in fields if f["label"] == "대상")
    assert target_field["value"] == "{{payload.work_item_title}}"
    old_fields = mig._OLD_BLOCK_TEMPLATE["blocks"][2]["fields"]
    old_target = next(f for f in old_fields if f["label"] == "대상")
    assert old_target["value"] == "{{payload.work_item_id}}"


def _run_migration_fn(eng, mig, fn_name: str) -> None:
    import sqlalchemy as sa  # noqa: F401
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    with eng.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            getattr(mig, fn_name)()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_migration_updates_only_gate_verdict_and_bumps_version_by_one():
    import uuid
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    other_preset_key = "preset.work.status_changed"
    try:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS event_definitions"))
            c.execute(sa.text(
                "CREATE TABLE event_definitions (id uuid PRIMARY KEY, org_id uuid, key text NOT NULL, "
                "block_template jsonb, payload_schema jsonb, version integer NOT NULL DEFAULT 1)"
            ))
            c.execute(sa.text(
                "INSERT INTO event_definitions (id, org_id, key, block_template, payload_schema, version) "
                "VALUES (:id, NULL, :key, :bt, :ps, 1)"
            ), {
                "id": str(uuid.uuid4()), "key": mig._KEY,
                "bt": __import__("json").dumps(mig._OLD_BLOCK_TEMPLATE),
                "ps": __import__("json").dumps(mig._OLD_PAYLOAD_SCHEMA),
            })
            # 다른 프리셋 행 — 이 마이그가 절대 안 건드려야 함(WHERE key = 'preset.gate.verdict').
            c.execute(sa.text(
                "INSERT INTO event_definitions (id, org_id, key, block_template, payload_schema, version) "
                "VALUES (:id, NULL, :key, NULL, NULL, 1)"
            ), {"id": str(uuid.uuid4()), "key": other_preset_key})
            # org 커스텀 행(동일 key, 다른 org_id) — WHERE org_id IS NULL 밖이라 무변경이어야 함.
            org_id = uuid.uuid4()
            c.execute(sa.text(
                "INSERT INTO event_definitions (id, org_id, key, block_template, payload_schema, version) "
                "VALUES (:id, :org_id, :key, NULL, NULL, 1)"
            ), {"id": str(uuid.uuid4()), "org_id": str(org_id), "key": mig._KEY})

        _run_migration_fn(eng, mig, "upgrade")

        with eng.begin() as c:
            rows = {
                r[0]: dict(org_id=r[1], block_template=r[2], payload_schema=r[3], version=r[4])
                for r in c.execute(sa.text(
                    "SELECT key, org_id, block_template, payload_schema, version FROM event_definitions"
                )).fetchall()
                if r[1] is None
            }
        gate = rows[mig._KEY]
        assert gate["block_template"] == mig._NEW_BLOCK_TEMPLATE
        assert gate["payload_schema"] == mig._NEW_PAYLOAD_SCHEMA
        assert gate["version"] == 2  # 1 -> 2, single bump despite 2 fields changed (PATCH 동형)

        other = rows[other_preset_key]
        assert other["block_template"] is None
        assert other["payload_schema"] is None
        assert other["version"] == 1  # 무변경

        with eng.begin() as c:
            org_row = c.execute(sa.text(
                "SELECT block_template, payload_schema, version FROM event_definitions WHERE org_id = :org_id"
            ), {"org_id": str(org_id)}).fetchone()
        assert org_row == (None, None, 1)  # org 커스텀 행 무변경

        # downgrade — 원상복구(version 포함).
        _run_migration_fn(eng, mig, "downgrade")
        with eng.begin() as c:
            gate_after = c.execute(sa.text(
                "SELECT block_template, payload_schema, version FROM event_definitions "
                "WHERE org_id IS NULL AND key = :key"
            ), {"key": mig._KEY}).fetchone()
        assert gate_after[0] == mig._OLD_BLOCK_TEMPLATE
        assert gate_after[1] == mig._OLD_PAYLOAD_SCHEMA
        assert gate_after[2] == 1
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS event_definitions"))
        eng.dispose()
