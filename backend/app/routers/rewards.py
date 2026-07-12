import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import _is_org_admin
from app.models.project import Project
from app.repositories.reward import RewardRepository
from app.schemas.reward import BalanceResponse, GrantReward, LeaderboardEntry, RewardLedgerResponse
from app.services.member_resolver import is_caller_member, resolve_member
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/rewards", tags=["rewards"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> RewardRepository:
    return RewardRepository(session, org_id)


async def _assert_self_or_org_admin(
    member_id: uuid.UUID, auth: AuthContext, session: AsyncSession, org_id: uuid.UUID,
) -> None:
    if await is_caller_member(member_id, auth, session, org_id):
        return
    if await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        return
    raise HTTPException(status_code=403, detail="Not authorized for this member")


@router.get("", response_model=list[RewardLedgerResponse])
async def list_rewards(
    project_id: uuid.UUID = Query(...),
    member_id: uuid.UUID | None = Query(default=None),
    repo: RewardRepository = Depends(_get_repo),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[RewardLedgerResponse]:
    # ratchet round3(story 8aec83b3 패턴): org_id는 RewardRepository 생성자에서 이미 스코프되나
    # project_id 쿼리파라미터(조회대상 자체)에 caller 접근권 검증이 없어 same-org cross-project
    # 리워드 원장이 노출됐다 — resource-actual project_id 직접검증.
    if not await has_project_access(repo.session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

    items = await repo.list(project_id=project_id, member_id=member_id)
    return [RewardLedgerResponse.model_validate(i) for i in items]


@router.get("/balance", response_model=BalanceResponse)
async def get_balance(
    project_id: uuid.UUID = Query(...),
    member_id: uuid.UUID = Query(...),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: RewardRepository = Depends(_get_repo),
) -> BalanceResponse:
    """prod 핫픽스(S20 전수스캔 MUST): self-or-org-admin — 이전엔 caller-ownership 확인이 전혀
    없어 org 내 임의 멤버가 타 멤버의 리워드 잔액(재무정보)을 열람할 수 있었다."""
    await _assert_self_or_org_admin(member_id, auth, repo.session, org_id)
    balance = await repo.get_balance(project_id=project_id, member_id=member_id)
    return BalanceResponse(project_id=project_id, member_id=member_id, balance=balance)


@router.post("", response_model=RewardLedgerResponse, status_code=201)
async def grant_reward(
    body: GrantReward,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: RewardRepository = Depends(_get_repo),
) -> RewardLedgerResponse:
    """prod 핫픽스(S20 전수스캔 MUST, 최우선): org-admin 게이트 + granted_by 서버파생.

    이전엔 admin/role 체크가 전무해 org 내 임의 멤버가 타 멤버에게 임의 금액의 리워드를 발행할
    수 있었고, `granted_by`도 body에서 그대로 신뢰돼(client-supplied) 지급자를 스푸핑할 수
    있었다. org-admin 전용으로 닫고, granted_by는 caller 본인에서 서버-파생(body 값 무시).
    """
    if not await _is_org_admin(repo.session, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")

    # AC3-2d(2): member_id(수령자)·granted_by(지급자) canonical 정규화. (A) write.
    from app.services.member_resolver import canonicalize_member_id
    member_id = await canonicalize_member_id(body.member_id, repo.session)
    caller_member = await resolve_member(auth, org_id, repo.session)
    granted_by = await canonicalize_member_id(caller_member.id, repo.session)  # S20: caller에서 서버-파생(body 무시)
    entry = await repo.grant(
        project_id=body.project_id,
        member_id=member_id,
        amount=body.amount,
        reason=body.reason,
        granted_by=granted_by,
        reference_type=body.reference_type,
        reference_id=body.reference_id,
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Member not found in project")
    return RewardLedgerResponse.model_validate(entry)


@router.get("/leaderboard", response_model=list[LeaderboardEntry])
async def get_leaderboard(
    project_id: uuid.UUID = Query(...),
    period: str = Query(default="all"),
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    repo: RewardRepository = Depends(_get_repo),
) -> list[LeaderboardEntry]:
    """산티아고 SME fast-follow(S20 전수봉인): project_id가 caller org 소속인지 검증 없어
    타 org의 리더보드(재무/성과 aggregate)가 project_id만 알면 노출됐다 — 이제 명시 403."""
    if period not in ("daily", "weekly", "monthly", "all"):
        raise HTTPException(status_code=400, detail="period must be one of: daily, weekly, monthly, all")
    proj_check = await repo.session.execute(
        select(Project.id).where(Project.id == project_id, Project.org_id == org_id)
    )
    if proj_check.scalar_one_or_none() is None:
        raise HTTPException(status_code=403, detail="project not accessible")
    items = await repo.leaderboard(project_id=project_id, period=period, limit=limit, cursor=cursor)
    return [LeaderboardEntry.model_validate(i) for i in items]
