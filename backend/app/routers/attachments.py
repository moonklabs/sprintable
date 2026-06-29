"""a54ddc16: 첨부 인가 엔드포인트 — 서명URL 발급 전 SSOT 권한 게이트.

버킷 public(allUsers) 제거 후, Next 서명 라우트(/api/attachments/sign)가 V4 signed URL 발급
**전에** 이 엔드포인트로 요청자 권한을 확인한다. message 첨부 → conversation 참가자, story 첨부
→ has_project_access. team_member 봐주기 없음(resolve_member·has_project_access SSOT 재사용).

보안(P1): path 소속 검증은 **substring 금지·정확 매치**.
- ① 구조적 스코프: 업로드 경로가 `chat/<proj>/<conv_id>/<file>` / `story/<proj>/<story_id>/<file>`
  로 resource 에 스코프되므로, 요청 path 의 segment 에 해당 resource id 가 있어야 한다
  (metadata 에 임의 URL 을 심어도 victim path 는 victim 의 id 를 가지므로 차단).
- ② stored 첨부와 **canonical object path 정확 일치**(우리 버킷 prefix 만 인정·== 비교).
요청 path 는 bare object path(스킴 없음)여야 한다. ⚠️ Next sign 라우트도 동일 추출 규칙을 쓸 것.
"""
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.asset import Asset
from app.models.conversation import Conversation, ConversationParticipant
from app.models.pm import Story
from app.services.asset_registry import path_in_source_scope
from app.services.member_resolver import resolve_member
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/attachments", tags=["attachments"])

_BUCKET = os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "sprintable-memo-attachments")
_PUBLIC_PREFIX = f"https://storage.googleapis.com/{_BUCKET}/"


def _canonical_object_path(stored_url: str) -> str | None:
    """stored attachment url → canonical GCS object path. 우리 버킷 외/비정상이면 None.

    신규 = bare object path 그대로. legacy = `https://storage.googleapis.com/{bucket}/{path}`.
    다른 도메인/스킴 URL 은 None(유효 객체 아님) → 임의-URL 삽입 차단.
    """
    if not stored_url:
        return None
    if stored_url.startswith(_PUBLIC_PREFIX):
        return stored_url[len(_PUBLIC_PREFIX):]
    if "://" in stored_url:
        return None  # 외부 도메인 등 → 우리 객체 아님
    return stored_url  # 이미 bare object path


