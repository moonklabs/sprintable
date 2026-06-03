"""프로젝트 인가 공유 헬퍼.

switch_project / switch_org / me/memberships의 인가 술어를 SSOT로 관리.
3-branch 기준: team_member ∪ project_access(granted) ∪ owner/admin org-wide.
"""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def has_project_access(
    session: AsyncSession,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    org_id: uuid.UUID | None = None,
) -> bool:
    """switch_project 인가 — me/memberships 3-branch와 동일 기준.

    team_member(active) ∪ project_access(granted) ∪ owner/admin org-wide.
    org_id 지정 시 해당 org로 스코프; None이면 cross-org 허용.
    """
    row = await session.execute(
        text(
            """
            SELECT 1
            FROM projects p
            WHERE p.id = :project_id
              AND p.deleted_at IS NULL
              AND (
                EXISTS (
                    SELECT 1 FROM team_members tm
                    WHERE tm.project_id = p.id
                      AND (tm.id = :user_id OR tm.user_id = :user_id)
                      AND tm.is_active = true
                )
                OR EXISTS (
                    SELECT 1 FROM project_access pa
                    JOIN org_members om ON pa.org_member_id = om.id
                    WHERE pa.project_id = p.id
                      AND om.user_id = :user_id
                      AND om.deleted_at IS NULL
                      AND pa.permission = 'granted'
                      AND (CAST(:org_id AS uuid) IS NULL OR om.org_id = :org_id)
                )
                OR EXISTS (
                    SELECT 1 FROM org_members om
                    WHERE om.user_id = :user_id
                      AND om.deleted_at IS NULL
                      AND om.role IN ('owner', 'admin')
                      AND p.org_id = om.org_id
                      AND (CAST(:org_id AS uuid) IS NULL OR om.org_id = :org_id)
                )
              )
            LIMIT 1
            """
        ),
        {"user_id": user_id, "project_id": project_id, "org_id": org_id},
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
