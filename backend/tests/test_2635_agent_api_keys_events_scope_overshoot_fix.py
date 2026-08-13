"""story #2635 fix-forward — migration 0248: 0247이 잘못 좁힌 레거시 scope 원상복구.

카디르가 담당한 0247 테스트(test_2635_agent_api_keys_events_backfill.py)는 NULL scope와
빈 배열 scope의 "무제한 유지"만 pin했다 — **레거시 `['read','write']`(비어있지 않은 배열이지만
ALL_GROUPS 소속 토큰이 하나도 없는 경우)는 어느 테스트에도 없었다**. 이게 정확히 0247의
WHERE(`array_length(scope,1) > 0`)가 통과시켜 사고를 낸 그 케이스다 — 이 파일의 첫 번째
테스트가 그 갭을 메운다(디디/은두카쿠 자신의 레거시 키가 실증 사례).
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest

# 0247 테스트와 동일 이유 — raw DDL(DROP/CREATE TABLE)이라 정적 가드가 못 잡는다.
pytestmark = pytest.mark.destructive_schema

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions",
    "0248_agent_api_keys_events_scope_overshoot_fix.py",
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0248", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _sync_url() -> str:
    return _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )


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
def test_legacy_read_write_key_events_overshoot_reverted():
    """핵심 회귀 가드 — 0247이 놓친 바로 그 갭. scope=['read','write']는 배열 길이>0이라
    0247의 WHERE를 통과해 'events'가 append됐지만, read/write는 ALL_GROUPS 밖이라
    append 전 explicit_groups는 빈 집합(무제한)이었다. 0248이 이걸 되돌려야 한다."""
    import sqlalchemy as sa

    eng = sa.create_engine(_sync_url())
    mig247_path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions",
        "0247_agent_api_keys_events_scope_backfill.py",
    )
    spec = importlib.util.spec_from_file_location("mig0247b", mig247_path)
    mig247 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig247)
    mig248 = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-legacy-rw", scope=["read", "write"])

        # 0247 먼저 적용 — 버그 재현(events가 잘못 붙어 events-only로 좁혀짐).
        _run_migration_fn(eng, mig247, "upgrade")
        assert set(_get_scope(eng, key_id)) == {"read", "write", "events"}

        # 0248 적용 — read/write 외 실 그룹 토큰이 없으므로 events 제거해 원상복구.
        _run_migration_fn(eng, mig248, "upgrade")
        assert set(_get_scope(eng, key_id)) == {"read", "write"}, (
            "레거시 read/write 전용 키는 0248 이후 events가 제거돼 무제한 상태로 돌아와야 한다"
        )
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_legitimately_role_scoped_key_keeps_events():
    """이미 명시적으로 좁혀진 키(예: ['chat','stories'])는 0247의 "넓힌다" 의도가 정확히
    맞았던 케이스 — 0248이 이걸 건드리면 안 된다(events 유지)."""
    import sqlalchemy as sa

    eng = sa.create_engine(_sync_url())
    mig = _load_migration()
    try:
        _setup_table(eng)
        # 0247이 이미 붙여놓은 상태를 직접 시뮬레이션(0247을 다시 로드하지 않고 최종 상태만 시딩).
        key_id = _insert(eng, key_hash="h-role-scoped", scope=["chat", "stories", "events"])
        _run_migration_fn(eng, mig, "upgrade")
        assert set(_get_scope(eng, key_id)) == {"chat", "stories", "events"}, (
            "정당하게 그룹-스코프된 키는 0248이 손대면 안 된다"
        )
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_admin_scoped_key_keeps_events():
    """admin은 ALL_GROUPS엔 없지만 explicit_groups 계산에 별도로 OR돼 들어간다
    (`tokens & {"admin"}`) — 0248의 실그룹 토큰 리스트에도 반드시 포함돼야 한다."""
    import sqlalchemy as sa

    eng = sa.create_engine(_sync_url())
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-admin", scope=["admin", "events"])
        _run_migration_fn(eng, mig, "upgrade")
        assert set(_get_scope(eng, key_id)) == {"admin", "events"}
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_mixed_legacy_and_group_key_keeps_events():
    """레거시 read/write + 실제 그룹 토큰이 섞인 키(['read','write','stories'])는 stories가
    ALL_GROUPS 소속이라 0247 이전부터 이미 명시적으로 좁혀진 상태였다 — events 유지해야 한다."""
    import sqlalchemy as sa

    eng = sa.create_engine(_sync_url())
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-mixed", scope=["read", "write", "stories", "events"])
        _run_migration_fn(eng, mig, "upgrade")
        assert set(_get_scope(eng, key_id)) == {"read", "write", "stories", "events"}
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_null_and_empty_and_no_events_untouched():
    """events가 아예 없는 행(NULL/빈배열/미보유)은 조건절 `'events' = ANY(scope)`에서
    바로 걸러져 손대지 않는다 — no-op 확인."""
    import sqlalchemy as sa

    eng = sa.create_engine(_sync_url())
    mig = _load_migration()
    try:
        _setup_table(eng)
        null_key = _insert(eng, key_hash="h-null", scope=None)
        empty_key = _insert(eng, key_hash="h-empty", scope=[])
        no_events_key = _insert(eng, key_hash="h-noevents", scope=["read", "write"])
        _run_migration_fn(eng, mig, "upgrade")
        assert _get_scope(eng, null_key) is None
        assert _get_scope(eng, empty_key) == []
        assert _get_scope(eng, no_events_key) == ["read", "write"]
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_revoked_key_untouched_even_with_events():
    import sqlalchemy as sa

    eng = sa.create_engine(_sync_url())
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-revoked", scope=["read", "write", "events"], revoked=True)
        _run_migration_fn(eng, mig, "upgrade")
        assert set(_get_scope(eng, key_id)) == {"read", "write", "events"}, (
            "폐기된 키는 0248이 손대지 않는다(다시 인증에 쓰이지 않으므로 무관)"
        )
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_downgrade_restores_post_0247_state_for_fixed_key():
    """downgrade는 0247.upgrade()와 동일 로직 재적용 — 0248이 벗겨낸 것과 정확히 같은
    집합(events 없고 배열 비어있지 않은 살아있는 키)에 다시 events를 append한다."""
    import sqlalchemy as sa

    eng = sa.create_engine(_sync_url())
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


def test_semantics_match_is_tool_allowed_explicit_groups_axis():
    """마이그 SQL의 실그룹 토큰 리스트(_REAL_GROUP_TOKENS)가 is_tool_allowed의
    ALL_GROUPS ∪ {"admin"}과 실제로 동형인지 코드 레벨로 재확인 — 드리프트 시 이 테스트가
    깨진다(그룹이 추가/삭제되면 0248의 리터럴도 갱신해야 한다는 신호)."""
    from app.services.mcp_toolset import ALL_GROUPS

    mig = _load_migration()
    expected = (set(ALL_GROUPS) - {"events"}) | {"admin"}
    assert set(mig._REAL_GROUP_TOKENS) == expected, (
        "0248의 _REAL_GROUP_TOKENS가 app/services/mcp_toolset.py::ALL_GROUPS와 드리프트됐다 — "
        "그룹이 추가/삭제된 뒤 이 마이그 상수를 갱신하지 않은 것"
    )
