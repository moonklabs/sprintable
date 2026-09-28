"""story #4336 PR2(PO 04:32Z) — 공용 작업 줄의 상태 보기. 화면이 202로 받은 작업 id로 끝날 때까지 다시 묻는다.

- 이 조직의 작업이고 **요청한 사람 본인**일 때만(다른 사람 · 다른 조직 = 404 — 있는지조차 알리지 않는다).
- 끝난 작업은 종류별로 펼친 결과(`render_background_job` — 서명 URL처럼 만료되는 값은 지금 새로 만든다). 실패면 요청이 그대로 받았을
  본문(`error = {status_code, detail}`).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.background_job import BackgroundJob
from app.services.background_jobs import render_background_job
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["background-jobs"])


@router.get("/{org_id}/background-jobs/{job_id}")
async def get_background_job(
    org_id: uuid.UUID, job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    member = await resolve_member(auth, org_id, db)
    job = (await db.execute(
        select(BackgroundJob).where(BackgroundJob.id == job_id, BackgroundJob.org_id == org_id)
    )).scalar_one_or_none()
    if job is None or job.requested_by_member_id != member.id:
        raise HTTPException(status_code=404, detail={"code": "BACKGROUND_JOB_NOT_FOUND", "message": str(job_id)})
    return await render_background_job(db, job, auth)
