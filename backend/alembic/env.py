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
        # Fresh OSS DB shortcut (OPT-IN ONLY via SPRINTABLE_OSS_FRESH_INSTALL):
        # create all tables from the models at once and stamp to head, skipping
        # the incremental migration chain.
        #
        # ⚠️ This is UNSAFE for SaaS/Cloud SQL: the SQLAlchemy models have drifted
        # from the migration end-state (e.g. team_members is a VIEW created by
        # migration 0088, project_access.org_member_id NOT NULL was dropped by 0075),
        # so create_all produces a schema that diverges from the migrated one. A
        # blank SaaS DB MUST run the full incremental chain. Therefore the shortcut
        # is gated behind an explicit opt-in flag that ONLY the OSS entrypoint sets;
        # without it, every DB (including a freshly wiped one) follows the normal
        # incremental path below. See bootstrap.py / docker-compose.yml.
        _allow_fresh = os.environ.get("SPRINTABLE_OSS_FRESH_INSTALL", "").strip().lower() in (
            "1", "true", "yes", "on",
        )
        is_fresh = (
            _allow_fresh
            and not insp.has_table("alembic_version")
            and not insp.has_table("organizations")
        )
        if is_fresh:
            from alembic.runtime.migration import MigrationContext as _MigCtx
            from alembic.script import ScriptDirectory
            Base.metadata.create_all(bind=connection)
            script_dir = ScriptDirectory.from_config(config)
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
