import os
from logging.config import fileConfig

from sqlalchemy import engine_from_config, inspect, pool
from alembic import context

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

from app.core.database import Base
import app.models  # noqa: F401 — register all models with metadata

target_metadata = Base.metadata


def get_url() -> str:
    # ALEMBIC_DATABASE_URL: sync psycopg2 URL (Cloud Run 잡 전용)
    alembic_url = os.environ.get("ALEMBIC_DATABASE_URL")
    if alembic_url:
        return alembic_url

    url = os.environ.get("DATABASE_URL", config.get_main_option("sqlalchemy.url", ""))

    # /cloudsql 소켓 URL 감지: Cloud Run 앱용 URL이라 마이그 잡 불사용.
    # ALEMBIC_DATABASE_URL(Private-IP psycopg2) 없으면 명시적 에러.
    if "/cloudsql/" in url or "host=/cloudsql/" in url:
        alembic_fallback = os.environ.get("ALEMBIC_DATABASE_URL")
        if not alembic_fallback:
            raise RuntimeError(
                "DATABASE_URL uses /cloudsql socket (Cloud Run app URL). "
                "Set ALEMBIC_DATABASE_URL to a Private-IP psycopg2 URL for the migrate job."
            )
        return alembic_fallback

    # asyncpg → psycopg2 변환 (로컬·CI)
    return url.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace("postgresql+asyncpg+ssl://", "postgresql+psycopg2://")


def run_migrations_offline() -> None:
    context.configure(
        url=get_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    cfg = config.get_section(config.config_ini_section, {})
    cfg["sqlalchemy.url"] = get_url()
    connectable = engine_from_config(cfg, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        insp = inspect(connection)
        # Fresh-install path: an EMPTY database (no alembic_version, no application tables) is
        # provisioned from the squashed baseline SNAPSHOT (dev's exact 0096 end-state — schema
        # + global system seed) and then stamped to head. This is the SaaS/Cloud-SQL-correct
        # provisioning: the snapshot includes the team_members VIEW and the dropped NOT NULL
        # constraints, which the old create_all-from-models shortcut got wrong (model drift →
        # the prod onboarding 500). An existing DB (alembic_version present) follows the normal
        # incremental path below — including dev, which is already at 0096 and thus a no-op.
        is_empty = (
            not insp.has_table("alembic_version")
            and not insp.has_table("organizations")
        )
        if is_empty:
            from alembic.runtime.migration import MigrationContext as _MigCtx
            from alembic.script import ScriptDirectory

            script_dir = ScriptDirectory.from_config(config)
            baseline_dir = os.path.join(script_dir.dir, "baseline")
            for _fname in ("schema.sql", "seed.sql"):
                with open(os.path.join(baseline_dir, _fname), "r", encoding="utf-8") as _fh:
                    _sql = _fh.read()
                if _sql.strip():
                    connection.exec_driver_sql(_sql)
            # pg_dump preambles can leave search_path empty; restore it so stamp() can create
            # the alembic_version table without an explicit schema qualifier.
            connection.exec_driver_sql('SET search_path TO "$user", public')
            migration_ctx = _MigCtx.configure(connection)
            migration_ctx.stamp(script_dir, "head")
            connection.commit()
            return

        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
        connection.commit()  # 명시적 커밋 — run_migrations 후 alembic_version 전진 보장


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
