"""story #2283(BE) — 참조 직접생성 엔드포인트. 계약 doc `reference-direct-create-contract-20260728`
(PO 확정) 그대로 구현 — 미르코군의 FE 절반(#2283, PR #2575 merged)과 미래 #2269("본문 원석 3단계
승격")이 공유하는 write 경로.

⛔target_type/source_type 을 CHECK 로 나열하지 않는다 — 아래 두 dict(각각 target/source 게이트)가
SSOT 다. registry 에 없는 값은 400(등록 안 됨) — "나열 안 함"이 "아무거나 받음"은 아니다(#2259/#2266
과 동일 원칙).

⛔form 은 요청 바디에 없다 — 서버가 항상 "mention"으로 stamp 한다(계약서 그대로, proof 는 별도 write
경로 몫 — reference.py 모듈 docstring 참조).

⛔source_field 도 요청 바디에 없다(PO 판정, 2026-07-28 PR #2582 리뷰) — 멱등 유니크
(uq_entity_references_non_proof)가 source_field 를 키에 포함하므로, 클라이언트가
`"body"`/`"Body"`처럼 대소문자만 다르게 보내면 **같은 연결이 두 행으로 쪼개진다**(form 을
서버가 stamp 하는 것과 동일한 이유 — 멱등 키는 클라이언트 손에 두지 않는다). source_type 마다
"어느 칸에서 왔는가"가 갈리는 날(#2269 — story description vs acceptance_criteria) 이 매핑을
registry 로 옮긴다. 그전까지는 `_SOURCE_TYPE_CONFIG` 가 고정값으로 정한다.

⛔양쪽-아이템 게이트(404, 존재 비노출 오라클 — dependencies.py/evidence.py/gates.py 의 기존 관례와
동일) — source 접근과 target 접근을 **독립적으로** 검증한다("반쪽 금지").

⛔멱등 = 같은 (source_type, source_field, source_id, target_type, target_id, form) 튜플이면
**200**(이미 있던 것) 또는 **201**(방금 생김) — 둘 다 데이터는 같지만 상태 코드로 "새로 생겼는지"를
구별한다(PO 판정 — FE 가 "N개 연결됨"을 셀 때 연타가 부풀리면 안 된다). `ON CONFLICT DO NOTHING
.returning(...)` 으로 "내 insert 가 실제로 꽂혔는가"를 직접 판정한다 — 방금 insert 시도 직후의
무조건 select(과거 초안의 실수)는 우리 conflict 가 아닌 다른 이유로 no-op 났을 때 0행을 만나
`scalar_one()` 이 500 을 던질 수 있어(PO 지적) 쓰지 않는다.

⛔DELETE(디디 판단, 계약서가 명시 요구) — 만든다. "확인" 오클릭 직후 되돌릴 길이 없으면 그 자체가
결손이라는 계약서 근거를 그대로 따른다. 삭제도 같은 양쪽-아이템 게이트(404)를 요구한다.
"""
from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import NamedTuple

from fastapi import APIRouter, Depends, HTTPException, Response
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


async def _story_source_access(
    session: AsyncSession, source_id: uuid.UUID, org_id: uuid.UUID, auth: AuthContext
) -> bool:
    """story #2222 — origin_type="story"로 생긴 created_from 참조를 지우는 길을 연다(만드는
    자가 자기 뒷정리도 낸다는 원칙, 오르테가 판정 2026-07-31). PROJECT_ID_RESOLVERS["story"]
    (기존 target-side 해소기, reference_registry.py)를 그대로 재사용 — source-side 전용
    새 쿼리를 짓지 않는다."""
    project_id = await PROJECT_ID_RESOLVERS["story"](session, org_id, source_id)
    if project_id is None:
        return False
    return await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id)


SourceAccessGate = Callable[[AsyncSession, uuid.UUID, uuid.UUID, AuthContext], Awaitable[bool]]


class SourceTypeConfig(NamedTuple):
    source_field: str
    access_gate: SourceAccessGate


