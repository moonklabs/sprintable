import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db, get_read_db
from app.models.user import RefreshToken
from app.repositories.org_member import OrgMemberRepository
from app.schemas.org_member import ORG_ROLES, OrgMemberCreate, OrgMemberResponse, OrgMemberUpdate

router = APIRouter(prefix="/api/v2/org-members", tags=["org-members", "Organization"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> OrgMemberRepository:
    return OrgMemberRepository(session, org_id)


async def _require_admin(
    repo: OrgMemberRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> OrgMemberRepository:
    """DB에서 caller의 OrgMember role 확인 — owner 또는 admin만 통과."""
    caller = await repo.get_by_user(uuid.UUID(auth.user_id))
    if caller is None or caller.role not in ("owner", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="org admin 또는 owner 권한 필요",
        )
    return repo


@router.get("", response_model=list[OrgMemberResponse])
async def list_org_members(
    # story #2451(§6 Phase3 A1): org roster·create→self-read 흐름 없음 → read replica.
    # (repo 파라미터는 이 함수 본문에서 미사용이라 제거 — 아래 raw SQL이 session을 직접 씀.)
    session: AsyncSession = Depends(get_read_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    # story #3231(카디르 버그사냥) — 이 GET에만 _require_admin이 안 붙어있어(POST/PATCH/
    # DELETE엔 이미 있었음) 일반 Member가 email 포함 전체 로스터를 그대로 조회할 수
    # 있었다(/organization/roles·/organization/members·settings「org-members」탭 3화면
    # 공용 소비). 페드루 판정(2026-08-30) — 콜라보용 이름 노출은 GET /api/v2/members?
    # project_id=(email 필드 자체 없음·project 접근권 스코프)가 이미 정본으로 서 있어,
    # 이 email 포함 org 전체 로스터는 admin/owner의 관리 행위로만 한정한다(전면 403,
    # FE 숨김이 아니라 서버 거부가 유일 정본).
    _repo: OrgMemberRepository = Depends(_require_admin),
) -> list[OrgMemberResponse]:
    """org_members + users JOIN — email 포함 응답. admin/owner 전용."""
    # E-ONBOARDING S2: 실명 노출 — canonical Member.name → User.display_name → email 순.
    # members는 (org_id, user_id) 활성 휴먼으로 LEFT JOIN (없으면 display_name/email 폴백).
    result = await session.execute(
        text(
            """
            SELECT om.id, om.org_id, om.user_id, om.role,
                   om.created_at, om.deleted_at,
                   u.email,
                   COALESCE(m.name, u.display_name, u.email) AS name
            FROM org_members om
            LEFT JOIN users u ON u.id = om.user_id
            LEFT JOIN members m
                   ON m.org_id = om.org_id AND m.user_id = om.user_id
                  AND m.type = 'human' AND m.deleted_at IS NULL
            WHERE om.org_id = :org_id AND om.deleted_at IS NULL
            ORDER BY om.created_at
            """
        ),
        {"org_id": str(org_id)},
    )
    return [
        OrgMemberResponse(
            id=row.id,
            org_id=row.org_id,
            user_id=row.user_id,
            role=row.role,
            created_at=row.created_at,
            deleted_at=row.deleted_at,
            email=row.email,
            name=row.name,
        )
        for row in result
    ]


@router.get("/eligible-approvers", response_model=list[OrgMemberResponse])
async def list_eligible_approvers(
    session: AsyncSession = Depends(get_read_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[OrgMemberResponse]:
    """org_members + users JOIN — email 포함 응답. owner/admin만(그러나 어떤 role의
    Member도 호출 가능).

    story #3231 2라운드(카디르 QA) — 위 list_org_members를 admin 전용으로 잠그면서
    doc-gate-section.tsx의 결재자 지정 픽커가 후보 0명으로 연쇄 파손됐다(doc.py가
    owner/admin을 결재자로 강제하는데 그 목록 조회가 403). 이 엔드포인트는 그 픽커
    전용 — org의 어떤 role의 Member도 호출 가능(상신하려면 결재 대상을 봐야 하니 정당
    목적)하되 **owner/admin만** 반환한다(전 Member 로스터 아님 — 원 버그와 노출 범위가
    다르다). email은 유지한다 — approver-picker-options.ts 주석의 기존 처방(PO 실계정과
    대행 계정의 동명 오지정 사고, 라벨에 "이름 (이메일)" 병기로 해결)이 email 없이는
    못 서므로, email 제거는 그 fix를 되돌리는 것과 같다(페드루 판정, 2026-08-30).

    list_org_members와 JOIN 뼈대가 거의 같지만 일부러 헬퍼로 안 묶었다 — 공유 헬퍼로
    뽑았다가 test_e_entity_cleanup_s9_validation_name_join.py의 소스-텍스트 검사
    (`inspect.getsource(list_org_members)`에서 "users"/"email"/"JOIN"/"deleted_at"/
    "NULL" 리터럴 존재를 직접 확인)가 깨졌다 — 그 컨벤션(각 라우터 함수가 자기 쿼리를
    스스로 들고 있어야 소스 검사가 유효)을 우회하지 않고 그대로 따른다.
    """
    result = await session.execute(
        text(
            """
            SELECT om.id, om.org_id, om.user_id, om.role,
                   om.created_at, om.deleted_at,
                   u.email,
                   COALESCE(m.name, u.display_name, u.email) AS name
            FROM org_members om
            LEFT JOIN users u ON u.id = om.user_id
            LEFT JOIN members m
                   ON m.org_id = om.org_id AND m.user_id = om.user_id
                  AND m.type = 'human' AND m.deleted_at IS NULL
            WHERE om.org_id = :org_id AND om.deleted_at IS NULL
              AND om.role IN ('owner', 'admin')
            ORDER BY om.created_at
            """
        ),
        {"org_id": str(org_id)},
    )
    return [
        OrgMemberResponse(
            id=row.id,
            org_id=row.org_id,
            user_id=row.user_id,
            role=row.role,
            created_at=row.created_at,
            deleted_at=row.deleted_at,
            email=row.email,
            name=row.name,
        )
        for row in result
    ]


@router.post("", response_model=OrgMemberResponse, status_code=201)
async def create_org_member(
    body: OrgMemberCreate,
    repo: OrgMemberRepository = Depends(_require_admin),
) -> OrgMemberResponse:
    if body.role not in ORG_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of: {', '.join(ORG_ROLES)}")
    # repo.org_id는 JWT에서 추출됨 — body.org_id 무시 (org_id 조작 방지)
    member = await repo.create(user_id=body.user_id, role=body.role)
    return OrgMemberResponse.model_validate(member)


@router.get("/{id}", response_model=OrgMemberResponse)
async def get_org_member(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_get_repo),
) -> OrgMemberResponse:
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    return OrgMemberResponse.model_validate(member)


async def _revoke_user_refresh_tokens(session: AsyncSession, user_id: uuid.UUID) -> None:
    """해당 사용자의 refresh token 전량 revoke."""
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )


@router.patch("/{id}", response_model=OrgMemberResponse)
async def update_org_member(
    id: uuid.UUID,
    body: OrgMemberUpdate,
    repo: OrgMemberRepository = Depends(_require_admin),
) -> OrgMemberResponse:
    if body.role and body.role not in ORG_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of: {', '.join(ORG_ROLES)}")
    data = body.model_dump(exclude_unset=True)
    if "role" in data:
        existing = await repo.get(id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Org member not found")
        if existing.role != data["role"]:
            await _revoke_user_refresh_tokens(repo.session, existing.user_id)
    member = await repo.update(id, **data)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    await repo.session.commit()
    # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
    await repo.session.refresh(member)
    return OrgMemberResponse.model_validate(member)


@router.get("/{id}/affected-projects")
async def get_affected_projects(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_require_admin),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[dict]:
    """해당 org member가 참여 중인 프로젝트 목록 반환 (AC1/AC2/AC3)."""
    from app.models.team import TeamMember
    from app.models.project import Project
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    result = await session.execute(
        text(
            """
            SELECT DISTINCT p.id AS project_id, p.name AS project_name, tm.role
            FROM team_members tm
            JOIN projects p ON p.id = tm.project_id
            WHERE tm.org_id = :org_id
              AND tm.user_id = :user_id
              AND tm.is_active = true
              AND p.deleted_at IS NULL
            ORDER BY p.name
            """
        ),
        {"org_id": str(org_id), "user_id": str(member.user_id)},
    )
    return [
        {"project_id": str(row.project_id), "project_name": row.project_name, "role": row.role}
        for row in result
    ]


@router.delete("/{id}", status_code=200)
async def delete_org_member(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_require_admin),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    existing = await repo.get(id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    # AC5: owner guard — owner는 삭제 불가
    if existing.role == "owner":
        raise HTTPException(status_code=403, detail="조직 owner는 삭제할 수 없습니다")
    await _revoke_user_refresh_tokens(repo.session, existing.user_id)
    # AC3-4 2-2: team_members 뷰 전환 — anchor-only. members가 is_active 유일 소스(레거시 cascade 제거).
    await session.execute(
        text(
            "UPDATE members SET is_active = false"
            " WHERE org_id = :org_id AND user_id = :user_id AND is_active = true"
        ),
        {"org_id": str(org_id), "user_id": str(existing.user_id)},
    )
    # S-MBR-10 AC5: project_access grant 레코드 삭제 (soft delete는 FK CASCADE 미트리거)
    await session.execute(
        text("DELETE FROM project_access WHERE org_member_id = :om_id"),
        {"om_id": str(id)},
    )
    ok = await repo.soft_delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Org member not found")
    return {"ok": True}
