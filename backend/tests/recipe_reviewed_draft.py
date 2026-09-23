"""story #4190 — 레시피 external_publish 게이트 승인 테스트 공용: 승인 화면이 보여 주는 초안(`find_ready_recipe_channel_
drafts()[0]` — gates.py `_enrich_linked_channel_draft`와 같은 판정)의 (draft_id, version). 실제 FE가 승인 요청에 싣는
`reviewed_draft_id`·`reviewed_draft_version`과 같은 값이다. 보여 줄 초안이 없으면 None(승인에 필드 불요)."""
from __future__ import annotations

import uuid


async def reviewed_draft_for(session, *, org_id: uuid.UUID, work_item_id: uuid.UUID, work_item_type: str = "story"):
    from app.services.channel_posts import find_ready_recipe_channel_drafts

    ready, _still_pending = await find_ready_recipe_channel_drafts(
        session, org_id=org_id, work_item_id=work_item_id, work_item_type=work_item_type,
    )
    if not ready:
        return None
    draft, _gate, latest = ready[0]
    return draft.id, latest.version


async def reviewed_draft_body(session, *, org_id: uuid.UUID, work_item_id: uuid.UUID) -> dict:
    """ASGI 승인 요청 body에 합칠 필드(FE가 보내는 모양)."""
    reviewed = await reviewed_draft_for(session, org_id=org_id, work_item_id=work_item_id)
    if reviewed is None:
        return {}
    return {"reviewed_draft_id": str(reviewed[0]), "reviewed_draft_version": reviewed[1]}


async def reviewed_draft_body_via(Session, *, org_id: uuid.UUID, work_item_id: uuid.UUID) -> dict:
    async with Session() as s:
        return await reviewed_draft_body(s, org_id=org_id, work_item_id=work_item_id)
