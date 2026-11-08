"""story #4846 (AC10) — a file attached in a chat message belongs to the ROOM, not to the project.

The asset code scoped every asset by the project it was registered under (a project asset: the people with that project; an asset with no project: the
whole organization). For an attachment of a chat room that is the wrong circle on both sides:
- a project member who is not in the room could find the room's file (`/assets` list, `/assets/{id}`, its text, the authorize-by-asset-id route, convert) and open it;
- a participant who lost the room's project could not open their own room's file;
- the attachment of a room WITHOUT a project is registered with no project — the organization's — which would open it to everyone in the organization.

The rule, in one place (the asset routes, the authorize route, convert and the enrichment all use it):
  an asset whose every link is a chat message is visible to whoever can READ one of those messages' rooms (the one predicate of `conversation_auth`);
  a DERIVED asset (the PDF that `convert` makes from an office file) is readable ⟺ the asset it was derived from is readable NOW, by the same judgment
  (`asset_scope_clause`: one rule, so the origin deleted, gone, left the room or lost the project all answer the same way, and a copy whose origin cannot be
  found is opened to nobody); its life is its origin's too (deleting the origin deletes it, see `assets.delete_asset`);
  an asset that has another living context as well (a story, a doc) keeps the project rule for that context; an asset with no chat link is unchanged.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Text, and_, cast, exists, false, func, or_, select, true
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import ColumnElement

from app.models.asset import Asset, AssetLink
from app.models.conversation import Conversation, ConversationMessage
from app.services.conversation_auth import conversation_readable_predicate
from app.services.project_auth import (
    has_project_access,
    org_admin_valid_correlated,
    project_access_valid_correlated,
    project_admin_valid_correlated,
)


def room_readable_clause(
    conv_id_col: ColumnElement, conv_project_col: ColumnElement, *, caller_member_id: uuid.UUID | None, is_agent: bool, user_id: uuid.UUID, org_id: uuid.UUID,
) -> ColumnElement:
    """`conversation_readable_predicate` for the room in the given columns, with the caller's two atoms correlated (the backlinks bulk form)."""
    if caller_member_id is None:
        return false()
    admin = (
        project_admin_valid_correlated(conv_project_col, caller_id=caller_member_id, org_id=org_id)
        if is_agent else org_admin_valid_correlated(caller_id=user_id, org_id=org_id)
    )
    agent_ok = (
        or_(conv_project_col.is_(None), project_access_valid_correlated(conv_project_col, caller_id=user_id, org_id=org_id))
        if is_agent else True
    )
    return conversation_readable_predicate(conv_id_col, caller_member_id=caller_member_id, admin_bypass_eligible=admin, agent_project_valid=agent_ok)


def _chat_only(entity) -> ColumnElement:
    """the asset has a chat-message link and no other link"""
    chat_link = exists().where(AssetLink.asset_id == entity.id, AssetLink.source_type == "conversation_message")
    other_link = exists().where(AssetLink.asset_id == entity.id, AssetLink.source_type != "conversation_message")
    return and_(chat_link, ~other_link)


def chat_only_clause() -> ColumnElement:
    return _chat_only(Asset)


def _room_readable(entity, *, caller_member_id: uuid.UUID | None, is_agent: bool, user_id: uuid.UUID, org_id: uuid.UUID) -> ColumnElement:
    """some message that carries the asset is in a room the caller can read"""
    return exists().where(
        AssetLink.asset_id == entity.id,
        AssetLink.source_type == "conversation_message",
        AssetLink.org_id == org_id,
        ConversationMessage.id == AssetLink.source_id,
        ConversationMessage.deleted_at.is_(None),   # a deleted message no longer carries its file (the authorize route says the same: every linked message deleted → refused)
        Conversation.id == ConversationMessage.conversation_id,
        Conversation.org_id == org_id,
        room_readable_clause(
            Conversation.id, Conversation.project_id, caller_member_id=caller_member_id, is_agent=is_agent, user_id=user_id, org_id=org_id,
        ),
    )


