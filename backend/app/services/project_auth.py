"""프로젝트 인가 공유 헬퍼.

switch_project / switch_org / me/memberships의 인가 술어를 SSOT로 관리.
3-branch 기준: team_member ∪ project_access(granted) ∪ owner/admin org-wide.
"""
from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import or_, select, text, true
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.models.member import Member
from app.models.project import OrgMember, Project
from app.models.project_access import ProjectAccess
from app.models.team import TeamMember

# E-MEMBER-POLICY S1: 프로젝트 역할 1급 enum(owner/admin/member). org 역할의 'manager'는 project
# 레벨엔 없음(§9-2 결정). project_access.role 은 0122 CHECK 로 이 집합만 허용 → 모든 write 경로가
# 이 집합으로 clamp 돼야 CHECK 위반(500)이 없다. 랭크: owner > admin > member.
PROJECT_ROLES: tuple[str, ...] = ("owner", "admin", "member")
PROJECT_ROLE_RANK: dict[str, int] = {"owner": 3, "admin": 2, "member": 1}


def assert_target_in_caller_org(
    caller_org_id: uuid.UUID,
    target_org_id: uuid.UUID | None,
    *,
    not_found_detail: str = "Not found",
) -> None:
    """E-SECURITY SEC-S6/S7 계열 cross-org IDOR 공통 가드.

    까심 QA 부수발견 D(roster: project_id)·E(persona: agent_id) 공통 근본 — 호출자 org를 body/
    query param으로 받은 target(project·agent 등 어떤 org-scoped 엔티티든)의 **실제** org와 대조한
    적이 없어, target_id만 알면 어느 org 소속이든 caller org와 무관하게 통과됐다. 호출부가
    target의 실 org_id를 먼저 조회(엔티티마다 다른 쿼리)해 이 단일 비교 지점으로 넘기면 된다.
    미존재(target_org_id=None)도 불일치와 동일하게 404 — 존재 비노출(타 org에 그 리소스가 있는지
    자체가 정보 누수).
    """
    if target_org_id is None or target_org_id != caller_org_id:
        raise HTTPException(status_code=404, detail=not_found_detail)


def clamp_project_role(role: str | None) -> str:
    """project_access.role 로 쓸 값을 enum 으로 정규화 — 비-enum(예: 레거시 'manager'·빈값)은 'member'.

    0122 CHECK(role IN owner/admin/member) 위반 방지의 단일 정규화 지점. write 경로(앵커 placement·
    PATCH anchor update)가 이걸 통과시켜 비-enum 값이 DB 에 들어가지 않게 한다.
    """
    return role if role in PROJECT_ROLES else "member"


async def get_project_role(
    session: AsyncSession,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
) -> str | None:
    """프로젝트에서 user(휴먼 JWT user_id | 에이전트 member_id)의 **effective** 프로젝트 역할.

    effective = max_rank(project_access.role, org owner/admin floor). 즉 명시 project 역할과
    org owner/admin 의 org-wide 권한 중 높은 것. `_effective_role`(auth.py)의 max(org,project)와 정합.
    역할/접근이 전혀 없으면 None. org member/manager 는 project authority 를 *부여하지 않음*(floor 아님).

    휴먼: project_access 는 org_member_id→users.id 로, 에이전트: member_id 로 매칭(둘 다 OR). asyncpg
    text 함정 회피 위해 uuid.UUID 를 직접 바인딩(:param IS NULL/::uuid syntax 회피).
    """
    row = (
        await session.execute(
            text(
                """
                SELECT
                  (SELECT om.role FROM org_members om
                     JOIN projects p ON p.org_id = om.org_id
                    WHERE p.id = :pid AND om.user_id = :uid AND om.deleted_at IS NULL
                    LIMIT 1) AS org_role,
                  (SELECT pa.role FROM project_access pa
                     LEFT JOIN org_members om2 ON pa.org_member_id = om2.id
                    WHERE pa.project_id = :pid AND pa.permission = 'granted'
                      AND (om2.user_id = :uid OR pa.member_id = :uid)
                    LIMIT 1) AS proj_role
                """
            ),
            {"pid": project_id, "uid": user_id},
        )
    ).one_or_none()
    if row is None:
        return None
    org_role, proj_role = row[0], row[1]
    candidates: list[str] = []
    if proj_role is not None:
        candidates.append(clamp_project_role(proj_role))
    if org_role in ("owner", "admin"):  # org owner/admin 만 project authority floor(org-wide)
        candidates.append(org_role)
    if not candidates:
        return None
    return max(candidates, key=lambda r: PROJECT_ROLE_RANK[r])


