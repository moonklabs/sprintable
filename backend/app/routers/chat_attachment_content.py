"""story 4646 — GET /api/v2/conversations/{conversation_id}/messages/{message_id}/attachments/{index}/content.

얇은 라우터: 판단은 services/chat_attachment_service.read_message_attachment 한 곳에 있다.
"""
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.chat_attachment_service import read_message_attachment

router = APIRouter(prefix="/api/v2/conversations", tags=["conversations", "attachments"])


@router.get("/{conversation_id}/messages/{message_id}/attachments/{index}/content")
async def get_message_attachment_content(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    index: int,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    r = await read_message_attachment(db, auth, org_id, conversation_id, message_id, index)
    return {
        "kind": r.kind, "name": r.name, "content_type": r.content_type, "size": r.size, "reason": r.reason,
        "width": r.width, "height": r.height, "data_base64": r.data_base64, "text": r.text,
    }