@router.get("/authorize")
async def authorize_attachment(
    path: str | None = Query(default=None, description="GCS object path (bare·스킴 없음·conv/story 전용)"),
    conversation_id: uuid.UUID | None = Query(default=None),
    story_id: uuid.UUID | None = Query(default=None),
    asset_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/attachments/authorize — 첨부 접근 인가(200) / 거부(403).

    정확히 하나의 리소스(conversation_id | story_id | asset_id)·요청자 접근권.
    S3: asset_id 분기(S2 registry·D1: BE가 registry에서 {container,object_path} 권위 derive·FE 제공값
    trust X). conversation/story 엄격검사(path 구조+정확매치)는 무변경(IDOR 유지).
    """
    if sum(x is not None for x in (conversation_id, story_id, asset_id)) != 1:
        raise HTTPException(
            status_code=400,
            detail="exactly one of conversation_id, story_id, asset_id required",
        )

    if asset_id is not None:
        # S3·D1: asset_id 가 truth. registry(org-scoped)에서 좌표 derive→authz→{container,object_path}
        # 반환(FE 제공 path/container 안 받음·attack surface↓). cross-org=org 필터 0행→404(AC4).
        asset = (await db.execute(
            select(Asset).where(
                Asset.id == asset_id,
                Asset.org_id == org_id,
                Asset.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if asset is None:
            raise HTTPException(status_code=404, detail="Asset not found")
        # 인가(AC1·AC4): project asset=has_project_access·org-level(project_id NULL)=verified-org 멤버.
        # org_id 는 get_verified_org_id 로 검증됨(asset.org_id==org_id 매치)→ org-level 통과.
        if asset.project_id is not None and not await has_project_access(
            db, uuid.UUID(auth.user_id), asset.project_id, org_id
        ):
            raise HTTPException(status_code=403, detail="No access to this project")
        # BE 권위 좌표 반환 — FE 는 이걸로 signRead(외부URL/wrong-bucket 불가·AC3).
        return {"authorized": True, "container": asset.container, "object_path": asset.object_path}

    # conv/story 분기는 path(bare object) 필수.
    if not path or "://" in path:
        raise HTTPException(status_code=400, detail="path must be a bare object path")

    legacy_url = _PUBLIC_PREFIX + path  # legacy stored 형태(belongs 정확매치용)

    if conversation_id is not None:
        # ① 구조적 스코프 — 등록(sync)과 **동일 함수** path_in_source_scope 로 통일(까심 IDOR).
        #    conv 의 실 project_id 를 DB 조회해 `chat/{proj}/{conv}/`(legacy) 또는
        #    `org/{org}/project/{proj}/chat/{conv}/`(S7) **exact prefix**만 허용(중간 `/chat/` 우회 차단).
        conv_proj = (await db.execute(
            select(Conversation.project_id).where(
                Conversation.id == conversation_id, Conversation.org_id == org_id
            )
        )).scalar_one_or_none()
        if conv_proj is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        if not path_in_source_scope(path, "conversation_message", conv_proj, conversation_id, org_id):
            raise HTTPException(status_code=403, detail="Attachment path not scoped to this conversation")
        # 권한: conversation 참가자(canonical member). team_member 봐주기 없음.
        member = await resolve_member(auth, org_id, db, project_id=None)
        is_participant = (await db.execute(
            select(ConversationParticipant.id).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.member_id == member.id,
            )
        )).scalar_one_or_none()
        if is_participant is None:
            # owner/admin 우회 — conversations.py get_conversation/list 와 **동일 SSOT**(e6f25e53·선생님 제보):
            # agent-only 대화는 org owner/admin 열람 허용(메시지 LIST/get_conversation 은 보이는데 첨부 sign 만
            # 403 이던 불일치 해소). 휴먼 참가 대화(사적 DM)는 참가자-only 유지(프라이버시). belongs(②)는
            # 그대로 — 우회는 참가자 요건만 면제·임의 path 허용 아님. story 브랜치(has_project_access)는 무변경.
            from app.routers.conversations import (
                _conversation_has_human_participant,
                _effective_org_role,
            )
            role = await _effective_org_role(auth, org_id, db, member)
            if not (
                role in ("owner", "admin")
                and not await _conversation_has_human_participant(conversation_id, db)
            ):
                raise HTTPException(status_code=403, detail="Not a participant of this conversation")
        # ② 정확 매치: stored url == bare path(신규) OR == legacy 전체 URL. substring 금지.
        belongs = (await db.execute(
            text(
                "SELECT EXISTS ("
                " SELECT 1 FROM conversation_messages m,"
                " jsonb_array_elements(coalesce(m.attachments, '[]'::jsonb)) att"
                " WHERE m.conversation_id = :cid AND att->>'url' IN (:path, :legacy))"
            ),
            {"cid": conversation_id, "path": path, "legacy": legacy_url},
        )).scalar()
        if not belongs:
            raise HTTPException(status_code=403, detail="Attachment does not belong to this conversation")
    else:
        # story 의 실 project_id 를 먼저 조회 — 구조 스코프를 등록과 동일 함수로 통일(까심 IDOR·project
        # segment 도 story.project_id 와 정확 매치). `story/{proj}/{story}/` + `org/{org}/project/{proj}/story/{story}/`.
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
        if not path_in_source_scope(path, "story", project_id, story_id, org_id):
            raise HTTPException(status_code=403, detail="Attachment path not scoped to this story")
        if not await has_project_access(db, uuid.UUID(auth.user_id), project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")
        # ② 정확 매치: canonical object path == 요청 path
        belongs = any(
            _canonical_object_path(a.get("url") or "") == path
            for a in (attachments or [])
        )
        if not belongs:
            raise HTTPException(status_code=403, detail="Attachment does not belong to this story")

    return {"authorized": True}
