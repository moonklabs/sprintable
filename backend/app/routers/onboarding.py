"""OB-4: 온보딩 funnel 이벤트 수신 엔드포인트 (측정계약 doc §2).

`POST /api/v2/onboarding/events` — OB-3 프록시가 보내는 FE emit 4종(+BE도 가능)의 끝단.
**optional auth**: agent 키 있으면 서버가 agent_id/org_id/project_id/key_prefix 도출(서버-truth·클라
신뢰 금지), 없으면 pre-auth(익명·session_id만). **PII 가드(AC3)**: 전체키 형태 발견 시 422 reject·
key_prefix ≤12. 측정 끝단이라 fire-and-forget(202).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import _resolve_api_key, bearer_scheme
from app.dependencies.database import get_db
from app.services.onboarding_funnel import (
    EVENT_CATALOG,
    FAILURE_REASONS,
    KEY_PREFIX_MAX,
    contains_secret,
    record_onboarding_event,
    safe_key_prefix,
)

router = APIRouter(prefix="/api/v2/onboarding", tags=["onboarding"])


class OnboardingEventBody(BaseModel):
    event: str
    session_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None
    runtime: str | None = None
    env: str | None = None
    transport: str | None = None
    key_prefix: str | None = None
    failure_reason: str | None = None
    client_ts: datetime | None = None
    meta: dict = Field(default_factory=dict)


@router.post("/events", status_code=202)
async def post_onboarding_event(
    body: OnboardingEventBody,
    db: AsyncSession = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    x_agent_api_key: str | None = Header(default=None, alias="x-agent-api-key"),
) -> dict:
    # AC1: 이벤트 enum(11) 화이트리스트 — 그 외 422.
    if body.event not in EVENT_CATALOG:
        raise HTTPException(status_code=422, detail=f"unknown event: {body.event}")
    if body.failure_reason and body.failure_reason not in FAILURE_REASONS:
        raise HTTPException(status_code=422, detail=f"unknown failure_reason: {body.failure_reason}")

    # AC3: PII/시크릿 가드 — 어느 필드(key_prefix·meta 등)든 전체키 형태면 reject(저장 금지).
    if contains_secret(body.model_dump(mode="json")):
        raise HTTPException(status_code=422, detail="plaintext secret detected — rejected")
    if body.key_prefix and len(body.key_prefix) > KEY_PREFIX_MAX:
        raise HTTPException(status_code=422, detail="key_prefix must be prefix-only (≤12)")

    # RC-2(산티아고): client-supplied agent_id/org_id/project_id/key_prefix **전부 불신** — valid 키서만
    # 서버가 도출(스푸핑 차단). 무효/무인증이면 None 유지(pre-auth=session_id만 신뢰). body.agent_id 무시.
    agent_id: uuid.UUID | None = None
    org_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    key_prefix: str | None = None
    raw_key = (
        x_agent_api_key
        if (x_agent_api_key and x_agent_api_key.startswith("sk_"))
        else (credentials.credentials if credentials else None)
    )
    if raw_key:
        try:
            ctx = await _resolve_api_key(raw_key, db)
            app_meta = ctx.claims.get("app_metadata", {})
            agent_id = uuid.UUID(ctx.user_id)
            org_id = uuid.UUID(app_meta["org_id"]) if app_meta.get("org_id") else None
            project_id = uuid.UUID(app_meta["project_id"]) if app_meta.get("project_id") else None
            key_prefix = safe_key_prefix(raw_key)  # 서버측 prefix(클라 미신뢰)
        except Exception:
            # 키 무효 → pre-auth(익명) 취급. 측정 끝단은 reject보다 best-effort 캡처 우선.
            pass

    await record_onboarding_event(
        db,
        event=body.event,
        session_id=body.session_id,
        agent_id=agent_id,
        org_id=org_id,
        project_id=project_id,
        runtime=body.runtime,
        env=body.env,
        transport=body.transport,
        key_prefix=key_prefix,
        failure_reason=body.failure_reason,
        client_ts=body.client_ts,
        meta=body.meta,
    )
    await db.commit()
    return {"ok": True}