async def resolve_project_relay_owner(
    session: AsyncSession,
    project_id: uuid.UUID,
    org_id: uuid.UUID,
) -> uuid.UUID | None:
    """프로젝트의 단일 relay-owner canonical member id 해소(E-DG S27 sprint dispatch anchor).

    sprint 은 assignee 컬럼이 없어, 전이 wake 대상을 프로젝트 책임자로 relay 한다. owner 해소는
    member-SSOT(project_access granted ∪ org owner/admin floor)를 따르며 — ad-hoc TeamMember.role
    리졸버 금지(event_notifications/docs 가 자체 team_member 리졸버를 굴려 grant/admin 403 드리프트를
    낸 그 함정 회피). 반환은 **canonical member id 1개**(team_members.id | org_members.id)라
    `resolve_member_identity()`의 human notification / agent wake 분기에 그대로 물린다.

    우선순위(deterministic):
      1. project_access(permission='granted', role='owner') — pa.member_id(team_member) ∪
         pa.org_member_id(grant-only 휴먼). human/agent 무관(agent-PO 도 relay 대상).
      2. org_members.role='owner' (org-wide floor).
      3. org_members.role='admin'.
    동순위 tie-break = created_at ASC, id ASC.

    ⚠️S27 QA(산티아고 SME) 블로커 fix: 후보를 우선순위로 정렬해 **org 에서 실제 resolve 가능한 첫
    후보**를 반환한다. stale/cross-org/orphan project_access(role='owner') row 가 있어도 그 id 가
    org 에서 resolve 안 되면 skip 하고 다음 우선순위(org owner/admin floor)로 fallthrough — 데이터
    드리프트가 floor 가드를 무력화하지 못하게. resolve 가능성 판정은 `resolve_member_identity`(SSOT
    oracle)에 위임 — SQL 로 멤버 존재 술어를 재구현하면 그게 또 드리프트 소스가 되므로 금지.
    없으면 None(no_assignee 가시화 — 가짜 fallback 금지). asyncpg text 함정 회피: uuid 직접 바인딩.
    """
    from app.services.member_resolver import resolve_member_identity  # lazy(순환 import 회피)

    rows = (
        await session.execute(
            text(
                """
                SELECT cid FROM (
                    SELECT COALESCE(pa.member_id, pa.org_member_id) AS cid,
                           1 AS src_rank, pa.created_at AS created_at
                      FROM project_access pa
                      JOIN projects p ON p.id = pa.project_id
                     WHERE pa.project_id = :pid AND p.org_id = :oid
                       AND pa.permission = 'granted' AND pa.role = 'owner'
                       AND COALESCE(pa.member_id, pa.org_member_id) IS NOT NULL
                    UNION ALL
                    SELECT om.id AS cid, 2 AS src_rank, om.created_at AS created_at
                      FROM org_members om
                      JOIN projects p ON p.org_id = om.org_id
                     WHERE p.id = :pid AND om.org_id = :oid
                       AND om.role = 'owner' AND om.deleted_at IS NULL
                    UNION ALL
                    SELECT om.id AS cid, 3 AS src_rank, om.created_at AS created_at
                      FROM org_members om
                      JOIN projects p ON p.org_id = om.org_id
                     WHERE p.id = :pid AND om.org_id = :oid
                       AND om.role = 'admin' AND om.deleted_at IS NULL
                ) cands
                ORDER BY src_rank ASC, created_at ASC, cid ASC
                """
            ),
            {"pid": project_id, "oid": org_id},
        )
    ).all()
    seen: set[uuid.UUID] = set()
    for row in rows:
        cid = row[0]
        if cid in seen:  # 한 멤버가 여러 tier 에 걸릴 수 있음(이미 시도한 건 skip)
            continue
        seen.add(cid)
        if await resolve_member_identity(cid, org_id, session) is not None:
            return cid  # 우선순위 순 최초 resolve 가능 후보
    return None


