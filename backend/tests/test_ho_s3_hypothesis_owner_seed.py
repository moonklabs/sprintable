"""HO-S3: hypothesis_owner role seed 마이그(0119) 테스트.

각 org에 ParticipationRole.key='hypothesis_owner' 보장·중복 없음·멱등·downgrade. 실 PG로 마이그
upgrade/downgrade를 직접 구동(0117/0118 검증 패턴). HO-S2 bet verdict가 이 역할에 의존.
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0119_seed_hypothesis_owner_role.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0119", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_seed_hypothesis_owner_per_org_idempotent():
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    org_a, org_b = uuid.uuid4(), uuid.uuid4()

    def _run(fn):
        with eng.begin() as c:
            with Operations.context(MigrationContext.configure(c)):
                getattr(mig, fn)()

    try:
        with eng.begin() as c:
            # 마이그가 의존하는 테이블이 없으면 만든다(fresh DB 격리 — CI는 마이그 체인으로 존재).
            c.execute(sa.text("CREATE TABLE IF NOT EXISTS organizations (id uuid PRIMARY KEY)"))
            c.execute(sa.text(
                "CREATE TABLE IF NOT EXISTS participation_role (id uuid PRIMARY KEY, org_id uuid NOT NULL, "
                "key varchar(50) NOT NULL, label text NOT NULL, is_default boolean NOT NULL DEFAULT false, "
                "created_at timestamptz NOT NULL DEFAULT now())"
            ))
            c.execute(sa.text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_participation_role_org_key "
                "ON participation_role (org_id, key)"
            ))
            c.execute(sa.text("INSERT INTO organizations(id) VALUES (:a),(:b)"), {"a": org_a, "b": org_b})
            # org_a는 이미 hypothesis_owner 보유(중복 방지 검증).
            c.execute(sa.text(
                "INSERT INTO participation_role(id,org_id,key,label) VALUES (:i,:o,'hypothesis_owner','기존')"
            ), {"i": uuid.uuid4(), "o": org_a})

        _run("upgrade")
        _run("upgrade")  # 멱등(2회).

        with eng.begin() as c:
            cnt = lambda o: c.execute(sa.text(
                "SELECT count(*) FROM participation_role WHERE org_id=:o AND key='hypothesis_owner'"
            ), {"o": o}).scalar()
            assert cnt(org_a) == 1, "기존 보유 org도 정확히 1(중복 0)"  # AC②
            assert cnt(org_b) == 1, "신규 org에 1 보장"                # AC①

        _run("downgrade")
        with eng.begin() as c:
            left = c.execute(sa.text(
                "SELECT count(*) FROM participation_role WHERE org_id IN (:a,:b) AND key='hypothesis_owner'"
            ), {"a": org_a, "b": org_b}).scalar()
            assert left == 0  # downgrade 후 제거.
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DELETE FROM participation_role WHERE org_id IN (:a,:b)"), {"a": org_a, "b": org_b})
            c.execute(sa.text("DELETE FROM organizations WHERE id IN (:a,:b)"), {"a": org_a, "b": org_b})
        eng.dispose()
