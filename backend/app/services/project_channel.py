"""story #5032 (C2 · «a channel is a project») — the one «project channel» room of a project, and who sits in it.

PO decision: every project owns one conversation that is its channel. It is an ordinary `type='group'` room (no new type value — delivery, permission and
list code tell `dm` from `group`) carrying the mark `conversations.is_project_channel` (migration 0502), with at most ONE per project (partial unique
index `uq_conversations_project_channel`). Its title is the project's name; its participants are the people and agents who can be called on the project.
Old rooms are untouched — the channel stands beside them.

The channel is set up QUIETLY: no message, no notification, no event — only the room and its participant rows (the same shape `_create_conversation_record`
writes). Nothing here commits; the caller's transaction decides.

`ensure_project_channel` is the strict function (raises what goes wrong). The `*_quietly` / `sync_*` helpers are for callers that must not fail because of the
channel — project creation, an access grant: a project without its channel is fine (the next access to it sets it up again), a project that could not be made
because of its channel room is not. They run in a SAVEPOINT, so a failure rolls back only the channel's own writes and the caller's transaction stays usable.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation, ConversationParticipant
from app.models.project import Project

logger = logging.getLogger(__name__)

PROJECT_CHANNEL_INDEX = "uq_conversations_project_channel"


async def get_project_channel(db: AsyncSession, *, project_id: uuid.UUID) -> Conversation | None:
    """The project's channel room, or None when it has none yet."""
    return (await db.execute(
        select(Conversation).where(Conversation.project_id == project_id, Conversation.is_project_channel.is_(True))
    )).scalar_one_or_none()


async def ensure_project_channel(
    db: AsyncSession, *, org_id: uuid.UUID, project: Project, creator_member_id: uuid.UUID | None,
) -> Conversation:
    """The project's channel: the existing one, else a new one (`group` · title = the project's name · `created_by` = the creator · participants = the creator alone).
    `creator_member_id` may be None (a channel set up by no particular person — it then starts with no participant; the caller adds who belongs). An existing channel
    is returned as it is (its participants are not touched). Two requests that both find none meet at the unique index: the loser reads the winner's channel."""
    existing = await get_project_channel(db, project_id=project.id)
    if existing is not None:
        return existing
    try:
        # a savepoint: the loser of the race must roll back only its own insert, not the caller's transaction
        async with db.begin_nested():
            conv = Conversation(
                project_id=project.id,
                org_id=org_id,
                type="group",
                title=project.name,
                created_by=creator_member_id,
                is_project_channel=True,
            )
            db.add(conv)
            await db.flush()
            if creator_member_id is not None:
                db.add(ConversationParticipant(conversation_id=conv.id, member_id=creator_member_id))
                await db.flush()
        return conv
    except IntegrityError as exc:
        if PROJECT_CHANNEL_INDEX not in str(exc.orig):
            raise
        winner = await get_project_channel(db, project_id=project.id)
        if winner is None:
            raise  # the index fired but no channel is readable: something else is wrong — never pretend
        return winner


async def add_project_channel_participant(
    db: AsyncSession, *, channel_id: uuid.UUID, member_id: uuid.UUID,
) -> None:
    """Seat `member_id` in the channel (idempotent: already seated is fine)."""
    await db.execute(
        pg_insert(ConversationParticipant)
        .values(conversation_id=channel_id, member_id=member_id)
        .on_conflict_do_nothing(constraint="uq_conversation_participant")
    )


async def remove_project_channel_participant(
    db: AsyncSession, *, channel_id: uuid.UUID, member_id: uuid.UUID,
) -> None:
    """Take `member_id` out of the channel (idempotent: not seated is fine)."""
    await db.execute(
        delete(ConversationParticipant).where(
            ConversationParticipant.conversation_id == channel_id, ConversationParticipant.member_id == member_id,
        )
    )


async def ensure_project_channel_quietly(
    db: AsyncSession, *, org_id: uuid.UUID, project: Project, creator_member_id: uuid.UUID | None,
) -> Conversation | None:
    """`ensure_project_channel` that never fails its caller: any error is logged and None is returned (the savepoint keeps the caller's transaction usable)."""
    try:
        async with db.begin_nested():
            return await ensure_project_channel(db, org_id=org_id, project=project, creator_member_id=creator_member_id)
    except Exception:  # noqa: BLE001 — the channel must never break what the caller is doing
        logger.warning("project channel could not be set up project_id=%s", project.id, exc_info=True)
        return None


