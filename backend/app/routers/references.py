"""story #2283(BE) — 참조 직접생성 엔드포인트. 계약 doc `reference-direct-create-contract-20260728`
(PO 확정) 그대로 구현 — 미르코군의 FE 절반(#2283, PR #2575 merged)과 미래 #2269("본문 원석 3단계
승격")이 공유하는 write 경로.

⛔target_type/source_type 을 CHECK 로 나열하지 않는다 — 아래 두 dict(각각 target/source 게이트)가
SSOT 다. registry 에 없는 값은 400(등록 안 됨) — "나열 안 함"이 "아무거나 받음"은 아니다(#2259/#2266
과 동일 원칙).

⛔form 은 요청 바디에 없다 — 서버가 항상 "mention"으로 stamp 한다(계약서 그대로, proof 는 별도 write
경로 몫 — reference.py 모듈 docstring 참조).

⛔양쪽-아이템 게이트(404, 존재 비노출 오라클 — dependencies.py/evidence.py/gates.py 의 기존 관례와
동일) — source 접근과 target 접근을 **독립적으로** 검증한다("반쪽 금지").

⛔멱등 = 같은 (source_type, source_field, source_id, target_type, target_id, form) 튜플이면 200 +
기존 행 재반환(409 아님) — `insert_chat_mentions`(mention_parser.py)가 이미 쓰는 ON CONFLICT DO
NOTHING + 재조회 패턴을 그대로 재사용한다(재구현 0).

⛔DELETE(디디 판단, 계약서가 명시 요구) — 만든다. "확인" 오클릭 직후 되돌릴 길이 없으면 그 자체가
결손이라는 계약서 근거를 그대로 따른다. 삭제도 같은 양쪽-아이템 게이트(404)를 요구한다.
"""
from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.reference import Reference
from app.services.member_resolver import canonicalize_member_id
from app.services.project_auth import has_project_access
from app.services.reference_registry import PROJECT_ID_RESOLVERS

router = APIRouter(prefix="/api/v2/references", tags=["references", "Work"])


async def _chat_message_source_access(
    session: AsyncSession, source_id: uuid.UUID, org_id: uuid.UUID, auth: AuthContext
) -> bool:
    from app.models.conversation import ConversationMessage

    msg = (
        await session.execute(select(ConversationMessage).where(ConversationMessage.id == source_id))
    ).scalar_one_or_none()
    if msg is None:
        return False
    from app.routers.conversations import _can_read_conversation

    return await _can_read_conversation(msg.conversation_id, session, auth, org_id)


SourceAccessGate = Callable[[AsyncSession, uuid.UUID, uuid.UUID, AuthContext], Awaitable[bool]]

# ⛔지금 실제로 게이트가 서 있는 source_type만 여기 등록한다(#2266 BACKLINKS_ALLOWED_TARGET_TYPES
# 와 동형 원칙 — "허용목록=게이트가 실제로 선 것"). is_valid_source_type(reference_registry.py) 는
# doc/story/epic 도 source-capable 로 인정하지만, 그 접근 게이트는 아직 안 지었다(#2269 몫으로
# 계약서에 이미 예정) — 여기서 미리 짓지 않는다(#2260 이 고친 "도는 자리 없는 죽은 코드" 클래스
# 재발 금지). 등록 안 된 source_type 은 400(미지원)으로 정직하게 거부 — 조용히 통과 금지.
_SOURCE_ACCESS_GATES: dict[str, SourceAccessGate] = {
    "chat_message": _chat_message_source_access,
}


class CreateReferenceRequest(BaseModel):
    source_type: str
    source_id: uuid.UUID
    source_field: str
    target_type: str
    target_id: uuid.UUID


class ReferenceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source_type: str
    source_id: uuid.UUID
    target_type: str
    target_id: uuid.UUID
    form: str
    created_at: datetime


@router.post("", response_model=ReferenceResponse, status_code=201)
async def create_reference(
    body: CreateReferenceRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ReferenceResponse:
    source_gate = _SOURCE_ACCESS_GATES.get(body.source_type)
    if source_gate is None:
        raise HTTPException(status_code=400, detail=f"Unsupported source_type: {body.source_type}")

    target_resolver = PROJECT_ID_RESOLVERS.get(body.target_type)
    if target_resolver is None:
        raise HTTPException(status_code=400, detail=f"Unsupported target_type: {body.target_type}")

    # 양쪽-아이템 게이트 — source/target 독립 검증("반쪽 금지"). 둘 다 404(존재 비노출).
    if not await source_gate(session, body.source_id, org_id, auth):
        raise HTTPException(status_code=404, detail="Source not found")

    target_project_id = await target_resolver(session, org_id, body.target_id)
    if target_project_id is None:
        raise HTTPException(status_code=404, detail="Target not found")
    if not await has_project_access(session, uuid.UUID(auth.user_id), target_project_id, org_id):
        raise HTTPException(status_code=404, detail="Target not found")

    from app.routers.conversations import _resolve_member

    sender = await _resolve_member(auth, org_id, session, project_id=None)
    canonical_created_by = await canonicalize_member_id(sender.id, session)

    new_id = uuid.uuid4()
    stmt = pg_insert(Reference).values(
        id=new_id,
        org_id=org_id,
        source_type=body.source_type,
        source_field=body.source_field,
        source_id=body.source_id,
        target_type=body.target_type,
        target_id=body.target_id,
        form="mention",
        created_by=canonical_created_by,
    )
    stmt = stmt.on_conflict_do_nothing(
        index_elements=[
            Reference.source_type, Reference.source_field, Reference.source_id,
            Reference.target_type, Reference.target_id, Reference.form,
        ],
        index_where=Reference.form != "proof",
    )
    await session.execute(stmt)
    await session.commit()

    # 멱등 — insert 가 conflict 로 no-op 이었어도 기존 행을 그대로 재반환한다(계약: 재호출은
    # 409 가 아니라 200/201 + 기존 데이터).
    row = (
        await session.execute(
            select(Reference).where(
                Reference.org_id == org_id,
                Reference.source_type == body.source_type,
                Reference.source_field == body.source_field,
                Reference.source_id == body.source_id,
                Reference.target_type == body.target_type,
                Reference.target_id == body.target_id,
                Reference.form == "mention",
            )
        )
    ).scalar_one()
    return ReferenceResponse.model_validate(row)


@router.delete("/{reference_id}", status_code=204)
async def delete_reference(
    reference_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> None:
    row = (
        await session.execute(select(Reference).where(Reference.id == reference_id, Reference.org_id == org_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Reference not found")

    # 삭제도 생성과 동일한 양쪽-아이템 게이트를 요구한다 — 생성 이후 권한이 사라졌는데도
    # 지울 수 있으면 그 자체가 구멍이다(row 존재만으로 삭제를 허용하지 않는다).
    source_gate = _SOURCE_ACCESS_GATES.get(row.source_type)
    if source_gate is None or not await source_gate(session, row.source_id, org_id, auth):
        raise HTTPException(status_code=404, detail="Reference not found")

    target_resolver = PROJECT_ID_RESOLVERS.get(row.target_type)
    target_project_id = await target_resolver(session, org_id, row.target_id) if target_resolver else None
    if target_project_id is None or not await has_project_access(
        session, uuid.UUID(auth.user_id), target_project_id, org_id
    ):
        raise HTTPException(status_code=404, detail="Reference not found")

    await session.delete(row)
    await session.commit()
