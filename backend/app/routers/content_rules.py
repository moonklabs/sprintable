"""story #3471(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙 API.
GET은 org 멤버(휴먼·에이전트 모두) — 에이전트가 톤·택소노미·채널 우선순위·브랜드 킷
선언 슬롯을 읽어야 하는 축(PO 確定 "에이전트: 위반 경고·개선 제안"). PUT은 owner만
(휴먼이 정책 작성·버전 관리·활성화, 블루프린트 §2(f) 明示)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.content_rules import get_org_content_rules, put_org_content_rules
from app.services.member_resolver import resolve_member
from app.services.project_auth import assert_target_in_caller_org

router = APIRouter(prefix="/api/v2/organizations", tags=["content-rules"])


async def _require_owner(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human" or resolved.role != "owner":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "CONTENT_RULES_OWNER_ONLY",
                "message": "콘텐츠 규칙 편집은 조직 owner만 가능합니다.",
            },
        )
    return resolved


class ContentRulesResponse(BaseModel):
    org_id: uuid.UUID
    rules: dict
    version: int


class ContentRulesFields(BaseModel):
    """페드루 PO 리뷰 보정(2026-09-05, PR#3825) — `rules: dict`가 무형식이라
    `banned_terms`에 문자열 "spam"을 그대로 넣으면 `lint_content()`의
    `for term in banned_terms`가 글자 단위(s·p·a·m)로 돌아 오타가 조용히 통과했다
    (「오타로 써도 통과하나」의 자리). `extra="forbid"`로 모르는 키도 거부 —
    휴먼이 실수로 다른 철자를 쳐도 그 값이 조용히 무시되는 대신 422로 알린다."""

    model_config = ConfigDict(extra="forbid")

    banned_terms: list[str] = []
    require_utm: bool = False
    tone: str | None = None
    taxonomy: list[str] = []
    channel_priority: list[str] = []
    brand_kit: dict | None = None


class PutContentRulesRequest(BaseModel):
    rules: dict


@router.get("/{org_id}/content-rules", response_model=ContentRulesResponse)
async def get_content_rules_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ContentRulesResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    row = await get_org_content_rules(db, org_id=org_id)
    if row is None:
        return ContentRulesResponse(org_id=org_id, rules={}, version=0)
    return ContentRulesResponse(org_id=row.org_id, rules=row.rules, version=row.version)


@router.put("/{org_id}/content-rules", response_model=ContentRulesResponse)
async def put_content_rules_endpoint(
    org_id: uuid.UUID,
    body: PutContentRulesRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ContentRulesResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner(db, auth, org_id)

    # story #3471(페드루 PO 確定) — 이 리소스는 org_id 자신이 식별자라 target org가
    # 항상 caller org와 같다(구조적으로 spoof 불가) — meetings.py::cancel_meeting과
    # 동형으로 직접 호출해 PATH_ID 뮤테이션 스캐너 가시성을 미리 확보한다(#3806 CI
    # 재발 방지, 실 동작은 무변).
    assert_target_in_caller_org(org_id, org_id)

    try:
        validated = ContentRulesFields.model_validate(body.rules)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "CONTENT_RULES_INVALID", "message": str(exc)},
        ) from exc

    row = await put_org_content_rules(
        db, org_id=org_id, rules=validated.model_dump(), updated_by_member_id=resolved.id,
    )
    return ContentRulesResponse(org_id=row.org_id, rules=row.rules, version=row.version)
