"""S4-1: 파일 단위 충돌 감지 + 경고 알림."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.file_lock import FileLock
from app.models.team import TeamMember
from app.routers.events import publish_event
from app.services.member_resolver import resolve_member
from app.services.webhook_dispatch import fire_webhooks

router = APIRouter(tags=["file-locks"])

# S17 SHOULD(산티아고 SME): 요청당 file_paths 상한 — 무제한 배열로 인한 과대 row 생성 방지.
_MAX_FILE_PATHS_PER_REQUEST = 200


def _normalize_path(p: str) -> str:
    """S17 SHOULD: `./` 접두·중복 슬래시 정규화 — 같은 파일이 다른 문자열로 충돌 감지를 피하지 않게."""
    n = re.sub(r"/+", "/", p.strip())
    while n.startswith("./"):
        n = n[2:]
    if n in (".", "/"):
        n = ""
    return n


def _validate_paths(v: list[str]) -> list[str]:
    if len(v) > _MAX_FILE_PATHS_PER_REQUEST:
        raise ValueError(f"file_paths exceeds max of {_MAX_FILE_PATHS_PER_REQUEST}")
    normalized = [_normalize_path(p) for p in v]
    # S17 LOW(까심 델타 RC): 정규화 후 빈 문자열(""·"."·".//")로 축약되는 path 거부 — 조율키로
    # 무의미할 뿐더러 조용히 accept되면 충돌감지가 엉뚱한 "빈 경로"끼리 매칭될 수 있다.
    if any(not n for n in normalized):
        raise ValueError("file_paths contains an empty path after normalization")
    return normalized


class FileLockBody(BaseModel):
    file_paths: list[str]
    story_id: uuid.UUID | None = None

    @field_validator("file_paths")
    @classmethod
    def _validate_and_normalize(cls, v: list[str]) -> list[str]:
        return _validate_paths(v)


class FileUnlockBody(BaseModel):
    file_paths: list[str]

    @field_validator("file_paths")
    @classmethod
    def _validate_and_normalize(cls, v: list[str]) -> list[str]:
        return _validate_paths(v)


def _caller_project_hint(auth: AuthContext) -> uuid.UUID | None:
    """S17 MED(까심 델타 RC): caller의 active/X-Project-Id 컨텍스트 — 멀티프로젝트 휴먼의 member
    조회를 특정 project로 결정적으로 좁힌다(get_verified_org_id가 X-Project-Id 헤더 수신 시
    app_metadata.project_id를 갱신 — 미수신 시 JWT/API키 발급 당시 project 폴백)."""
    raw = auth.claims.get("app_metadata", {}).get("project_id")
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except (ValueError, TypeError):
        return None


class ConflictInfo(BaseModel):
    file_path: str
    locked_by_member_id: str
    locked_at: datetime


# ─── 충돌 감지 헬퍼 ──────────────────────────────────────────────────────────

async def _find_conflicts(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    member_id: uuid.UUID,
    file_paths: list[str],
) -> list[ConflictInfo]:
    """동일 file_path를 다른 멤버가 이미 lock 중인지 확인.

    S17(산티아고 SME MUST③): org_id도 명시 필터 — project_id 만으로는 방어에 의존해 org 경계가
    암묵적이라(레코드 오염/실수 시 누출 가능) 일관되게 이중 스코프.
    """
    if not file_paths:
        return []
    result = await session.execute(
        select(FileLock).where(
            FileLock.org_id == org_id,
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
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """AC1/3: 파일 lock 등록 + 충돌 시 warning 반환.

    S17(산티아고 SME MUST②): member 조회에 org_id 필터 추가(타 org member_id로 org_id/project_id
    불일치 row 생성 방지) + caller self-scope 확인(자기 자신 명의로만 lock 가능 — canonical
    resolve_member 축 사용, TeamMember.id 문자열 비교로 우회하지 않게 [[member_bound_resource_resolve_member_axis]]).

    S17 RC②(까심 델타 MED): member 조회에 project_id 힌트 없이 .limit(1)만 쓰면 멀티프로젝트
    휴먼이 엉뚱한 project row로 스코프돼 실제 충돌(타 프로젝트 락)을 놓칠 수 있었다 — caller의
    active/X-Project-Id 컨텍스트(_caller_project_hint)가 있으면 그 project로 결정적으로 좁힌다.
    """
    # AC3-5②: team_members가 뷰(0088) — multi-row 안전(휴먼 multi-project).
    project_hint = _caller_project_hint(auth)
    member_query = select(TeamMember).where(TeamMember.id == member_id, TeamMember.org_id == org_id)
    if project_hint is not None:
        member_query = member_query.where(TeamMember.project_id == project_hint)
    member_result = await session.execute(member_query.order_by(TeamMember.project_id).limit(1))
    member = member_result.scalars().first()
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")

    caller = await resolve_member(auth, org_id, session, project_id=member.project_id)
    if caller.id != member_id:
        raise HTTPException(status_code=403, detail="Cannot lock files as another member")

    # AC3: 충돌 체크
    conflicts = await _find_conflicts(session, org_id, member.project_id, member_id, body.file_paths)

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
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """AC2: 파일 lock 해제.

    S17(산티아고 SME MUST①): 이전엔 path member_id만 신뢰해 org 필터·소유 확인 없이 UPDATE —
    임의 member 명의 lock을 아무나 해제 가능한 구조였다. member 존재+org 확인 후 caller
    self-scope(자기 자신만) 검증 + UPDATE WHERE에 org_id 필터 추가.
    """
    project_hint = _caller_project_hint(auth)
    member_query = select(TeamMember).where(TeamMember.id == member_id, TeamMember.org_id == org_id)
    if project_hint is not None:
        member_query = member_query.where(TeamMember.project_id == project_hint)
    member_result = await session.execute(member_query.order_by(TeamMember.project_id).limit(1))
    member = member_result.scalars().first()
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")

    caller = await resolve_member(auth, org_id, session, project_id=member.project_id)
    if caller.id != member_id:
        raise HTTPException(status_code=403, detail="Cannot unlock files as another member")

    now = datetime.now(timezone.utc)
    await session.execute(
        update(FileLock)
        .where(
            FileLock.org_id == org_id,
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
