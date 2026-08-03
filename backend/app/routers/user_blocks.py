"""story #2349 AC3 — 1:1 사용자 차단. Play UGC 정책이 요구하는 block(report와 별개 트랙,
report는 후속). PO 계약(2026-08-02, 스레드 7256d5cc): team_members.id로 키를 잡는다
(members.id는 아직 미배선 SSOT — 대화/메시지가 전부 team_members.id를 쓰는 것과 통일).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.team import TeamMember
from app.models.user_block import UserBlock
from app.routers.conversations import _resolve_member
from app.schemas.user_block import CreateUserBlock, UserBlockResponse

router = APIRouter(prefix="/api/v2/user-blocks", tags=["user-blocks", "Conversations"])


async def _caller_team_member_id(auth: AuthContext, org_id: uuid.UUID, db: AsyncSession) -> uuid.UUID:
    """차단 기능은 team_members.id 축이라 grant-only 휴먼(team_member 행 없음)은 아직 못 쓴다 —
    이미 대화에 참가 중인 caller는 참가 자체가 team_members.id 키잉이라 실제로는 항상 있다
    (block은 이미 메시지를 받은 상대에 대해서만 의미가 있는 동작이라 이 경계가 자연스럽다)."""
    resolved = await _resolve_member(auth, org_id, db)
    if not isinstance(resolved, TeamMember):
        raise HTTPException(status_code=400, detail="team member required to use blocking")
    return resolved.id


@router.post("", response_model=UserBlockResponse, status_code=201)
async def create_user_block(
    body: CreateUserBlock,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> UserBlockResponse:
    blocker_id = await _caller_team_member_id(auth, org_id, db)
    if body.blocked_member_id == blocker_id:
        raise HTTPException(status_code=400, detail="cannot block yourself")
    # 대상이 같은 org 소속인지 확認(cross-org 참조 차단 — IDOR). team_members는 VIEW라 멀티
    # 프로젝트 멤버는 project별 여러 행으로 투영된다 — limit(1)(존재 여부만 필요, scalar_one_or_none
    # 쓰면 MultipleResultsFound로 500난다).
    target = (await db.execute(
        select(TeamMember.id)
        .where(TeamMember.id == body.blocked_member_id, TeamMember.org_id == org_id)
        .limit(1)
    )).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="member not found")
    existing = (await db.execute(
        select(UserBlock).where(
            UserBlock.blocker_member_id == blocker_id,
            UserBlock.blocked_member_id == body.blocked_member_id,
        )
    )).scalar_one_or_none()
    if existing is not None:
        return UserBlockResponse.model_validate(existing)
    block = UserBlock(id=uuid.uuid4(), blocker_member_id=blocker_id, blocked_member_id=body.blocked_member_id)
    db.add(block)
    await db.commit()
    await db.refresh(block)
    return UserBlockResponse.model_validate(block)


@router.delete("/{member_id}", status_code=204)
async def delete_user_block(
    member_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> None:
    blocker_id = await _caller_team_member_id(auth, org_id, db)
    await db.execute(
        delete(UserBlock).where(
            UserBlock.blocker_member_id == blocker_id,
            UserBlock.blocked_member_id == member_id,
        )
    )
    await db.commit()


@router.get("", response_model=list[UserBlockResponse])
async def list_user_blocks(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[UserBlockResponse]:
    # PO 판정(2026-08-02) — user_blocks에 실 FK가 없어(team_members가 VIEW) 멤버가 조직에서
    # 빠져도 행이 고아로 남는다. 정리는 안 하고(멤버 수명주기는 이 스토리 스코프 밖) 조회만
    # 거른다 — «지금 org에 실존하는» member만 내준다(①, PO 선택). 고아 행 자체는 남는다(명시).
    # team_members는 VIEW라 멀티프로젝트 멤버가 여러 행(project별)으로 투영된다 — join 후
    # distinct 없으면 UserBlock이 그 project 수만큼 중복 반환된다.
    blocker_id = await _caller_team_member_id(auth, org_id, db)
    rows = (await db.execute(
        select(UserBlock)
        .join(TeamMember, TeamMember.id == UserBlock.blocked_member_id)
        .where(UserBlock.blocker_member_id == blocker_id, TeamMember.org_id == org_id)
        .distinct()
    )).scalars().all()
    return [UserBlockResponse.model_validate(r) for r in rows]
