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
    # ALEMBIC_DATABASE_URL: sync URL (docker-compose 전용, 명시적 분리)
    alembic_url = os.environ.get("ALEMBIC_DATABASE_URL")
    if alembic_url:
        return alembic_url
    url = os.environ.get("DATABASE_URL", config.get_main_option("sqlalchemy.url", ""))
    # fallback: asyncpg → psycopg2 변환
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
        # Fresh OSS DB: no application tables and no prior alembic stamp.
        # Skip the incremental migration chain — create all tables at once and
        # stamp to head so subsequent `alembic upgrade head` calls are no-ops.
        # Existing SaaS/Cloud SQL DBs already have tables and an alembic_version
        # row, so they follow the normal incremental path below.
        is_fresh = (
            not insp.has_table("alembic_version")
            and not insp.has_table("organizations")
        )
        if is_fresh:
            Base.metadata.create_all(bind=connection)
            context.configure(connection=connection, target_metadata=target_metadata)
            with context.begin_transaction():
                context.stamp("head")
            return

        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
