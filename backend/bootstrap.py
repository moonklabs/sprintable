"""OSS bootstrap: fresh install uses create_all + stamp head, existing DB runs alembic upgrade head."""
import asyncio
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

    if not has_alembic:
        print("[bootstrap] Fresh install detected — running create_all + alembic stamp head")
        sync_url = settings.database_url.replace("postgresql+asyncpg://", "postgresql://")
        from sqlalchemy import create_engine as create_sync_engine
        sync_engine = create_sync_engine(sync_url)
        Base.metadata.create_all(sync_engine)
        sync_engine.dispose()
        subprocess.run(["alembic", "stamp", "head"], check=True)
    else:
        print("[bootstrap] Existing DB detected — running alembic upgrade head")
        subprocess.run(["alembic", "upgrade", "head"], check=True)


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0)