async def has_project_role(
    session: AsyncSession,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    *,
    min_role: str,
) -> bool:
    """effective 프로젝트 역할이 min_role 랭크 이상인지(owner>admin>member). 역할 없으면 False."""
    role = await get_project_role(session, user_id, project_id)
    if role is None:
        return False
    return PROJECT_ROLE_RANK.get(role, 0) >= PROJECT_ROLE_RANK.get(min_role, 99)


def _project_access_predicate(
    project_id_col: "ColumnElement | uuid.UUID",
    *,
    user_id: "ColumnElement | uuid.UUID",
    org_id: uuid.UUID | None,
) -> ColumnElement:
    """story #1994(E-KNOWLEDGE-LINK S2) 5회차 pass: `has_project_access`의 4-branch WHERE-로직을
    atom-level SSOT로 뽑아낸 SQLAlchemy Core 불리언 표현식. 이 **한 함수**가 두 가지로 렌더된다:

      1. `has_project_access` — `project_id_col`에 리터럴 `project_id` UUID를 넘긴다(기존
         `has_project_access`의 동작과 byte-identical — 아래 코멘트에 원본 raw-SQL 대응 분기를
         1:1로 남겨둠).
      2. `project_access_valid_correlated` — `project_id_col`에 outer 쿼리의 correlated 컬럼
         (예: `Doc.project_id`/`Conversation.project_id`)을 넘긴다. SQLAlchemy Core의 `exists()`는
         컬럼 참조가 리터럴이든 이미 outer FROM에 있는 테이블의 컬럼이든 동일하게 컴파일하므로,
         "문자열 SQL 템플릿을 두 번 타이핑"하는 방식보다 이쪽이 더 견고하다고 판단해 채택함
         (산티아고 5회차 스펙의 "동등하게 수용 가능한 대안" 중 Core 방식 — 중복 타이핑 리스크가
         구조적으로 0). `has_project_access`의 기존 호출부(코드베이스 전역 70+ 콜사이트)는 이
         리팩터 후에도 동일 시그니처·동일 반환값을 유지한다(아래 재작성된 `has_project_access`
         참조).

    `org_id=None`이면 기존 cross-org-허용 의미(모든 org 스코프 필터 생략)를 그대로 보존한다.

    branch별 원본 raw-SQL 대응(변경 없음 — 그대로 이식):
      · team_member(human, org-가드 없음 — 상위 project org-스코프가 이미 봉합, QA RC HIGH①)
      · project_access(human, org_member 경유) — org_id 지정 시 om.org_id 필터
      · project_access(agent, member 경유, 18073a52) — org_id 지정 시 m.org_id 필터
      · org owner/admin(org-wide, p.org_id = om.org_id 상시 correlate) — org_id 지정 시 om.org_id 추가 필터
    """
    org_scope_project = true() if org_id is None else (Project.org_id == org_id)
    org_scope_human_grant = true() if org_id is None else (OrgMember.org_id == org_id)
    org_scope_agent_grant = true() if org_id is None else (Member.org_id == org_id)
    org_scope_admin = true() if org_id is None else (OrgMember.org_id == org_id)

    team_member_branch = (
        select(1)
        .where(
            TeamMember.project_id == Project.id,
            or_(TeamMember.id == user_id, TeamMember.user_id == user_id),
            TeamMember.is_active.is_(True),
            TeamMember.type == "human",
        )
        .exists()
    )
    human_grant_branch = (
        select(1)
        .select_from(ProjectAccess)
        .join(OrgMember, ProjectAccess.org_member_id == OrgMember.id)
        .where(
            ProjectAccess.project_id == Project.id,
            OrgMember.user_id == user_id,
            OrgMember.deleted_at.is_(None),
            ProjectAccess.permission == "granted",
            org_scope_human_grant,
        )
        .exists()
    )
    agent_grant_branch = (
        select(1)
        .select_from(ProjectAccess)
        .join(Member, ProjectAccess.member_id == Member.id)
        .where(
            ProjectAccess.project_id == Project.id,
            Member.id == user_id,
            Member.type == "agent",
            Member.deleted_at.is_(None),
            ProjectAccess.permission == "granted",
            org_scope_agent_grant,
        )
        .exists()
    )
    admin_branch = (
        select(1)
        .select_from(OrgMember)
        .where(
            OrgMember.user_id == user_id,
            OrgMember.deleted_at.is_(None),
            OrgMember.role.in_(("owner", "admin")),
            Project.org_id == OrgMember.org_id,
            org_scope_admin,
        )
        .exists()
    )

    return (
        select(1)
        .where(
            Project.id == project_id_col,
            Project.deleted_at.is_(None),
            org_scope_project,
            or_(team_member_branch, human_grant_branch, agent_grant_branch, admin_branch),
        )
        .exists()
    )


