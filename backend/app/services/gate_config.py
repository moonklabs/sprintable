"""HITL 게이트 레벨 config 해소/설정 — E-HITL-GATING S-GATE-1 (정책 hitl-gating-policy-v1 §3).

resolve_gate_level: project 오버라이드 → org 기본값 → 보수적 기본 'ask'(§3e). 안전 하한(§3d)
clamp 는 S-GATE-3, 집행은 S-GATE-2 — 여기선 순수 config 해소. 측정(정책 §5) 위해 구조화 로그.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hitl import HitlGateConfig

logger = logging.getLogger(__name__)

WORK_TYPES: tuple[str, ...] = ("done", "merge")
ACTOR_TYPES: tuple[str, ...] = ("agent", "human")
LEVELS: tuple[str, ...] = ("auto", "ask", "block")
DEFAULT_LEVEL = "ask"  # §3e 보수적 기본


async def resolve_gate_level(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    work_type: str,
    actor_type: str,
) -> str:
    """(work_type × actor)의 effective 게이트 레벨. project 오버라이드 → org 기본값 → 'ask'."""
    if project_id is not None:
        lvl = (
            await session.execute(
                select(HitlGateConfig.level).where(
                    HitlGateConfig.org_id == org_id,
                    HitlGateConfig.project_id == project_id,
                    HitlGateConfig.work_type == work_type,
                    HitlGateConfig.actor_type == actor_type,
                )
            )
        ).scalar_one_or_none()
        if lvl is not None:
            _log_resolved(org_id, project_id, work_type, actor_type, lvl, "project")
            return lvl

    lvl = (
        await session.execute(
            select(HitlGateConfig.level).where(
                HitlGateConfig.org_id == org_id,
                HitlGateConfig.project_id.is_(None),
                HitlGateConfig.work_type == work_type,
                HitlGateConfig.actor_type == actor_type,
            )
        )
    ).scalar_one_or_none()
    result = lvl if lvl is not None else DEFAULT_LEVEL
    _log_resolved(org_id, project_id, work_type, actor_type, result, "org" if lvl is not None else "default")
    return result


def _log_resolved(org_id, project_id, work_type, actor_type, level, source) -> None:
    # 측정 baseline(정책 §5): 집행 전 레벨 분포/coverage 관측용 구조화 로그.
    logger.info(
        "gate_level resolved org=%s project=%s work=%s actor=%s level=%s source=%s",
        org_id, project_id, work_type, actor_type, level, source,
    )


async def set_gate_level(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    work_type: str,
    actor_type: str,
    level: str,
    created_by: uuid.UUID | None,
) -> HitlGateConfig:
    """org 기본값(project_id None) 또는 project 오버라이드 레벨을 upsert(축당 1행). 권한은 호출부(라우터)."""
    if work_type not in WORK_TYPES:
        raise ValueError(f"work_type must be one of {WORK_TYPES}")
    if actor_type not in ACTOR_TYPES:
        raise ValueError(f"actor_type must be one of {ACTOR_TYPES}")
    if level not in LEVELS:
        raise ValueError(f"level must be one of {LEVELS}")

    scope_filter = (
        HitlGateConfig.project_id.is_(None)
        if project_id is None
        else HitlGateConfig.project_id == project_id
    )
    existing = (
        await session.execute(
            select(HitlGateConfig).where(
                HitlGateConfig.org_id == org_id,
                scope_filter,
                HitlGateConfig.work_type == work_type,
                HitlGateConfig.actor_type == actor_type,
            )
        )
    ).scalars().first()

    if existing is not None:
        existing.level = level
        await session.flush()
        await session.refresh(existing)
        return existing

    row = HitlGateConfig(
        org_id=org_id,
        project_id=project_id,
        work_type=work_type,
        actor_type=actor_type,
        level=level,
        created_by=created_by,
    )
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return row
