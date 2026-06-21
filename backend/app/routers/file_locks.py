"""S4-1: 파일 단위 충돌 감지 + 경고 알림."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.file_lock import FileLock
from app.services.member_resolver import resolve_member
from app.models.team import TeamMember
from app.routers.events import publish_event
from app.services.webhook_dispatch import fire_webhooks

router = APIRouter(tags=["file-locks"])


async def _assert_caller_owns_member(auth, org_id: uuid.UUID, member_id: uuid.UUID,
                                     session: AsyncSession) -> None:
    """⭐RC#1(body-trust 봉인): file-lock path 의 member_id 를 **인증 caller 로 강제** — 타인 명의
    lock 생성/해제(forge·squat) 차단. caller 의 resolved member ≠ path member_id 면 403.
    soft-lock(협업 coordination)이라 escalation 은 아니나 path-trust 위생·일관성."""
    resolved = await resolve_member(auth, org_id, session)
    if resolved.id != member_id:
        raise HTTPException(
            status_code=403, detail="자신의 member_id 로만 파일 lock/unlock 이 가능합니다."
        )


class FileLockBody(BaseModel):
    file_paths: list[str]
    story_id: uuid.UUID | None = None


class FileUnlockBody(BaseModel):
    file_paths: list[str]


class ConflictInfo(BaseModel):
    file_path: str
    locked_by_member_id: str
    locked_at: datetime


# ─── 충돌 감지 헬퍼 ──────────────────────────────────────────────────────────

async def _find_conflicts(
    session: AsyncSession,
    project_id: uuid.UUID,
    member_id: uuid.UUID,
    file_paths: list[str],
) -> list[ConflictInfo]:
    """동일 file_path를 다른 멤버가 이미 lock 중인지 확인."""
    if not file_paths:
        return []
    result = await session.execute(
        select(FileLock).where(
            FileLock.project_id == project_id,
            FileLock.file_path.in_(file_paths),
            FileLock.released_at.is_(None),
            FileLock.member_id != member_id,
        )
    )
    conflicts = result.scalars().all()
    return [
        ConflictInfo(
            file_path=c.file_path,
            locked_by_member_id=str(c.member_id),
            locked_at=c.locked_at,
        )
        for c in conflicts
    ]


async def _publish_conflict_event(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    member_id: uuid.UUID,
    conflicts: list[ConflictInfo],
) -> None:
    """AC4: file_conflict 이벤트 발행 → SSE + Discord 웹훅."""
    event_data: dict[str, Any] = {
        "event_type": "file_conflict",
        "severity": "warn",
        "org_id": str(org_id),
        "project_id": str(project_id),
        "member_id": str(member_id),
        "conflicts": [c.model_dump(mode="json") for c in conflicts],
    }
    try:
        publish_event(str(org_id), "file_conflict", event_data)
    except Exception:
        pass
    try:
        await fire_webhooks(session, org_id, "file_conflict", event_data)
    except Exception:
        pass


# ─── AC1: file-lock ──────────────────────────────────────────────────────────

@router.post("/api/v2/team-members/{member_id}/file-lock")
async def lock_files(
    member_id: uuid.UUID,
    body: FileLockBody,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> dict:
    """AC1/3: 파일 lock 등록 + 충돌 시 warning 반환."""
    await _assert_caller_owns_member(auth, org_id, member_id, session)  # ⭐RC#1: forge 차단
    # AC3-5 ②: team_members가 뷰(0088) — multi-row 안전(휴먼 multi-project) .limit(1).first().
    member_result = await session.execute(
        select(TeamMember).where(TeamMember.id == member_id).limit(1)
    )
    member = member_result.scalars().first()
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")

    # AC3: 충돌 체크
    conflicts = await _find_conflicts(session, member.project_id, member_id, body.file_paths)

    # 새 lock 등록
    now = datetime.now(timezone.utc)
    for fp in body.file_paths:
        session.add(FileLock(
            org_id=org_id,
            project_id=member.project_id,
            member_id=member_id,
            story_id=body.story_id,
            file_path=fp,
            locked_at=now,
        ))
    await session.flush()

    # AC4: 충돌 시 이벤트 발행
    if conflicts:
        await _publish_conflict_event(session, org_id, member.project_id, member_id, conflicts)

    return {
        "locked": True,
        "file_paths": body.file_paths,
        "warning": [c.model_dump(mode="json") for c in conflicts] if conflicts else None,
    }


# ─── AC2: file-unlock ────────────────────────────────────────────────────────

@router.post("/api/v2/team-members/{member_id}/file-unlock")
async def unlock_files(
    member_id: uuid.UUID,
    body: FileUnlockBody,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> dict:
    """AC2: 파일 lock 해제."""
    await _assert_caller_owns_member(auth, org_id, member_id, session)  # ⭐RC#1: forge 차단
    now = datetime.now(timezone.utc)
    await session.execute(
        update(FileLock)
        .where(
            FileLock.member_id == member_id,
            FileLock.file_path.in_(body.file_paths),
            FileLock.released_at.is_(None),
        )
        .values(released_at=now)
    )
    await session.flush()
    return {"unlocked": True, "file_paths": body.file_paths}


# ─── AC6: 활성 file lock 목록 ────────────────────────────────────────────────

@router.get("/api/v2/file-locks")
async def list_file_locks(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[dict]:
    """AC6: 현재 프로젝트 내 활성 file lock 목록."""
    result = await session.execute(
        select(FileLock).where(
            FileLock.org_id == org_id,
            FileLock.released_at.is_(None),
        )
    )
    locks = result.scalars().all()
    return [
        {
            "id": str(lock.id),
            "member_id": str(lock.member_id),
            "story_id": str(lock.story_id) if lock.story_id else None,
            "file_path": lock.file_path,
            "locked_at": lock.locked_at.isoformat(),
        }
        for lock in locks
    ]


# ─── AC7: unclaim 시 file lock 자동 해제 헬퍼 ────────────────────────────────

async def release_all_file_locks(session: AsyncSession, member_id: uuid.UUID) -> None:
    """AC7: unclaim 시 호출 — 해당 멤버의 모든 file lock 해제."""
    now = datetime.now(timezone.utc)
    await session.execute(
        update(FileLock)
        .where(FileLock.member_id == member_id, FileLock.released_at.is_(None))
        .values(released_at=now)
    )