def project_access_valid_correlated(
    project_id_col: ColumnElement,
    *,
    caller_id: uuid.UUID,
    org_id: uuid.UUID,
) -> ColumnElement:
    """story #1994 5회차 Blocker 1 fix: `project_access_valid` atom을 벌크/per-row 쿼리에 **직접
    correlate**해 심을 수 있는 형태로 노출한다 — `has_project_access`와 정확히 같은
    `_project_access_predicate`를 재사용(재구현 0). `project_id_col`은 outer 쿼리의 컬럼 참조
    (예: `Doc.project_id`/`Conversation.project_id`)여야 한다 — 리터럴을 넘기면 `has_project_access`와
    동치가 되지만 그럴 거면 `has_project_access`를 직접 쓰면 된다.

    호출부는 이 결과를 메인 SELECT의 WHERE절/predicate 조합에 직접 embed해야 한다 — 별도
    SELECT로 먼저 "접근 가능 project id 집합"을 Python set으로 materialize한 뒤 `.in_()`으로
    쓰는 2-phase 패턴(TOCTOU 윈도우 재도입)은 금지. `backlinks.py::list_doc_backlinks`가 이
    함수를 doc-source(`Doc.project_id`)·chat-source(`Conversation.project_id`, `conversation_
    readable_predicate`의 `project_access_valid` 파라미터) 양쪽에 쓴다.
    """
    return _project_access_predicate(project_id_col, user_id=caller_id, org_id=org_id)


async def has_project_access(
    session: AsyncSession,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    org_id: uuid.UUID | None = None,
) -> bool:
    """switch_project 인가 — me/memberships 3-branch와 동일 기준.

    team_member(active) ∪ project_access(granted) ∪ owner/admin org-wide.
    org_id 지정 시 해당 org로 스코프; None이면 cross-org 허용.

    story #1994 5회차: 구현이 `_project_access_predicate`(SSOT, 위 참조)로 교체됐다 — raw
    text() SQL을 SQLAlchemy Core `exists()`로 이식(4개 EXISTS 분기·org-scope 조건 전부 1:1
    보존, 동작 byte-identical). 이 함수의 수십 개 기존 콜사이트(auth.py/standups.py/sprints.py/
    docs.py/gates.py/conversations.py 등)는 무변경."""
    predicate = _project_access_predicate(project_id, user_id=user_id, org_id=org_id)
    result = await session.execute(select(predicate))
    # `scalar_one_or_none()`(구 raw-SQL 관례 `SELECT 1 ... LIMIT 1`과 동일 메서드) 사용 — 실
    # DB에서는 `SELECT EXISTS(...)`가 항상 정확히 1행(True/False, NULL 아님)을 내므로
    # `scalar_one()`과 결과가 동일하지만, 이 메서드를 쓰면 기존 mock 기반 단위테스트(수십 개
    # 콜사이트의 `result.scalar_one_or_none.return_value = None|1` 관례)가 재구현 없이 그대로
    # 호환된다 — 외부 계약(bool 반환) byte-identical 유지의 일부.
    return bool(result.scalar_one_or_none())


