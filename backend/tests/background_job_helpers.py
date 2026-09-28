"""story #4336 PR2 ② — 공용 작업 줄(`background_jobs`)을 쓰는 비파괴(real DB 공유) 테스트용 도우미.

워커 본체(`process_due_background_jobs`)를 그대로 돌리되 **이 테스트가 넣은 작업 하나만** 집게 due 조건을 좁힌다 — 같은 DB를 나눠 쓰는
다른 테스트(다른 xdist 프로세스)의 작업을 이 프로세스의 목(mock) 없이 대신 돌려 서로를 깨뜨리지 않게.
"""
from __future__ import annotations

import time
import uuid
from unittest.mock import patch


async def run_one_background_job(Session, job_id: str | uuid.UUID) -> dict:
    from sqlalchemy import and_

    from app.models.background_job import BackgroundJob
    from app.services import background_jobs as bg

    only = uuid.UUID(str(job_id))
    due = bg._due_filter
    with patch.object(bg, "_due_filter", lambda now: and_(due(now), BackgroundJob.id == only)):
        async with Session() as s:
            return await bg.process_due_background_jobs(s, deadline_monotonic=time.monotonic() + 600)


async def read_background_job(Session, org_id: uuid.UUID, job_id: str | uuid.UUID, auth) -> dict:
    """작업 상태 보기 라우트(요청한 사람 본인만 · 아니면 404)를 그대로 부른다."""
    from app.routers.background_jobs import get_background_job

    async with Session() as s:
        return await get_background_job(org_id, uuid.UUID(str(job_id)), db=s, verified_org_id=org_id, auth=auth)
