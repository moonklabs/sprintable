"""OSS bootstrap: fresh install uses create_all + stamp head, existing DB runs alembic upgrade head.

The create_all shortcut is OPT-IN ONLY (SPRINTABLE_OSS_FRESH_INSTALL): the models have
drifted from the migration end-state (team_members VIEW @0088, project_access.org_member_id
NOT NULL dropped @0075), so create_all produces a schema that diverges from the migrated one.
Without the flag, a fresh DB runs the full incremental chain (safe for SaaS/Cloud SQL).
"""
import asyncio
import os
import subprocess
import sys
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings
from app.core.database import Base
import app.models  # noqa: F401 — registers all models


async def main() -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with engine.connect() as conn:
            result = await conn.execute(
                text("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'alembic_version')")
            )
            has_alembic: bool = bool(result.scalar())
    finally:
        await engine.dispose()

    allow_fresh = os.environ.get("SPRINTABLE_OSS_FRESH_INSTALL", "").strip().lower() in (
        "1", "true", "yes", "on",
    )

    if not has_alembic and allow_fresh:
        print("[bootstrap] Fresh install (OSS opt-in) — running create_all + alembic stamp head")
        sync_url = settings.database_url.replace("postgresql+asyncpg://", "postgresql://")
        from sqlalchemy import create_engine as create_sync_engine
        sync_engine = create_sync_engine(sync_url)
        Base.metadata.create_all(sync_engine)
        sync_engine.dispose()
        subprocess.run(["alembic", "stamp", "head"], check=True)
    else:
        # SaaS / Cloud SQL (and any DB without the opt-in flag) always runs the full
        # incremental chain — create_all would diverge from the migrated schema.
        print("[bootstrap] Running alembic upgrade head (incremental chain)")
        subprocess.run(["alembic", "upgrade", "head"], check=True)


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0)
