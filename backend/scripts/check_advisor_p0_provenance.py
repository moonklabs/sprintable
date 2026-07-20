#!/usr/bin/env python3
"""Fail closed before reserving the Advisor P0 application namespace for an org."""
from __future__ import annotations
import argparse
import asyncio
import sys
import uuid
from pathlib import Path

# `python scripts/check_advisor_p0_provenance.py` sets sys.path to scripts/;
# add the backend root so the documented command works without installation.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import text
from app.core.database import async_session_factory

async def main(org_id: uuid.UUID) -> int:
    async with async_session_factory() as session:
        result = await session.execute(text("""
            SELECT (SELECT count(*) FROM evidence WHERE org_id = :oid AND source LIKE 'advisor.%') +
                   (SELECT count(*) FROM gate WHERE org_id = :oid AND neutral_facts IS NOT NULL
                     AND EXISTS (SELECT 1 FROM jsonb_object_keys(neutral_facts) k
                                 WHERE k = 'advisor_origin' OR k LIKE 'advisor_%' OR k LIKE 'executor_advisor_%'))
        """), {"oid": org_id})
        collisions = result.scalar_one()
        print(f"advisor_p0_namespace_collisions={collisions}")
        return 0 if collisions == 0 else 1

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--org", required=True, type=uuid.UUID)
    raise SystemExit(asyncio.run(main(parser.parse_args().org)))
