"""story 4832 — putting an existing agent on a project's team (a `project_access` grant row), one function for every path that does it.

The access route (`POST /api/v2/projects/{id}/access`, agent branch) and the desktop move («옮기면 프로젝트 팀에도 들어가요»: `confirm_move_setup` with
`add_to_team`) both call `grant_agent_project_access`, so the checks — who may do it, which agents may be put there, what is never touched — live here once.

What it does, in this order: the project exists and is not deleted · `by_user_id` may manage the project's access (`can_manage_project_access`, the
route's own rule) · the agent is an active agent of the project's organization · it is not the reserved system publisher · it has no grant yet (an
existing grant — also one a concurrent request wrote between the check and the insert — is left as it is and refused) · the grant row and the agent's
per-project profile are written. Like the route before it, it does not require a desktop runtime (a webhook agent is a legitimate team member); the move asks for that itself. It NEVER commits: the caller decides
(the route commits right after; a move commits with its confirmation, so a confirmation that fails leaves no access behind).
"""
from __future__ import annotations

import uuid

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project_access import ProjectAccess
from app.services.project_auth import can_manage_project_access
from app.services.system_publisher_guard import assert_member_id_not_system_publisher

# closed reasons — the callers map them to their own answers (the route: 404 · 403 · 400 · 409; the move: its closed setup codes)
PROJECT_NOT_FOUND = "project_not_found"
NOT_ALLOWED = "not_allowed"
AGENT_INVALID = "agent_invalid"
ALREADY_GRANTED = "already_granted"


class AgentGrantRefused(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


async def grant_agent_project_access(
    session: AsyncSession, *, project_id: uuid.UUID, member_id: uuid.UUID, by_user_id: uuid.UUID,
) -> ProjectAccess:
    """The grant row for `member_id` (an agent) on `project_id`, flushed (visible to this session's next read) and not committed.
    Raises `AgentGrantRefused(reason)` — nothing is written then."""
    project = (await session.execute(
        text("SELECT org_id FROM projects WHERE id = :pid AND deleted_at IS NULL"), {"pid": str(project_id)},
    )).first()
    if project is None:
        raise AgentGrantRefused(PROJECT_NOT_FOUND)
    if not await can_manage_project_access(session, by_user_id, project_id):
        raise AgentGrantRefused(NOT_ALLOWED)
    # story #2953: the sentence says «active agent» and the check must mean it (a deactivated, undeleted agent gets no new grant)
    agent_ok = (await session.execute(
        text(
            "SELECT 1 FROM members m JOIN projects p ON p.id = :pid "
            "WHERE m.id = :mid AND m.type = 'agent' AND m.deleted_at IS NULL "
            "AND m.is_active = true AND m.org_id = p.org_id LIMIT 1"
        ),
        {"pid": str(project_id), "mid": str(member_id)},
    )).scalar_one_or_none()
    if agent_ok is None:
        raise AgentGrantRefused(AGENT_INVALID)
    # story #3999 — the reserved member («시스템 발행») is never put on a team
    await assert_member_id_not_system_publisher(session, member_id)
    existing = await session.execute(
        select(ProjectAccess).where(ProjectAccess.project_id == project_id, ProjectAccess.member_id == member_id)
    )
    if existing.scalar_one_or_none() is not None:
        raise AgentGrantRefused(ALREADY_GRANTED)
    record = ProjectAccess(project_id=project_id, org_member_id=None, member_id=member_id, permission="granted")
    try:
        # a savepoint: two requests that both passed the check above meet at the unique (project, member) index — the loser must read as «already granted», not poison the
        # caller's transaction or end as a 500
        async with session.begin_nested():
            session.add(record)
            await session.flush()
    except IntegrityError:
        again = await session.execute(
            select(ProjectAccess.id).where(ProjectAccess.project_id == project_id, ProjectAccess.member_id == member_id)
        )
        if again.scalar_one_or_none() is None:
            raise  # not the duplicate: something else is wrong — never read as «already granted»
        raise AgentGrantRefused(ALREADY_GRANTED) from None
    # S4 (org-level multi-project): the per-project runtime profile is made with the grant (idempotent) — without it the agent shows only through
    # the view's branch 3 (runtime NULL) and presence / runtime writes land on 0 rows
    from app.services.agent_anchor_sync import ensure_agent_project_profile

    await ensure_agent_project_profile(session, member_id=member_id, project_id=project_id)
    await session.flush()
    return record
