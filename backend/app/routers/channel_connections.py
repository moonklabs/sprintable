"""story #3373(Phase1·마케팅운영, 선생님 확定 2026-09-03) — 채널 연결 서비스 API. 휴먼
전용(에이전트 키는 목록·시작·콜백·해제 어느 것을 불러도 403 — 에이전트는 토큰 존재조차
읽지 못한다, AC6). 권한 3단(유나 화면설계 §8⑤, PO 채택):
  - 목록 열람: member 이상(토큰 필드는 응답 DTO 자체에 없음 — 제외가 아니라 애초에 안 실음)
  - 연결·해제·재인증: owner
  - (후속 스토리: 비밀 아닌 설정값 변경은 admin — 이 스토리엔 그런 엔드포인트가 없음)
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.channel_adapters import can_auto_refresh, get_channel_adapter
from app.services.channel_connection import (
    ChannelConnectionNotFoundError,
    apply_refresh_failure,
    decrypt_for_use,
    get_channel_connection,
    list_channel_connections,
    revoke_channel_connection,
    upsert_channel_connection,
)
from app.services.channel_oauth_state import (
    ChannelOAuthStateNotConfigured,
    generate_pkce_pair,
    sign_channel_oauth_state,
    verify_channel_oauth_state,
)
from app.services.member_resolver import resolve_member
from app.services.threads_oauth import ThreadsOAuthError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/organizations", tags=["channel-connections"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """AC6 — 에이전트 키는 이 라우터의 어떤 엔드포인트도 403. resolve_member()가 agent를
    TeamMember.type="agent"로 정확히 판정(S1의 actor_type fail-closed 원칙과 동일 축)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "CHANNEL_CONNECTION_HUMAN_ONLY",
                "message": "채널 연결은 휴먼 멤버만 가능합니다(에이전트는 토큰을 읽거나 다룰 수 없습니다).",
            },
        )
    return resolved


async def _require_owner(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    resolved = await _require_human(db, auth, org_id)
    if resolved.role != "owner":
        raise HTTPException(
            status_code=403,
            detail={"code": "CHANNEL_CONNECTION_OWNER_ONLY", "message": "채널 연결·해제·재인증은 조직 owner만 가능합니다."},
        )
    return resolved


def _redirect_uri(org_id: uuid.UUID, channel: str) -> str:
    from app.core.config import settings
    return f"{settings.app_url}/api/oauth-channel/callback/{channel}"


class ChannelConnectionResponse(BaseModel):
    id: uuid.UUID
    channel: str
    account_id: str
    account_label: str | None
    credential_kind: str
    status: str
    token_expires_at: str | None
    last_refreshed_at: str | None
    last_error: str | None
    can_auto_refresh: bool
    connected_by: uuid.UUID | None
    created_at: str
    updated_at: str


def _to_response(row) -> ChannelConnectionResponse:
    return ChannelConnectionResponse(
        id=row.id, channel=row.channel, account_id=row.account_id, account_label=row.account_label,
        credential_kind=row.credential_kind, status=row.status,
        token_expires_at=row.token_expires_at.isoformat() if row.token_expires_at else None,
        last_refreshed_at=row.last_refreshed_at.isoformat() if row.last_refreshed_at else None,
        last_error=row.last_error, can_auto_refresh=can_auto_refresh(row.refresh_mode),
        connected_by=row.connected_by, created_at=row.created_at.isoformat(), updated_at=row.updated_at.isoformat(),
    )


class AuthorizeResponse(BaseModel):
    url: str
    state: str


class CallbackRequest(BaseModel):
    code: str
    state: str


class TestConnectionResponse(BaseModel):
    ok: bool
    account: dict | None = None
    error: str | None = None


@router.get("/{org_id}/channel-connections", response_model=list[ChannelConnectionResponse])
async def list_channel_connections_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[ChannelConnectionResponse]:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_human(db, auth, org_id)
    rows = await list_channel_connections(db, org_id=org_id)
    return [_to_response(r) for r in rows]


@router.post("/{org_id}/channel-connections/{channel}/authorize", response_model=AuthorizeResponse)
async def authorize_channel_connection(
    org_id: uuid.UUID,
    channel: str,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> AuthorizeResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner(db, auth, org_id)

    adapter = get_channel_adapter(channel)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"unsupported channel: {channel}")

    code_verifier, code_challenge = generate_pkce_pair()
    try:
        state = sign_channel_oauth_state(
            org_id=org_id, requester_member_id=resolved.id, channel=channel, code_verifier=code_verifier,
        )
    except ChannelOAuthStateNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if channel == "threads":
        from app.services.threads_oauth import build_authorize_url
        url = build_authorize_url(redirect_uri=_redirect_uri(org_id, channel), state=state, code_challenge=code_challenge)
    else:
        raise HTTPException(status_code=404, detail=f"unsupported channel: {channel}")
    return AuthorizeResponse(url=url, state=state)


@router.post("/{org_id}/channel-connections/{channel}/callback", response_model=ChannelConnectionResponse)
async def channel_connection_callback(
    org_id: uuid.UUID,
    channel: str,
    body: CallbackRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ChannelConnectionResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner(db, auth, org_id)

    # story #3373 AC3·뮤테이션 대상 — state 검증을 제거하면 위조 state가 그대로 통과한다.
    oauth_state = verify_channel_oauth_state(body.state, expected_channel=channel)
    if oauth_state is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "CHANNEL_OAUTH_STATE_INVALID", "message": "OAuth state가 위조되었거나 만료되었습니다."},
        )
    if oauth_state.org_id != org_id:
        raise HTTPException(
            status_code=400,
            detail={"code": "CHANNEL_OAUTH_STATE_INVALID", "message": "OAuth state가 이 조직에 속하지 않습니다."},
        )

    adapter = get_channel_adapter(channel)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"unsupported channel: {channel}")

    if channel != "threads":
        raise HTTPException(status_code=404, detail=f"unsupported channel: {channel}")

    from app.services.threads_oauth import exchange_code_for_short_lived_token, exchange_for_long_lived_token, test_connection

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            short_lived_token, external_account_id = await exchange_code_for_short_lived_token(
                client, code=body.code, redirect_uri=_redirect_uri(org_id, channel),
                code_verifier=oauth_state.code_verifier,
            )
            long_lived_token, expires_in = await exchange_for_long_lived_token(
                client, short_lived_token=short_lived_token,
            )
            account = await test_connection(client, access_token=long_lived_token)
        except ThreadsOAuthError as exc:
            raise HTTPException(status_code=400, detail={"code": exc.code, "message": exc.message}) from exc

    row = await upsert_channel_connection(
        db, org_id=org_id, channel=channel, account_id=external_account_id,
        account_label=account.get("username"), credential_kind=adapter.credential_kind,
        access_token=long_lived_token, refresh_token=None,
        token_expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
        refresh_mode=adapter.refresh_mode, scopes=adapter.scope.split(","), connected_by=resolved.id,
    )
    return _to_response(row)


