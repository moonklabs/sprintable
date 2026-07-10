"""S4-1: 파일 단위 충돌 감지 + 경고 알림."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.file_lock import FileLock
from app.models.team import TeamMember
from app.routers.events import publish_event
from app.services.member_resolver import assert_caller_is_member
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


async def _fetch_scoped_member(
    session: AsyncSession, member_id: uuid.UUID, org_id: uuid.UUID, auth: AuthContext,
) -> TeamMember | None:
    """S17 RC③(까심+codex 델타 RC): _caller_project_hint는 **검증되지 않은 best-effort 최적화**일
    뿐 authz가 아니다(org_id 필터 + 이후 self-scope가 실제 게이트) — hint가 stale/미스매치라 0행이면
    404로 끝내지 말고 힌트 없이 결정적 폴백(ORDER BY project_id, 기존 MED 픽스와 동일 패턴)으로
    재조회한다. X-Project-Id 헤더 미전송 + JWT project가 stale인 정상 caller의 false-404 회귀 방지.
    """
    # S17 RC④(산티아고 최종): 체크리스트 "id+org+active" 명문화 — is_active 필터 추가.
    base_query = select(TeamMember).where(
        TeamMember.id == member_id, TeamMember.org_id == org_id, TeamMember.is_active.is_(True),
    )

    project_hint = _caller_project_hint(auth)
    if project_hint is not None:
        hinted_result = await session.execute(
            base_query.where(TeamMember.project_id == project_hint).limit(1)
        )
        hinted_member = hinted_result.scalars().first()
        if hinted_member is not None:
            return hinted_member

    fallback_result = await session.execute(base_query.order_by(TeamMember.project_id).limit(1))
    return fallback_result.scalars().first()


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
    불일치 row 생성 방지) + caller self-scope 확인(자기 자신 명의로만 lock 가능).

    S19(발견·회귀수정): self-scope는 axis-safe해야 한다 — resolve_member()/.id 직접비교는
    휴먼 JWT caller에게 org_member.id(별개 테이블 PK)를 반환하는데, 이 path의 member_id는
    team_members뷰 id(members anchor)라 축이 달라 휴먼 본인이 자기 파일을 lock해도 항상
    403났다(agent API키 caller만 실증했던 맹점 — auth.user_id가 이미 team_members.id라 안
    드러남). assert_caller_is_member(agent=id 직접비교·human=user_id 비교)로 교체.

    S17 RC②(까심 델타 MED): member 조회에 project_id 힌트 없이 .limit(1)만 쓰면 멀티프로젝트
    휴먼이 엉뚱한 project row로 스코프돼 실제 충돌(타 프로젝트 락)을 놓칠 수 있었다 — caller의
    active/X-Project-Id 컨텍스트(_caller_project_hint)가 있으면 그 project로 결정적으로 좁힌다.
    """
    # AC3-5②: team_members가 뷰(0088) — multi-row 안전(휴먼 multi-project).
    member = await _fetch_scoped_member(session, member_id, org_id, auth)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")

    await assert_caller_is_member(member_id, auth, session, org_id, detail="Cannot lock files as another member")

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

    S17 RC④(산티아고 최종 MUST): UPDATE WHERE에 project_id 필터도 없었다 — 같은 member가 org 내
    여러 project에 동일 file_path를 lock 중이면, 한 project 컨텍스트에서의 unlock이 **다른
    project의 lock까지** 함께 release해 advisory-lock의 project 단위 무결성이 깨졌다(권한상승은
    아니고 데이터 무결성 문제). member.project_id(_fetch_scoped_member가 결정한 그 project)로 좁힌다.

    S19(발견·회귀수정): self-scope를 axis-safe한 assert_caller_is_member로 교체(lock_files와
    동일 사유 — resolve_member()/.id 직접비교는 휴먼 JWT caller의 axis가 어긋나 본인도 403남).
    """
    member = await _fetch_scoped_member(session, member_id, org_id, auth)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")

    await assert_caller_is_member(member_id, auth, session, org_id, detail="Cannot unlock files as another member")

    now = datetime.now(timezone.utc)
    await session.execute(
        update(FileLock)
        .where(
            FileLock.org_id == org_id,
            FileLock.project_id == member.project_id,
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
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    """AC6: 현재 프로젝트 내 활성 file lock 목록.

    E-SECURITY SEC-S8(story 83ea3d6a) Y(까심 전수스윕): 독스트링은 "현재 프로젝트 내"지만
    실제 쿼리는 FileLock.org_id만 필터하고 project_id 필터 자체가 없어 org 전체 lock이
    노출됐다(같은 org 다른 project 멤버도 전 project의 활성 lock을 열람 가능). project_id를
    필수 쿼리 파라미터로 받아 has_project_access로 caller의 실제 접근권도 검증한다."""
    from app.services.project_auth import has_project_access

    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")

    result = await session.execute(
        select(FileLock).where(
            FileLock.org_id == org_id,
            FileLock.project_id == project_id,
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
