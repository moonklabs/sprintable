"""a54ddc16: 첨부 인가 엔드포인트 — 서명URL 발급 전 SSOT 권한 게이트.

버킷 public(allUsers) 제거 후, Next 서명 라우트(/api/attachments/sign)가 V4 signed URL 발급
**전에** 이 엔드포인트로 요청자 권한을 확인한다. message 첨부 → conversation 참가자, story 첨부
→ has_project_access. + path 가 그 리소스 소속인지 검증(cross-resource path 추측 차단).
team_member 봐주기 없음(resolve_member·has_project_access SSOT 재사용).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.conversation import ConversationParticipant
from app.models.pm import Story
from app.services.member_resolver import resolve_member
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/attachments", tags=["attachments"])


@router.get("/authorize")
async def authorize_attachment(
    path: str = Query(..., description="GCS object path (또는 stored attachment url 의 path 부분)"),
    conversation_id: uuid.UUID | None = Query(default=None),
    story_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/attachments/authorize — 첨부 접근 인가(200) / 거부(403).

    정확히 하나의 리소스(conversation_id XOR story_id)를 받아 ① 요청자의 그 리소스 접근권과
    ② path 가 그 리소스의 첨부인지를 검증한다.
    """
    if (conversation_id is None) == (story_id is None):
        raise HTTPException(status_code=400, detail="exactly one of conversation_id or story_id required")
    if not path:
        raise HTTPException(status_code=400, detail="path required")

    if conversation_id is not None:
        # message 첨부 → conversation 참가자(canonical member). team_member 봐주기 없음.
        member = await resolve_member(auth, org_id, db, project_id=None)
        is_participant = (await db.execute(
            select(ConversationParticipant.id).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.member_id == member.id,
            )
        )).scalar_one_or_none()
        if is_participant is None:
            raise HTTPException(status_code=403, detail="Not a participant of this conversation")
        # path 가 이 conversation 의 메시지 첨부에 실제 존재하는지(추측 차단)
        belongs = (await db.execute(
            text(
                "SELECT EXISTS ("
                " SELECT 1 FROM conversation_messages m,"
                " jsonb_array_elements(coalesce(m.attachments, '[]'::jsonb)) att"
                " WHERE m.conversation_id = :cid AND strpos(att->>'url', :path) > 0)"
            ),
            {"cid": conversation_id, "path": path},
        )).scalar()
        if not belongs:
            raise HTTPException(status_code=403, detail="Attachment does not belong to this conversation")
    else:
        row = (await db.execute(
            select(Story.project_id, Story.attachments).where(
                Story.id == story_id,
                Story.org_id == org_id,
                Story.deleted_at.is_(None),
            )
        )).first()
        if row is None:
            raise HTTPException(status_code=404, detail="Story not found")
        project_id, attachments = row
        if not await has_project_access(db, uuid.UUID(auth.user_id), project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")
        belongs = any(path in (a.get("url") or "") for a in (attachments or []))
        if not belongs:
            raise HTTPException(status_code=403, detail="Attachment does not belong to this story")

    return {"authorized": True}
