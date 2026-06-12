"""E-CAGE-REFEREE P1: PR·CI verdict 자동 포착 서비스.

[SID:story_uuid] 태그 파싱 → story → implementation participation → record_verdict.
SID/participation 없으면 skip(거짓기록 금지). garbage-in 차단.
멱등: record_verdict uq upsert가 보장.
"""
from __future__ import annotations

import logging
import os
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.participation import Participation, ParticipationRole
from app.models.pm import Story
from app.services.verdict_recorder import record_verdict

logger = logging.getLogger(__name__)

# [SID:uuid](PR 제목/본문·콜론) 또는 sid-uuid/sid_uuid/sid/uuid(브랜치-안전·콜론 불가). CI 이벤트
# (workflow_run/check_suite/status)는 PR title/body가 없고 head_branch만 와서, 콜론을 못 쓰는
# git 브랜치명에 SID를 실으려면 sid-<uuid> 마커가 필요하다(H1-S6 링킹 견고성).
_SID_RE = re.compile(r"\[SID:([0-9a-f\-]{36})\]|sid[-_/]([0-9a-f\-]{36})", re.IGNORECASE)
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")


def parse_story_id(text: str) -> uuid.UUID | None:
    """텍스트(PR 제목/본문 또는 브랜치명)에서 SID 태그 파싱.

    `[SID:uuid]`(PR 제목/본문) 또는 `sid-<uuid>`/`sid/<uuid>`(브랜치) 모두 인식. 없으면 None(skip).
    """
    m = _SID_RE.search(text)
    if not m:
        return None
    try:
        return uuid.UUID(m.group(1) or m.group(2))
    except (ValueError, TypeError):
        return None


async def resolve_implementation_participation(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
) -> Participation | None:
    """스토리의 implementation(default) 역할 participation 탐색.

    없으면 None → 호출자가 skip 처리.
    """
    role_r = await session.execute(
        select(ParticipationRole).where(
            ParticipationRole.org_id == org_id,
            ParticipationRole.is_default.is_(True),
        ).limit(1)
    )
    default_role = role_r.scalar_one_or_none()
    if default_role is None:
        return None

    p_r = await session.execute(
        select(Participation).where(
            Participation.org_id == org_id,
            Participation.story_id == story_id,
            Participation.role_id == default_role.id,
        ).limit(1)
    )
    return p_r.scalar_one_or_none()


async def fetch_pr_review_rounds(repo: str, pr_number: int) -> int:
    """GitHub API에서 changes-requested 라운드 수 조회.

    GITHUB_TOKEN 없거나 실패 시 0 반환(거짓 rounds 대신 null 처리).
    rate limit·네트워크 오류는 조용히 0 처리.
    """
    if not GITHUB_TOKEN:
        return 0
    try:
        import httpx
        url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}/reviews"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                url,
                headers={
                    "Authorization": f"Bearer {GITHUB_TOKEN}",
                    "Accept": "application/vnd.github+json",
                },
            )
        if resp.status_code != 200:
            return 0
        reviews: list[dict[str, Any]] = resp.json()
        return sum(1 for r in reviews if r.get("state") == "CHANGES_REQUESTED")
    except Exception as exc:
        logger.warning("GitHub review fetch failed repo=%s pr=%d: %s", repo, pr_number, exc)
        return 0


async def capture_pr_ci_verdict(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    pr_number: int,
    repo: str,
    merged: bool,
    ci_result: str | None,
) -> dict[str, Any]:
    """PR/CI verdict 포착 진입점.

    Returns:
        {"recorded": [...], "skipped_reason": str | None}
    """
    participation = await resolve_implementation_participation(session, org_id, story_id)
    if participation is None:
        return {"recorded": [], "skipped_reason": "no_implementation_participation"}

    recorded: list[str] = []

    from app.services.gate_service import resolve_gate_from_verdict

    # source=pr: 머지 여부 + rounds
    if merged:
        rounds = await fetch_pr_review_rounds(repo, pr_number)
        await record_verdict(
            session, org_id, participation.id,
            source="pr",
            result="pass",
            rounds=rounds if rounds > 0 else None,
        )
        # verdict → 대응 게이트 해소 (게이트 없거나 오류면 graceful skip)
        try:
            await resolve_gate_from_verdict(
                session, org_id, story_id, "story", "pr", "pass"
            )
        except Exception:
            pass
        recorded.append("pr")

    # source=ci: CI 결과
    if ci_result is not None:
        normalized = "pass" if ci_result.lower() in ("pass", "success") else "fail"
        await record_verdict(
            session, org_id, participation.id,
            source="ci",
            result=normalized,
            rounds=None,
        )
        try:
            await resolve_gate_from_verdict(
                session, org_id, story_id, "story", "ci", normalized
            )
        except Exception:
            pass
        recorded.append("ci")

    return {"recorded": recorded, "skipped_reason": None}


# ── QA·디자인 게이트 verdict 포착 ───────────────────────────────────────────────

async def ensure_review_participation(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    member_id: uuid.UUID,
    role_key: str,
) -> Participation | None:
    """QA·디자인 역할 participation ensure — 없으면 생성, 있으면 반환.

    implementation(default) 역할 upsert와 달리, QA/디자인은 assignee가 아닌
    게이트키퍼가 별도로 생성되므로 ensure(없으면 create).
    role_key가 org에 없으면 None → skip.
    """
    from app.repositories.participation import ParticipationRepository

    role_r = await session.execute(
        select(ParticipationRole).where(
            ParticipationRole.org_id == org_id,
            ParticipationRole.key == role_key,
        ).limit(1)
    )
    role = role_r.scalar_one_or_none()
    if role is None:
        return None

    p_repo = ParticipationRepository(session, org_id)
    if not await p_repo.exists(story_id, member_id, role.id):
        return await p_repo.create(story_id=story_id, member_id=member_id, role_id=role.id)

    existing_r = await session.execute(
        select(Participation).where(
            Participation.org_id == org_id,
            Participation.story_id == story_id,
            Participation.member_id == member_id,
            Participation.role_id == role.id,
        ).limit(1)
    )
    return existing_r.scalar_one_or_none()


async def capture_review_verdict(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    role_key: str,
    member_id: uuid.UUID,
    result: str | None,
    rounds: int | None = None,
) -> dict[str, Any]:
    """QA/디자인 게이트 결과를 verdict로 기록.

    role_key: 'qa' | 'design' (org participation_role.key)
    result: 'pass' | 'fail' | None
    멱등: record_verdict uq(participation_id, source) upsert.
    role 없거나 story 없으면 skip(거짓기록 금지).
    """
    participation = await ensure_review_participation(session, org_id, story_id, member_id, role_key)
    if participation is None:
        return {"recorded": False, "skipped_reason": f"no_{role_key}_role"}

    from app.services.gate_service import resolve_gate_from_verdict

    await record_verdict(
        session, org_id, participation.id,
        source=role_key,
        result=result,
        rounds=rounds,
    )
    # verdict → 대응 게이트 해소 (게이트 없거나 오류면 graceful skip)
    try:
        await resolve_gate_from_verdict(
            session, org_id, story_id, "story", role_key, result
        )
    except Exception:
        pass
    return {"recorded": True, "source": role_key, "result": result, "skipped_reason": None}
