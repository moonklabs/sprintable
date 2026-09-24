"""story #4224(까디르 QA b8353dfab [P2]) — migration 0400이 나중 편집을 덮지 않는지.

- upgrade: `action_i18n`에 `en`만 넣고 먼저 있던 다른 로케일 키는 보존.
- downgrade: `en`이 0400이 넣은 값과 같을 때만 지움 · 손본 `en`과 다른 로케일은 보존 · 비면 `action_i18n` 키째 뺌.
migrated(heads) DB의 실제 플랫폼 행에서 up/down/up을 돌리되 **한 트랜잭션 안에서 하고 되돌린다**(DDL 없음 · 공유 DB 무변).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")

_KEY, _STAGE = "preset.workflow.scrum_3step", "kickoff"


def _load_migration():
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0400_preset_stage_action_i18n_en.py"
    spec = importlib.util.spec_from_file_location("_mig_0400_preserve", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _sync_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+asyncpg://", "postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


def _run(conn, mig, fn_name: str) -> None:
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    with Operations.context(MigrationContext.configure(conn)):
        getattr(mig, fn_name)()


def _stage_meta(conn) -> dict:
    import sqlalchemy as sa

    sm = conn.execute(sa.text(
        "SELECT stage_metadata FROM event_definitions WHERE key = :k AND org_id IS NULL"
    ), {"k": _KEY}).scalar_one()
    return sm[_STAGE]


def _set_action_i18n(conn, value) -> None:
    import sqlalchemy as sa

    if value is None:
        conn.execute(sa.text(
            "UPDATE event_definitions SET stage_metadata = stage_metadata #- CAST(:p AS text[]) "
            "WHERE key = :k AND org_id IS NULL"
        ), {"p": "{" + _STAGE + ",action_i18n}", "k": _KEY})
    else:
        conn.execute(sa.text(
            "UPDATE event_definitions SET stage_metadata = jsonb_set(stage_metadata, CAST(:p AS text[]), CAST(:v AS jsonb), true) "
            "WHERE key = :k AND org_id IS NULL"
        ), {"p": "{" + _STAGE + ",action_i18n}", "v": json.dumps(value), "k": _KEY})


@pytest.fixture
def conn():
    import sqlalchemy as sa

    eng = sa.create_engine(_sync_url())
    c = eng.connect()
    trans = c.begin()
    try:
        yield c
    finally:
        trans.rollback()
        c.close()
        eng.dispose()


def test_other_locale_survives_up_down_up(conn):
    mig = _load_migration()
    en = mig.EN_ACTIONS[(_KEY, _STAGE)]
    _set_action_i18n(conn, {"xx": "keep me"})  # 0400보다 먼저 있던 다른 로케일

    _run(conn, mig, "upgrade")
    assert _stage_meta(conn)["action_i18n"] == {"xx": "keep me", "en": en}
    _run(conn, mig, "downgrade")
    assert _stage_meta(conn)["action_i18n"] == {"xx": "keep me"}
    _run(conn, mig, "upgrade")
    assert _stage_meta(conn)["action_i18n"] == {"xx": "keep me", "en": en}


def test_downgrade_keeps_hand_edited_en(conn):
    mig = _load_migration()
    _set_action_i18n(conn, {"en": "Edited later by hand"})
    _run(conn, mig, "downgrade")
    assert _stage_meta(conn)["action_i18n"] == {"en": "Edited later by hand"}


def test_downgrade_of_own_value_removes_empty_object(conn):
    mig = _load_migration()
    _set_action_i18n(conn, None)
    _run(conn, mig, "upgrade")
    assert _stage_meta(conn)["action_i18n"] == {"en": mig.EN_ACTIONS[(_KEY, _STAGE)]}
    _run(conn, mig, "downgrade")
    meta = _stage_meta(conn)
    assert "action_i18n" not in meta
    assert meta.get("action")  # 단계의 나머지(ko action 등)는 그대로


def test_upgrade_replaces_non_object_action_i18n(conn):
    mig = _load_migration()
    _set_action_i18n(conn, "not-an-object")
    _run(conn, mig, "upgrade")
    assert _stage_meta(conn)["action_i18n"] == {"en": mig.EN_ACTIONS[(_KEY, _STAGE)]}
