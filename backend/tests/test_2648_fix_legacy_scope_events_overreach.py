"""story #2648(P0) — migration 0248: 0247의 레거시 scope 오버리치 fix-forward.

실사고(2026-08-14, 디디 자신의 dev 키): 0247이 `['read','write']`(레거시, 실제로는
is_tool_allowed() 상 무제한)에 'events'를 append해 `['read','write','events']`가 됐고,
그 결과 explicit_groups={'events'}(비어있지 않음)가 돼 events 밖 모든 도구가 403됐다.

검증 축:
- AC1(핵심 회귀 재현+수복): 레거시 scope가 0247 실행 후 겪은 정확한 상태를 재현하고, 0248이
  'events'만 제거해 원상복구하는지.
- AC2: 진짜 role-derived 키(실제 그룹 포함)는 손대지 않는지 — 0247의 원래 의도 보존.
- AC3: is_tool_allowed() 왕복으로 "수복 후 실제로 무제한 동작이 돌아왔는지"까지 확인(문자열
  조작만 보고 끝내지 않는다).
- AC4: revoked 키·events 없는 키는 대상 밖.
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0248_fix_legacy_scope_events_overreach.py"
)

pytestmark = pytest.mark.destructive_schema


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0248", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _run_migration_fn(eng, mig, fn_name: str) -> None:
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    with eng.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            getattr(mig, fn_name)()


def _setup_table(eng) -> None:
    import sqlalchemy as sa

    with eng.begin() as c:
        c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        c.execute(sa.text(
            "CREATE TABLE agent_api_keys (id uuid PRIMARY KEY, key_hash text NOT NULL, "
            "scope text[], revoked_at timestamptz)"
        ))


def _insert(eng, *, key_hash: str, scope, revoked: bool = False) -> uuid.UUID:
    import sqlalchemy as sa

    key_id = uuid.uuid4()
    with eng.begin() as c:
        c.execute(sa.text(
            "INSERT INTO agent_api_keys (id, key_hash, scope, revoked_at) "
            "VALUES (:id, :key_hash, :scope, NULL)"
        ), {"id": str(key_id), "key_hash": key_hash, "scope": scope})
        if revoked:
            c.execute(sa.text(
                "UPDATE agent_api_keys SET revoked_at = now() WHERE id = :id"
            ), {"id": str(key_id)})
    return key_id


def _get_scope(eng, key_id: uuid.UUID):
    import sqlalchemy as sa

    with eng.begin() as c:
        row = c.execute(sa.text(
            "SELECT scope FROM agent_api_keys WHERE id = :id"
        ), {"id": str(key_id)}).fetchone()
    return list(row[0]) if row[0] is not None else None


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_ac1_legacy_read_write_events_overreach_is_reverted():
    """디디 자신의 dev 키가 겪은 정확한 시나리오 재현 — 0247 실행 직후 상태(['read','write',
    'events'])를 직접 시드하고, 0248이 events만 제거해 ['read','write']로 복원하는지."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="didi-real-key", scope=["read", "write", "events"])

        _run_migration_fn(eng, mig, "upgrade")

        assert _get_scope(eng, key_id) == ["read", "write"], (
            "레거시 read/write 키에서 events가 정확히 제거돼 사고 이전 상태로 복원돼야 한다"
        )
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_ac1_idempotent_rerun():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="k", scope=["read", "write", "events"])
        _run_migration_fn(eng, mig, "upgrade")
        _run_migration_fn(eng, mig, "upgrade")
        assert _get_scope(eng, key_id) == ["read", "write"]
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_ac2_real_role_derived_scope_is_not_touched():
    """진짜 role-derived 키(stories/tasks 같은 실 그룹 포함)는 0247의 원래 의도대로 events를
    유지해야 한다 — 0248이 과교정해 정당한 부여까지 걷으면 그것도 회귀."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="backend-agent", scope=["stories", "tasks", "chat", "events"])

        _run_migration_fn(eng, mig, "upgrade")

        assert set(_get_scope(eng, key_id)) == {"stories", "tasks", "chat", "events"}, (
            "진짜 role-derived 키는 손대지 않아야 한다"
        )
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_ac2_mixed_legacy_and_real_group_keeps_events():
    """레거시 read/write + 실제 그룹 토큰이 섞인 키(['read','write','stories','events'])는
    'stories'가 ALL_GROUPS 소속이라 0247 이전부터 이미 명시적으로 좁혀진 상태였다 — 순수
    레거시 케이스(AC1)와 정확히 갈리는 경계를 확인."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="mixed", scope=["read", "write", "stories", "events"])

        _run_migration_fn(eng, mig, "upgrade")

        assert set(_get_scope(eng, key_id)) == {"read", "write", "stories", "events"}
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_ac2_admin_only_scope_is_not_touched():
    """admin 토큰만 있는 scope도(is_tool_allowed 상 explicit_groups에 admin이 걸려 진짜
    restrictive) 대상 밖이어야 한다."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="admin-agent", scope=["admin", "events"])

        _run_migration_fn(eng, mig, "upgrade")

        assert set(_get_scope(eng, key_id)) == {"admin", "events"}
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_ac4_revoked_key_not_touched():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="revoked", scope=["read", "write", "events"], revoked=True)

        _run_migration_fn(eng, mig, "upgrade")

        assert _get_scope(eng, key_id) == ["read", "write", "events"]
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_ac4_key_without_events_not_touched():
    """이미 events가 없는 레거시 키(0247이 아직 안 건드렸거나 애초에 대상 아니었던 행)는
    이 마이그가 손댈 이유가 없다 — 조건에 'events' = ANY(scope)가 있어 자연히 제외되지만
    직접 확인."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="no-events", scope=["read", "write"])

        _run_migration_fn(eng, mig, "upgrade")

        assert _get_scope(eng, key_id) == ["read", "write"]
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_downgrade_leaves_already_events_key_untouched():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="k2", scope=["stories", "events"])
        _run_migration_fn(eng, mig, "downgrade")
        assert set(_get_scope(eng, key_id)) == {"stories", "events"}
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_downgrade_restores_post_0247_state_for_fixed_key():
    """단일 스텝 downgrade가 이 마이그가 벗겨낸 것과 정확히 같은 집합에 다시 events를
    append해 0248 적용 직전(=0247 직후) 상태로 복원하는지 — no-op이 아니라 실제 재적용."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-roundtrip", scope=["read", "write"])
        _run_migration_fn(eng, mig, "downgrade")
        assert set(_get_scope(eng, key_id)) == {"read", "write", "events"}
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


def test_migration_group_vocab_matches_live_all_groups():
    """드리프트 가드 — 마이그의 하드코딩 리터럴(_RESTRICTIVE_VOCAB)이 실제 app/services/
    mcp_toolset.ALL_GROUPS와 지금도 일치하는지 코드 레벨로 재확인. 그룹이 추가/삭제되면 이
    테스트가 깨져 "0248의 리터럴도 갱신하라"는 신호를 준다(향후 그룹 신설 시 이 마이그를
    복사해 쓸 사람을 위한 회귀 가드 — data-migration 스냅샷 특성상 이 마이그 자체는
    과거 시점 기준으로 계속 옳지만, 패턴을 복제할 때 드리프트를 막는다)."""
    from app.services.mcp_toolset import ALL_GROUPS

    mig = _load_migration()
    expected = (set(ALL_GROUPS) - {"events"}) | {"admin"}
    assert set(mig._RESTRICTIVE_VOCAB) == expected, (
        "0248의 _RESTRICTIVE_VOCAB이 app/services/mcp_toolset.py::ALL_GROUPS와 드리프트됐다"
    )


# ─── AC3: is_tool_allowed 왕복 — 수복 후 실제 무제한 동작이 돌아왔는지 ──────────────────

def test_ac3_legacy_scope_before_bug_is_unrestricted():
    """사고 이전(정상) 상태의 전제 자체를 코드로 재확인 — ['read','write']는 무제한이어야
    한다(explicit_groups 공집합)."""
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_send_chat_message", ["read", "write"]) is True
    assert is_tool_allowed("sprintable_publish_event", ["read", "write"]) is True


def test_ac3_bug_state_incorrectly_narrows_to_events_only():
    """사고 발생 상태(0247 실행 직후, 수복 전) — chat이 막히는 그 정확한 증상을 코드로
    재확인(이 마이그의 존재 이유 자체)."""
    from app.services.mcp_toolset import is_tool_allowed

    buggy_scope = ["read", "write", "events"]
    assert is_tool_allowed("sprintable_publish_event", buggy_scope) is True
    assert is_tool_allowed("sprintable_send_chat_message", buggy_scope) is False, (
        "이게 바로 디디 키가 실제로 겪은 403 — chat이 막혔다"
    )


def test_ac3_after_fix_restores_full_access():
    """0248이 만드는 최종 상태(['read','write'])가 실제로 무제한을 복원하는지."""
    from app.services.mcp_toolset import is_tool_allowed

    fixed_scope = ["read", "write"]
    assert is_tool_allowed("sprintable_send_chat_message", fixed_scope) is True
    assert is_tool_allowed("sprintable_publish_event", fixed_scope) is True
    assert is_tool_allowed("sprintable_claim_story", fixed_scope) is True