# ⛔지금 실제로 게이트가 서 있는 source_type만 여기 등록한다(#2266 BACKLINKS_ALLOWED_TARGET_TYPES
# 와 동형 원칙 — "허용목록=게이트가 실제로 선 것"). is_valid_source_type(reference_registry.py) 는
# doc/story/epic 도 source-capable 로 인정하지만, ⭐"story"는 story #2222(「낳음」 자동부착)가
# 바로 이 PR 에서 origin_type="story" 소비자를 실제로 만들기 시작하므로(MCP 도구가 이 값을
# 권장) 그 조건("소비자 없는 것을 미리 짓지 않는다")이 지금 충족돼 게이트를 연다(오르테가 판정
# — 만드는 자가 지우는 길도 같이 낸다. story #2357 사슬과 동형: 되돌릴 길이 없으면 안 쓰인다).
# ⛔doc/epic 은 그대로 손대지 않는다 — 그 둘은 아직 실제 소비자가 없어 정말 #2269 몫이다
# (아래 pin 테스트가 그 둘이 열리는 날 빨개진다 = #2269 도래 신호). 등록 안 된 source_type 은
# 400(미지원)으로 정직하게 거부 — 조용히 통과 금지.
# ⛔source_field 를 access_gate 와 «같은 dict»에 묶은 것은 의도적 — 따로 두면 새 source_type을
# 열 때 한쪽만(예: 게이트만) 추가하고 field 매핑은 깜빡할 수 있다(오늘 PROJECT_ID_RESOLVERS 에
# 적용한 것과 동일한 twin-system drift 방지 원칙). source_field="self"는 stories.py의 origin
# insert가 이미 쓰는 값과 동형(app/models/reference.py sentinel 원칙 그대로).
_SOURCE_TYPE_CONFIG: dict[str, SourceTypeConfig] = {
    "chat_message": SourceTypeConfig("body", _chat_message_source_access),
    "story": SourceTypeConfig("self", _story_source_access),
}


class CreateReferenceRequest(BaseModel):
    source_type: str
    source_id: uuid.UUID
    target_type: str
    target_id: uuid.UUID


class ReferenceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source_type: str
    source_id: uuid.UUID
    source_field: str
    target_type: str
    target_id: uuid.UUID
    form: str
    created_at: datetime


@router.post("", response_model=ReferenceResponse, status_code=201)
async def create_reference(
    body: CreateReferenceRequest,
    response: Response,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ReferenceResponse:
    config = _SOURCE_TYPE_CONFIG.get(body.source_type)
    if config is None:
        raise HTTPException(status_code=400, detail=f"Unsupported source_type: {body.source_type}")

    target_resolver = PROJECT_ID_RESOLVERS.get(body.target_type)
    if target_resolver is None:
        raise HTTPException(status_code=400, detail=f"Unsupported target_type: {body.target_type}")

    # 양쪽-아이템 게이트 — source/target 독립 검증("반쪽 금지"). 둘 다 404(존재 비노출).
    if not await config.access_gate(session, body.source_id, org_id, auth):
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
        source_field=config.source_field,
        source_id=body.source_id,
        target_type=body.target_type,
        target_id=body.target_id,
        form="mention",
        created_by=canonical_created_by,
    )
    stmt = stmt.on_conflict_do_nothing(
        # story #2267(C-9): relation이 유니크 인덱스에 추가돼 이 목록도 같이 늘어야 매치한다 —
        # 이 라우트는 relation을 안 채우므로(위 .values() 참조) 컬럼 기본값 'none'이 그대로
        # 적용된다("본문 참조", 이 라우트의 명시적 멘션 생성 용도 그대로).
        index_elements=[
            Reference.source_type, Reference.source_field, Reference.source_id,
            Reference.target_type, Reference.target_id, Reference.form, Reference.relation,
        ],
        index_where=Reference.form != "proof",
    ).returning(Reference.id)
    inserted_id = (await session.execute(stmt)).scalar_one_or_none()
    await session.commit()

    if inserted_id is not None:
        # 내 insert 가 실제로 꽂혔다 — 방금 생긴 것(201, 라우트 기본값 그대로).
        row_id = inserted_id
    else:
        # 멱등 충돌 — 이미 있던 것(200). 재조회는 우리가 겨냥한 그 튜플로만 좁혀서(다른 이유로
        # 0행이면 501 대신 명시적 500 — "있어야 하는데 없다"를 조용히 넘기지 않는다).
        response.status_code = 200
        existing_id = (
            await session.execute(
                select(Reference.id).where(
                    Reference.org_id == org_id,
                    Reference.source_type == body.source_type,
                    Reference.source_field == config.source_field,
                    Reference.source_id == body.source_id,
                    Reference.target_type == body.target_type,
                    Reference.target_id == body.target_id,
                    Reference.form == "mention",
                )
            )
        ).scalar_one_or_none()
        if existing_id is None:
            raise HTTPException(
                status_code=500,
                detail="Insert conflicted but no matching reference row found — unexpected state",
            )
        row_id = existing_id

    row = (await session.execute(select(Reference).where(Reference.id == row_id))).scalar_one()
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
    config = _SOURCE_TYPE_CONFIG.get(row.source_type)
    if config is None or not await config.access_gate(session, row.source_id, org_id, auth):
        raise HTTPException(status_code=404, detail="Reference not found")

    target_resolver = PROJECT_ID_RESOLVERS.get(row.target_type)
    target_project_id = await target_resolver(session, org_id, row.target_id) if target_resolver else None
    if target_project_id is None or not await has_project_access(
        session, uuid.UUID(auth.user_id), target_project_id, org_id
    ):
        raise HTTPException(status_code=404, detail="Reference not found")

    await session.delete(row)
    await session.commit()