async def seat_in_project_channel_quietly(db: AsyncSession, *, project_id: uuid.UUID, member_id: uuid.UUID) -> bool:
    """Someone (a person or an agent, by members.id) gained access to the project: seat them in its channel, setting the channel up first when it
    does not exist yet. Never fails the caller (see the module note); returns whether the member is seated."""
    try:
        async with db.begin_nested():
            project = (await db.execute(
                select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
            )).scalar_one_or_none()
            if project is None:
                return False
            channel = await ensure_project_channel(db, org_id=project.org_id, project=project, creator_member_id=None)
            await add_project_channel_participant(db, channel_id=channel.id, member_id=member_id)
            return True
    except Exception:  # noqa: BLE001
        logger.warning("project channel seat failed project_id=%s member_id=%s", project_id, member_id, exc_info=True)
        return False


async def unseat_from_project_channel(db: AsyncSession, *, project_id: uuid.UUID, member_id: uuid.UUID) -> None:
    """Someone lost access to the project: take them out of its channel in the CALLER's transaction (no channel = nothing to do). NOT quiet: it is one DELETE, and a revoke whose unseat failed
    must fail with it — the alternative is an access that is gone and a seat that stays (story #5032, codex round 2). The read and the delivery of a channel still ask for the access NOW,
    so a seat that gets through some other way reads nothing; this is the root: the participant rows are kept exact."""
    channel = await get_project_channel(db, project_id=project_id)
    if channel is not None:
        await remove_project_channel_participant(db, channel_id=channel.id, member_id=member_id)


async def unseat_from_project_channels_of_org(db: AsyncSession, *, org_id: uuid.UUID, member_ids: set[uuid.UUID]) -> None:
    """A person left the organization (their `project_access` rows are gone): take them out of EVERY project channel of the organization, in the caller's transaction (not quiet — see above)."""
    if not member_ids:
        return
    channel_ids = select(Conversation.id).where(Conversation.org_id == org_id, Conversation.is_project_channel.is_(True))
    await db.execute(
        delete(ConversationParticipant).where(
            ConversationParticipant.conversation_id.in_(channel_ids), ConversationParticipant.member_id.in_(member_ids),
        )
    )


async def unseat_from_all_project_channels(db: AsyncSession, *, member_ids_sql, params: dict) -> None:
    """(account deletion) take the members the given SQL names out of every project channel of every organization — see `routers/account.py`. In the caller's transaction."""
    from sqlalchemy import text

    await db.execute(
        text(
            "DELETE FROM conversation_participants WHERE member_id IN (" + member_ids_sql + ")"
            " AND conversation_id IN (SELECT id FROM conversations WHERE is_project_channel)"
        ),
        params,
    )


async def empty_project_channel(db: AsyncSession, *, project_id: uuid.UUID) -> None:
    """The project is being deleted: take EVERY participant out of its channel, in the deleting transaction. The room itself stays (its history is kept; `project_id` goes NULL by the foreign key)
    — a room of nobody, so no participant row is left for the «room without a project» rule to open."""
    channel_ids = select(Conversation.id).where(Conversation.project_id == project_id, Conversation.is_project_channel.is_(True))
    await db.execute(delete(ConversationParticipant).where(ConversationParticipant.conversation_id.in_(channel_ids)))


async def retitle_project_channel_quietly(db: AsyncSession, *, project_id: uuid.UUID, title: str) -> bool:
    """The project was renamed: the channel's title follows (no channel = nothing to do). Never fails the caller."""
    try:
        async with db.begin_nested():
            await db.execute(
                update(Conversation)
                .where(Conversation.project_id == project_id, Conversation.is_project_channel.is_(True))
                .values(title=title)
                .execution_options(synchronize_session=False)
            )
            return True
    except Exception:  # noqa: BLE001
        logger.warning("project channel retitle failed project_id=%s", project_id, exc_info=True)
        return False