@router.post("/{org_id}/channel-connections/{connection_id}/disconnect", response_model=ChannelConnectionResponse)
async def disconnect_channel_connection(
    org_id: uuid.UUID,
    connection_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ChannelConnectionResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_owner(db, auth, org_id)
    try:
        row = await revoke_channel_connection(db, org_id=org_id, connection_id=connection_id)
    except ChannelConnectionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _to_response(row)


@router.post("/{org_id}/channel-connections/{connection_id}/test", response_model=TestConnectionResponse)
async def test_channel_connection(
    org_id: uuid.UUID,
    connection_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> TestConnectionResponse:
    """유나 화면설계 §8④ — 서버가 provider 경량 호출(Threads /me류)을 대신 하고 결과만
    반환한다. 토큰은 이 함수 스코프 밖으로 절대 안 나간다(응답 DTO에 없음)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_human(db, auth, org_id)  # member 이상이면 시험 가능 — human이면 충분(owner 제한 없음)

    row = await get_channel_connection(db, org_id=org_id, connection_id=connection_id)
    if row is None:
        raise HTTPException(status_code=404, detail="channel connection not found")

    access_token = decrypt_for_use(row)
    if access_token is None:
        return TestConnectionResponse(ok=False, error="연결에 저장된 토큰이 없습니다.")

    if row.channel != "threads":
        return TestConnectionResponse(ok=False, error=f"unsupported channel: {row.channel}")

    from app.services.threads_oauth import test_connection as threads_test_connection

    async with httpx.AsyncClient(timeout=10) as client:
        try:
            account = await threads_test_connection(client, access_token=access_token)
        except ThreadsOAuthError as exc:
            await apply_refresh_failure(db, connection=row, error_message=exc.message)
            return TestConnectionResponse(ok=False, error=exc.message)
    del access_token  # ⛔즉시 소비 후 폐기 — 더 들고 있지 않는다.
    return TestConnectionResponse(ok=True, account=account)