async def is_org_owner_or_admin(
    session: AsyncSession,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
) -> bool:
    """user 가 해당 org 의 owner/admin 인지. 파괴적 작업(프로젝트 삭제 등) 게이트용.

    grant(project_access)만으론 불가 — org-level 역할만 통과. has_project_access 의
    owner/admin 분기와 동일 기준(team_member 봐주기 없음).
    """
    row = await session.execute(
        text(
            """
            SELECT 1 FROM org_members
            WHERE user_id = :user_id
              AND org_id = :org_id
              AND deleted_at IS NULL
              AND role IN ('owner', 'admin')
            LIMIT 1
            """
        ),
        {"user_id": user_id, "org_id": org_id},
    )
    return row.scalar_one_or_none() is not None


async def is_org_owner(
    session: AsyncSession,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
) -> bool:
    """user 가 해당 org 의 **owner** 인지(admin 제외). ⭐E-DG S33 gate override 전용 — override 는
    SoD 우회=가장 강력한 액션이라 admin(void/hold/reassign)보다 좁게 owner-only 로 게이트한다.
    is_org_owner_or_admin 과 동일 구조·role='owner' 만."""
    row = await session.execute(
        text(
            """
            SELECT 1 FROM org_members
            WHERE user_id = :user_id
              AND org_id = :org_id
              AND deleted_at IS NULL
              AND role = 'owner'
            LIMIT 1
            """
        ),
        {"user_id": user_id, "org_id": org_id},
    )
    return row.scalar_one_or_none() is not None


async def first_accessible_project_id(
    session: AsyncSession,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
) -> uuid.UUID | None:
    """switch_org/로그인 후 착지할 첫 **접근 가능** project.

    우선순위: team_member 등록 project > grant project > (owner/admin인 경우) org 첫 project.
    ⚠️ has_project_access와 정합 필수 — grant-less 일반 member에게 접근 불가 project를 반환하면
    프론트는 project 있다 여기나 project-scoped API 전부 403(B4). 따라서 3번째 fallback(org 첫
    project)은 **owner/admin org-wide 접근권 보유자에 한정**. 그 외엔 접근 가능 project 없으면 None.
    """
    # 1. team_member 등록 project (기존 우선순위 유지)
    tm_row = await session.execute(
        text(
            """
            SELECT tm.project_id
            FROM team_members tm
            JOIN projects p ON p.id = tm.project_id
            WHERE tm.org_id = :org_id
              AND (tm.id = :user_id OR tm.user_id = :user_id)
              AND tm.is_active = true
              -- 35a0691e: has_project_access lockstep — team_member 분기 휴먼만(에이전트는 grant).
              AND tm.type = 'human'
              AND p.deleted_at IS NULL
            ORDER BY tm.created_at ASC
            LIMIT 1
            """
        ),
        {"user_id": user_id, "org_id": org_id},
    )
    if (val := tm_row.scalar_one_or_none()) is not None:
        return uuid.UUID(str(val))

    # 2. project_access grant 프로젝트
    grant_row = await session.execute(
        text(
            """
            SELECT pa.project_id
            FROM project_access pa
            JOIN org_members om ON pa.org_member_id = om.id
            JOIN projects p ON p.id = pa.project_id
            WHERE om.user_id = :user_id
              AND om.org_id = :org_id
              AND om.deleted_at IS NULL
              AND pa.permission = 'granted'
              AND p.deleted_at IS NULL
            ORDER BY pa.created_at ASC
            LIMIT 1
            """
        ),
        {"user_id": user_id, "org_id": org_id},
    )
    if (val := grant_row.scalar_one_or_none()) is not None:
        return uuid.UUID(str(val))

    # 3. org 첫 project — owner/admin만 (org-wide 접근권 보유, has_project_access owner/admin 분기와 일치).
    #    일반 member는 접근 가능 project(team_member/grant) 없으면 None → 착지 project 없음(접근 불가 project 반환 금지, B4).
    first_row = await session.execute(
        text(
            """
            SELECT p.id FROM projects p
            WHERE p.org_id = :org_id AND p.deleted_at IS NULL
              AND EXISTS (
                  SELECT 1 FROM org_members om
                  WHERE om.user_id = :user_id
                    AND om.org_id = :org_id
                    AND om.deleted_at IS NULL
                    AND om.role IN ('owner', 'admin')
              )
            ORDER BY p.created_at ASC
            LIMIT 1
            """
        ),
        {"user_id": user_id, "org_id": org_id},
    )
    if (val := first_row.scalar_one_or_none()) is not None:
        return uuid.UUID(str(val))

    return None