def chat_room_readable_clause(*, caller_member_id: uuid.UUID | None, is_agent: bool, user_id: uuid.UUID, org_id: uuid.UUID) -> ColumnElement:
    return _room_readable(Asset, caller_member_id=caller_member_id, is_agent=is_agent, user_id=user_id, org_id=org_id)


def _derived_from(derived, origin) -> ColumnElement:
    """`derived` is the PDF `office_conversion` made from `origin`: its object path is `converted/<org>/<project|org>/<origin id>.pdf` (a deterministic
    path — the cache key), the only way an asset is derived from another today (the other creators of an asset — the upload confirm, the registry from a
    message / story / doc, the visual artifact — make it from a file, not from an asset)."""
    return and_(
        derived.object_path.like("converted/%"),
        origin.org_id == derived.org_id,
        origin.project_id.is_not_distinct_from(derived.project_id),   # a copy is made in its origin's project: one that says otherwise is nobody's copy
        func.split_part(derived.object_path, "/", 4) == cast(origin.id, Text) + ".pdf",
    )


def _plain_scope(entity, project_rule: ColumnElement, caller: dict) -> ColumnElement:
    """the visibility of an asset that is its OWN thing (not a derived copy): chat-only → the room rule; any other → `project_rule`"""
    return or_(
        and_(_chat_only(entity), _room_readable(entity, **caller)),
        and_(~_chat_only(entity), project_rule),
    )


def asset_scope_clause(
    project_rule: ColumnElement, *, caller_member_id: uuid.UUID | None, is_agent: bool, user_id: uuid.UUID, org_id: uuid.UUID,
) -> ColumnElement:
    """the visibility of an asset, in ONE rule: a derived copy (the converted PDF) is readable ⟺ its origin is readable NOW, by the very same judgment
    (`_plain_scope`); every other asset is judged by `_plain_scope` itself. So whatever happens to the origin — deleted, gone, the caller left the room or lost
    the project — the one function answers for the copy too, and a copy whose origin cannot be found (hard-deleted) is opened to nobody.

    `project_rule` is the caller's project scope as before; for a copy it is applied as the copy's own project, which is its origin's (the path carries it)."""
    caller = dict(caller_member_id=caller_member_id, is_agent=is_agent, user_id=user_id, org_id=org_id)
    origin = aliased(Asset)
    derived_like = and_(Asset.object_path.like("converted/%"), ~_chat_only(Asset))
    origin_readable = exists().where(_derived_from(Asset, origin), origin.deleted_at.is_(None), _plain_scope(origin, project_rule, caller))
    return or_(
        and_(derived_like, origin_readable),
        and_(~derived_like, _plain_scope(Asset, project_rule, caller)),
    )


async def asset_is_chat_only(db, asset_id: uuid.UUID) -> bool:
    return bool((await db.execute(select(Asset.id).where(Asset.id == asset_id, chat_only_clause()))).first())


async def asset_accessible_to_caller(db, auth, org_id: uuid.UUID, asset: Asset) -> bool:
    """the same rule for ONE asset (the authorize route and convert): the room rule for a chat-only asset and for what was derived from one, the project rule
    otherwise (an asset with no project is the organization's, as before)."""
    from app.services.backlinks import _chat_predicate_inputs   # lazy: the backlinks module imports the conversations router

    user_id = uuid.UUID(auth.user_id)
    member, is_agent = await _chat_predicate_inputs(db, org_id, auth)
    project_ok = asset.project_id is None or await has_project_access(db, user_id, asset.project_id, org_id)
    clause = asset_scope_clause(
        true() if project_ok else false(), caller_member_id=member, is_agent=bool(is_agent), user_id=user_id, org_id=org_id,
    )
    return (await db.execute(select(Asset.id).where(Asset.id == asset.id, clause))).first() is not None
