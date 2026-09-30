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
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.models.user import User
from app.models.user_block import UserBlock
from app.routers.conversations import _resolve_member
from app.schemas.user_block import CreateUserBlock, UserBlockResponse

router = APIRouter(prefix="/api/v2/user-blocks", tags=["user-blocks", "Conversations"])


async def _caller_member_id(auth: AuthContext, org_id: uuid.UUID, db: AsyncSession) -> uuid.UUID:
    """story #4444 (PO 23:00Z) — anyone who can be in a conversation can block: a team-member row, or else a membership of
    this org (a grant-only person, e.g. an org owner without a project row). The key is the same value either way —
    a person's team-member id is their org-membership id (0075) — so no row changes."""
    return (await _resolve_member(auth, org_id, db)).id


async def _in_org_members(db: AsyncSession, org_id: uuid.UUID, member_ids: set[uuid.UUID]) -> dict[uuid.UUID, str | None]:
    """story #4444 — of these members, the ones still in this org, with the name to show: a team-member row here (agents ·
    people with a project row) and its name, or else a membership of this org that is not deleted (#4437's two steps) and
    the person's display name. Someone who left, or of another org, is out. Never an email, never a made-up name (#3755)."""
    if not member_ids:
        return {}
    found: dict[uuid.UUID, str | None] = {}
    for mid, name in (await db.execute(
        select(TeamMember.id, TeamMember.name).where(TeamMember.id.in_(member_ids), TeamMember.org_id == org_id)
        .order_by(TeamMember.project_id)  # a person with several project rows: one, the same way every time
    )).all():
        found.setdefault(mid, name)
    rest = member_ids - found.keys()
    if rest:
        for mid, name in (await db.execute(
            select(OrgMember.id, User.display_name).outerjoin(User, User.id == OrgMember.user_id)
            .where(OrgMember.id.in_(rest), OrgMember.org_id == org_id, OrgMember.deleted_at.is_(None))
        )).all():
            found[mid] = name
    return found


@router.post("", response_model=UserBlockResponse, status_code=201)
async def create_user_block(
    body: CreateUserBlock,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> UserBlockResponse:
    blocker_id = await _caller_member_id(auth, org_id, db)
    if body.blocked_member_id == blocker_id:
        raise HTTPException(status_code=400, detail="cannot block yourself")
    # 대상이 같은 org 소속인지 확認(cross-org 참조 차단 — IDOR). story #4444 — a person without a project row counts too
    # (the same two steps); someone who left the org does not.
    if not await _in_org_members(db, org_id, {body.blocked_member_id}):
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
    blocker_id = await _caller_member_id(auth, org_id, db)
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
    # story #4444 — «지금 org에 실존» is the two steps now: a person who lost project access but is still in the org stays
    # listed (they can still talk); someone who left the org is hidden (their row stays).
    blocker_id = await _caller_member_id(auth, org_id, db)
    rows = (await db.execute(select(UserBlock).where(UserBlock.blocker_member_id == blocker_id))).scalars().all()
    present = await _in_org_members(db, org_id, {r.blocked_member_id for r in rows})
    return [
        UserBlockResponse.model_validate(r).model_copy(update={"blocked_member_name": present[r.blocked_member_id]})
        for r in rows if r.blocked_member_id in present
    ]