async def accessible_project_ids_in_org(
    session: AsyncSession,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
) -> list[uuid.UUID]:
    """org 내에서 user가 접근 가능한 project id 전량 (has_project_access 3-branch bulk).

    team_member(active) ∪ project_access(granted) ∪ owner/admin org-wide. 정책B: list_projects가
    이걸로 필터해 접근권 없는 멤버=0 프로젝트, owner/admin=org 전체. has_project_access와 정합.
    """
    rows = await session.execute(
        text(
            """
            SELECT p.id
            FROM projects p
            WHERE p.org_id = :org_id
              AND p.deleted_at IS NULL
              AND (
                EXISTS (
                    SELECT 1 FROM team_members tm
                    WHERE tm.project_id = p.id
                      AND (tm.id = :user_id OR tm.user_id = :user_id)
                      AND tm.is_active = true
                      -- 35a0691e: has_project_access lockstep — team_member 분기 휴먼만(에이전트는 grant).
                      AND tm.type = 'human'
                )
                OR EXISTS (
                    SELECT 1 FROM project_access pa
                    JOIN org_members om ON pa.org_member_id = om.id
                    WHERE pa.project_id = p.id
                      AND om.user_id = :user_id
                      AND om.deleted_at IS NULL
                      AND pa.permission = 'granted'
                      AND om.org_id = :org_id
                )
                OR EXISTS (
                    -- 18073a52: 에이전트 grant 분기 (has_project_access와 lockstep).
                    SELECT 1 FROM project_access pa
                    JOIN members m ON pa.member_id = m.id
                    WHERE pa.project_id = p.id
                      AND m.id = :user_id
                      AND m.type = 'agent'
                      AND m.deleted_at IS NULL
                      AND pa.permission = 'granted'
                      AND m.org_id = :org_id
                )
                OR EXISTS (
                    SELECT 1 FROM org_members om
                    WHERE om.user_id = :user_id
                      AND om.deleted_at IS NULL
                      AND om.role IN ('owner', 'admin')
                      AND om.org_id = :org_id
                )
              )
            ORDER BY p.created_at ASC
            """
        ),
        {"user_id": user_id, "org_id": org_id},
    )
    return [uuid.UUID(str(r[0])) for r in rows.all()]


async def project_accessible_member_ids(
    session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID,
) -> set[uuid.UUID]:
    """E-UI-DAEGBYEON P0-04 후속(story 9ef0f914) — `accessible_project_ids_in_org`의 역방향
    (project 고정 → 접근 가능 member_id 집합). `team_members`(VIEW, human+agent grant를 이미
    member_id 공간으로 통합)만 조회 — 단일 쿼리 배치(N+1 없음).

    ⚠️ org owner/admin의 암묵 org-wide 접근 분기(has_project_access 3번째 조건)는 **의도적으로
    제외**한다 — 이 함수는 실시간 SSE push 수신자 해소 전용이라, 명시 project 소속이 없는 admin에게
    안 밀리는 쪽(false negative)이 잘못 밀리는 쪽(false positive·cross-project 누설)보다 안전.
    write 인가(has_project_access)는 이 함수를 쓰지 않는다 — 그쪽은 기존 3-branch 그대로."""
    rows = await session.execute(
        text(
            """
            SELECT tm.id
            FROM team_members tm
            WHERE tm.project_id = :project_id
              AND tm.org_id = :org_id
              AND tm.is_active = true
            """
        ),
        {"project_id": project_id, "org_id": org_id},
    )
    return {uuid.UUID(str(r[0])) for r in rows.all()}
