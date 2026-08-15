"""story #2635 준비 — migration 0247: agent_api_keys.scope 소급 백필.

카디르 QA verdict(#3030 리뷰 스레드, 2026-08-13): 0246(role_templates)만으로는 이미 발급된
fleet 키에 "events"가 반영되지 않는다 — scope 집행은 매 요청 role_template을 재조회하지
않고 agent_api_keys.scope 스냅샷을 그대로 읽는다(app/dependencies/auth.py 실측). 이 파일이
그 두 번째 절반(실제 소급)을 검증한다.

핵심 위험(직접 테스트로 고정): NULL/빈 배열 scope(=is_tool_allowed 상 "무제한")에
array_append를 잘못 적용하면 "무제한 → events 전용"으로 좁아지는 정반대 재발이 벌어진다 —
이 파일의 첫 두 테스트가 그 역회귀를 정확히 잡는다.
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest

# 페드루군 CI 실측 지적(2026-08-13, #3031): 이 파일은 agent_api_keys 실 테이블을 DROP/CREATE
# 한다 — raw SQL DDL(sa.text)로 직접 하기 때문에 tests/conftest.py의 AST 정적 가드
# (create_all/drop_all 속성 호출만 스캔)가 못 잡는다. 마커 없이 non-destructive CI 잡에
# 편입되면 공유 alembic-migrated DB의 진짜 agent_api_keys 테이블을 떨어뜨려 무관한 뒤 테스트를
# 전멸시킨다(#3029 QA 때 카디르가 겪은 destructive/non-destructive 혼합 오염과 동일 클래스).
pytestmark = pytest.mark.destructive_schema

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0247_agent_api_keys_events_scope_backfill.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0247", _MIG)
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
def test_null_scope_untouched_stays_unrestricted():
    """핵심 회귀 가드 ① — NULL scope(=is_tool_allowed 상 무제한)에 'events'를 심어
    {events}로 좁히면 안 된다. 심으면 그 키는 events 밖 모든 도구를 잃는다."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-null", scope=None)
        _run_migration_fn(eng, mig, "upgrade")
        assert _get_scope(eng, key_id) is None, "NULL scope가 마이그 후에도 NULL이어야 한다(무제한 유지)"
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_empty_array_scope_untouched_stays_unrestricted():
    """핵심 회귀 가드 ② — 빈 배열도 NULL과 동형으로 무제한이다(explicit_groups 공집합 →
    group_ok=True). array_length(빈배열,1)=NULL이 WHERE에서 자동 배제되는지 직접 확인."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-empty", scope=[])
        _run_migration_fn(eng, mig, "upgrade")
        assert _get_scope(eng, key_id) == [], "빈 배열 scope가 마이그 후에도 빈 배열이어야 한다"
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_role_scoped_key_gets_events_appended_and_idempotent():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-role", scope=["stories", "tasks", "chat"])
        _run_migration_fn(eng, mig, "upgrade")
        assert set(_get_scope(eng, key_id)) == {"stories", "tasks", "chat", "events"}

        # 재실행 — 멱등(중복 삽입 없음).
        _run_migration_fn(eng, mig, "upgrade")
        scope_after = _get_scope(eng, key_id)
        assert scope_after.count("events") == 1
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_already_has_events_untouched():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-has", scope=["stories", "events"])
        _run_migration_fn(eng, mig, "upgrade")
        assert _get_scope(eng, key_id).count("events") == 1
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_revoked_key_untouched():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="h-revoked", scope=["stories", "tasks"], revoked=True)
        _run_migration_fn(eng, mig, "upgrade")
        assert "events" not in (_get_scope(eng, key_id) or [])
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_key_hash_and_secret_columns_never_touched():
    """rotate() 미사용 — key_hash가 마이그 전후 완전 동일해야 이미 배포된 raw key가 계속 산다."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        key_id = _insert(eng, key_hash="stable-hash-do-not-touch", scope=["stories"])
        _run_migration_fn(eng, mig, "upgrade")
        with eng.begin() as c:
            row = c.execute(sa.text(
                "SELECT key_hash FROM agent_api_keys WHERE id = :id"
            ), {"id": str(key_id)}).scalar_one()
        assert row == "stable-hash-do-not-touch"
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_downgrade_removes_events_only_from_role_scoped_keys():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    try:
        _setup_table(eng)
        null_key = _insert(eng, key_hash="h-null2", scope=None)
        role_key = _insert(eng, key_hash="h-role2", scope=["stories", "tasks"])

        _run_migration_fn(eng, mig, "upgrade")
        assert "events" in _get_scope(eng, role_key)

        _run_migration_fn(eng, mig, "downgrade")
        assert "events" not in _get_scope(eng, role_key)
        assert set(_get_scope(eng, role_key)) == {"stories", "tasks"}
        assert _get_scope(eng, null_key) is None
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS agent_api_keys"))
        eng.dispose()


def test_group_ok_true_for_empty_or_null_scope_sanity():
    """마이그 SQL의 전제 자체를 코드 레벨로 재확인 — is_tool_allowed가 정말로 빈/NULL
    scope를 "무제한"으로 취급하는지(이 사실이 깨지면 이 마이그의 존재 이유 자체가 무효)."""
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_publish_event", None) is True
    assert is_tool_allowed("sprintable_publish_event", []) is True
    # non-destructive 다른 그룹 도구도 group 축에선 무제한(destructive는 별개 축이라 여기서
    # 섞지 않는다 — sprintable_delete_meeting류는 group_ok=True여도 destructive scope 없이는
    # 여전히 거부되는 게 정상, 이 마이그와 무관한 축).
    assert is_tool_allowed("sprintable_add_story", None) is True


def test_group_ok_false_without_events_for_role_scoped_key():
    """정반대 축 — 명시적으로 좁혀진 scope에 events가 없으면 실제로 거부돼야
    (이 마이그가 고치려는 그 403 재현)."""
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_publish_event", ["stories", "tasks", "chat"]) is False
    assert is_tool_allowed("sprintable_publish_event", ["stories", "tasks", "chat", "events"]) is True
