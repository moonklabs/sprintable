"""story #4846 (AC10) — a file attached in a chat message belongs to the ROOM, not to the project.

The asset code scoped every asset by the project it was registered under (a project asset: the people with that project; an asset with no project: the
whole organization). For an attachment of a chat room that is the wrong circle on both sides:
- a project member who is not in the room could find the room's file (`/assets` list, `/assets/{id}`, its text, the authorize-by-asset-id route, convert) and open it;
- a participant who lost the room's project could not open their own room's file;
- the attachment of a room WITHOUT a project is registered with no project — the organization's — which would open it to everyone in the organization.

The rule, in one place (the asset routes, the authorize route, convert and the enrichment all use it):
  an asset whose every link is a chat message is visible to whoever can READ one of those messages' rooms (the one predicate of `conversation_auth`);
  a DERIVED asset (the PDF that `convert` makes from an office file) takes the scope of the asset it was derived from — computed from the origin, not
  copied, so it covers every way a derivation can be made and never opens wider than its origin; its life is its origin's (deleting the origin deletes it,
  see `assets.delete_asset`), and a file that LOOKS derived whose origin is gone is opened to nobody;
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
        func.split_part(derived.object_path, "/", 4) == cast(origin.id, Text) + ".pdf",
    )


def asset_scope_clause(
    project_rule: ColumnElement, *, caller_member_id: uuid.UUID | None, is_agent: bool, user_id: uuid.UUID, org_id: uuid.UUID,
) -> ColumnElement:
    """the visibility of an asset: a chat-only asset follows its room, a derived asset follows its origin's room, every other asset follows `project_rule`
    (the caller's project scope, as before)"""
    caller = dict(caller_member_id=caller_member_id, is_agent=is_agent, user_id=user_id, org_id=org_id)
    origin = aliased(Asset)
    own_chat = _chat_only(Asset)
    from_chat = exists().where(_derived_from(Asset, origin), _chat_only(origin))
    from_readable = exists().where(_derived_from(Asset, origin), _chat_only(origin), _room_readable(origin, **caller))
    # a file of the derived kind whose origin row is gone (hard-deleted): its circle can no longer be computed, so it is NOT the project's — nobody opens it
    orphan = and_(Asset.object_path.like("converted/%"), ~exists().where(_derived_from(Asset, origin)))
    return or_(
        and_(own_chat, _room_readable(Asset, **caller)),
        and_(from_chat, from_readable),
        and_(~own_chat, ~from_chat, ~orphan, project_rule),
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
