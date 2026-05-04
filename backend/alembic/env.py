import os
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from alembic import context

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

from app.core.database import Base
import app.models  # noqa: F401 — register all models with metadata

target_metadata = Base.metadata


def get_url() -> str:
    url = os.environ.get("DATABASE_URL", config.get_main_option("sqlalchemy.url", ""))
    # alembic은 동기 실행 — asyncpg → psycopg2 변환
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
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
