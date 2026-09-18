"""story #3540(Phase1·마케팅운영, 페드루 PO 確定 2026-09-06) — 연결 화면 「성과 수집」
섹션이 읽는 상태 API. 발행 채널 연결(channel_connections.py)과는 별개 축 — beacon·UTM
둘 다 ChannelConnection 행이 아니다(beacon=자체 카운터, UTM=content_rules 플래그).

⛔beacon 관측이 상태를 바꾸는 함정 — `GET .../metering-key`(pageview_metering.py)는
키가 없으면 최초 발급하는 라우트라, 「성과 수집」 화면이 상태를 보려고 그걸 그대로
부르면 화면을 연 것만으로 키가 생겨 「아직 안 씀」 상태가 사라진다. 이 라우터는
그래서 발급 자체를 안 하는 별도 읽기 전용 경로(`get_beacon_status`)를 쓴다.

story #3583-BE(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — GA4 «고객 소유» 측정
연결 추가(key="ga4"). PO 確定 ① — GA4는 발행 채널이 아니라 측정 연결이라
`channel_adapters`/`ChannelConnection`에 안 얹고 이 자리(measurement_connections)에
key 하나로 얹는다. OAuth 콜백만 별도 router(`ga4_callback_router`, prefix가 다름) —
Google이 이 백엔드로 직접 리다이렉트하는 대상이라 org_id가 경로에 없다(github_
integration.py::install_callback과 동형, FE BFF 콜백 라우트 0 — org는 signed state
에서 나온다). 나머지(authorize·properties·select·disconnect)는 org-scoped 기존
router 그대로."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.ga4_connection import GA4Connection
from app.routers.channel_connections import _require_owner
from app.services.channel_credential_crypto import decrypt_channel_credential, encrypt_channel_credential
from app.services.channel_oauth_state import (
    ChannelOAuthStateNotConfigured,
    generate_pkce_pair,
    sign_channel_oauth_state,
    verify_channel_oauth_state,
)
from app.services.content_rules import get_org_content_rules
from app.services.ga4_oauth import (
    GA4OAuthError,
    build_authorize_url,
    classify_ga4_reauth_reason,
    exchange_code_for_tokens,
    is_persistent_ga4_auth_failure,
    list_properties,
    refresh_access_token,
    revoke_token,
)
from app.services.pageview_counter import get_beacon_status

router = APIRouter(prefix="/api/v2/organizations", tags=["measurement-connections"])
# story #3583-BE — org_id가 경로에 없는 유일한 엔드포인트(콜백)만 별도 prefix. 서로
# 다른 최상위 경로라 `/{org_id}` 파라미터 매칭과 충돌하지 않는다.
ga4_callback_router = APIRouter(prefix="/api/v2/measurement-connections", tags=["measurement-connections"])


class MeasurementConnectionItem(BaseModel):
    key: Literal["beacon", "utm", "ga4"]
    # beacon: "not_started"(키 미발급, 「아직 쓰지 않음」+시작하기)·"no_data_yet"
    # (키 있음·수신 0, 「아직 들어온 기록이 없습니다」)·"has_data"(수신>0, 「마지막
    # 기록 {last_seen_at}」). utm: "auto"(utm_rules.enabled=true, 자동 부착)·
    # "manual"(require_utm만 켜짐, 수동 규칙)·"off"(둘 다 꺼짐). ga4(story #3583-BE,
    # 계약 보강 3): "connected"(property 있음)·"property_pending"(토큰만 있음, 콜백
    # 직후)·"disconnected"(행 없음)·"needs_reauth"(사람이 다시 연결해야 풀림). 「연결됨」
    # 낱말은 이 값이 화면 문구로 바뀌는 어느 자리에서도 쓰지 않는다(유나 §13-7 明示 —
    # 우리는 beacon이 실제로 심겼는지 모른다, 키 발급≠사용 확認).
    status: str
    # beacon 전용(utm/ga4는 항상 null) — org_pageview_daily MAX(updated_at)·7일 SUM(count).
    last_seen_at: datetime | None = None
    count_7d: int | None = None
    # 「어디서 바꾸나」 링크 대상(화면 라우트 경로) — beacon은 이 스토리 스코프에
    # 발급 화면 자체가 없어 null(3540 참고 섹션 — 4180f67f 후속), utm은 이미 있는
    # 콘텐츠 규칙 화면(3540 PR1) 그대로. ga4는 화면이 이 행 자체에서 OAuth를
    # 시작하므로 별도 settings_path 불요(null).
    settings_path: str | None = None
    # story #3583-BE — ga4 전용(다른 key는 항상 null).
    property_id: str | None = None
    property_name: str | None = None
    connected_at: datetime | None = None
    # 계약 보강 4·5 — needs_reauth일 때만 값('expired'|'revoked'|'error'), 그 외 null
    # (없는 값을 지어내지 않는다 — FE는 null이면 사유 문구 자체를 안 그린다).
    reason: str | None = None


def _ga4_redirect_uri() -> str:
    """Google이 이 정확한 문자열로 콜백을 보낸다 — Google Cloud Console에 리다이렉트
    URI로 등록하는 것은 이 스토리 밖(analytics.readonly 스코프 동의화면 검수와 같은
    PO/사람 항목, `settings.backend_url` 참고 주석)."""
    return f"{settings.backend_url.rstrip('/')}/api/v2/measurement-connections/ga4/callback"


async def _get_ga4_connection(db: AsyncSession, *, org_id: uuid.UUID) -> GA4Connection | None:
    return (await db.execute(
        select(GA4Connection).where(GA4Connection.org_id == org_id)
    )).scalar_one_or_none()


def _ga4_item(connection: GA4Connection | None) -> MeasurementConnectionItem:
    if connection is None:
        return MeasurementConnectionItem(key="ga4", status="disconnected")
    return MeasurementConnectionItem(
        key="ga4", status=connection.status, property_id=connection.property_id,
        property_name=connection.property_name, connected_at=connection.connected_at,
        reason=connection.reason,
    )


async def _mark_ga4_needs_reauth(db: AsyncSession, connection: GA4Connection, exc: GA4OAuthError) -> None:
    """덧붙임(c) — 지속 실패만 승격. 호출부가 `is_persistent_ga4_auth_failure`로 이미
    걸러낸 뒤에만 부른다(이중 판정 0)."""
    connection.status = "needs_reauth"
    connection.reason = classify_ga4_reauth_reason(exc)
    await db.commit()


@router.get("/{org_id}/measurement-connections", response_model=list[MeasurementConnectionItem])
async def list_measurement_connections_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[MeasurementConnectionItem]:
    """org 멤버(휴먼·에이전트 모두) 읽기 가능 — available-channels·agent-visible과
    동형 권한 폭(이 응답엔 토큰·시크릿류 필드가 아예 없다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    now = datetime.now(timezone.utc)
    beacon = await get_beacon_status(db, org_id=org_id, now=now)
    if not beacon["key_issued"]:
        beacon_status = "not_started"
    elif beacon["last_seen_at"] is None:
        beacon_status = "no_data_yet"
    else:
        beacon_status = "has_data"

    rule_row = await get_org_content_rules(db, org_id=org_id)
    rules = rule_row.rules if rule_row is not None else {}
    utm_rules = rules.get("utm_rules") or {}
    if utm_rules.get("enabled"):
        utm_status = "auto"
    elif rules.get("require_utm"):
        utm_status = "manual"
    else:
        utm_status = "off"

    ga4_connection = await _get_ga4_connection(db, org_id=org_id)

    return [
        MeasurementConnectionItem(
            key="beacon", status=beacon_status,
            last_seen_at=beacon["last_seen_at"], count_7d=beacon["count_7d"],
        ),
        MeasurementConnectionItem(key="utm", status=utm_status, settings_path="/organization/content-rules"),
        _ga4_item(ga4_connection),
    ]


class GA4AuthorizeResponse(BaseModel):
    authorize_url: str


@router.post("/{org_id}/measurement-connections/ga4/authorize", response_model=GA4AuthorizeResponse)
async def ga4_authorize_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> GA4AuthorizeResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner(db, auth, org_id)

    if not settings.google_client_id or not settings.backend_url:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "GA4_NOT_CONFIGURED",
                "message": "이 환경에 GA4 연결이 아직 구성되지 않았습니다(google_client_id/backend_url 미설정).",
            },
        )

    # PKCE는 실제로 안 쓴다(confidential client, facebook_oauth.py와 동일 판단) —
    # `sign_channel_oauth_state`가 code_verifier를 필수 인자로 요구해 채우기만 한다.
    code_verifier, _code_challenge = generate_pkce_pair()
    try:
        state = sign_channel_oauth_state(
            org_id=org_id, requester_member_id=resolved.id, channel="ga4", code_verifier=code_verifier,
        )
    except ChannelOAuthStateNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    url = build_authorize_url(redirect_uri=_ga4_redirect_uri(), state=state, client_id=settings.google_client_id)
    return GA4AuthorizeResponse(authorize_url=url)


@ga4_callback_router.get("/ga4/callback")
async def ga4_callback_endpoint(
    state: str = Query(...),
    code: str | None = Query(default=None),
    error: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Google이 직접 호출하는 리다이렉트 대상 — Bearer 인증이 없다(org는 signed
    state에서 나온다, github_integration.py::install_callback과 동형). 계약 보강
    3 — 성공 시 `…/organization/channels?ga4=property`로 리다이렉트(쿼리는 포커스
    힌트뿐, 행 status가 화면을 정한다)."""
    redirect_base = f"{settings.app_url.rstrip('/')}/organization/channels"

    oauth_state = verify_channel_oauth_state(state, expected_channel="ga4")
    if oauth_state is None:
        return RedirectResponse(url=f"{redirect_base}?ga4=invalid_state", status_code=302)
    if error is not None or not code:
        # 사용자가 Google 동의화면에서 거부(error="access_denied" 등) — 위조가 아니라
        # 정상적인 「취소」다, invalid_state와 다른 사유로 구분.
        return RedirectResponse(url=f"{redirect_base}?ga4=denied", status_code=302)

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            access_token, refresh_token, _expires_in = await exchange_code_for_tokens(
                client, code=code, redirect_uri=_ga4_redirect_uri(),
                client_id=settings.google_client_id, client_secret=settings.google_client_secret,
            )
        except GA4OAuthError:
            return RedirectResponse(url=f"{redirect_base}?ga4=error", status_code=302)

    existing = await _get_ga4_connection(db, org_id=oauth_state.org_id)
    if existing is not None:
        # 재연결(기존 행 위에 새 토큰) — property는 재선택을 요구한다(옛 속성이 이번
        # 계정에도 있다는 보장이 없다, 지어내지 않는다).
        existing.encrypted_access_token = encrypt_channel_credential(access_token)
        existing.encrypted_refresh_token = encrypt_channel_credential(refresh_token)
        existing.property_id = None
        existing.property_name = None
        existing.status = "property_pending"
        existing.reason = None
        existing.connected_by = oauth_state.requester_member_id
        existing.connected_at = None
    else:
        db.add(GA4Connection(
            id=uuid.uuid4(), org_id=oauth_state.org_id,
            encrypted_access_token=encrypt_channel_credential(access_token),
            encrypted_refresh_token=encrypt_channel_credential(refresh_token),
            status="property_pending", connected_by=oauth_state.requester_member_id,
        ))
    await db.commit()
    return RedirectResponse(url=f"{redirect_base}?ga4=property", status_code=302)


class GA4PropertyItem(BaseModel):
    property_id: str
    display_name: str


@router.get("/{org_id}/measurement-connections/ga4/properties", response_model=list[GA4PropertyItem])
async def ga4_list_properties_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[GA4PropertyItem]:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_owner(db, auth, org_id)

    connection = await _get_ga4_connection(db, org_id=org_id)
    if connection is None:
        raise HTTPException(
            status_code=404, detail={"code": "GA4_NOT_CONNECTED", "message": "GA4가 연결되어 있지 않습니다."},
        )

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            access_token, _expires_in = await refresh_access_token(
                client, refresh_token=decrypt_channel_credential(connection.encrypted_refresh_token),
                client_id=settings.google_client_id, client_secret=settings.google_client_secret,
            )
        except GA4OAuthError as exc:
            if is_persistent_ga4_auth_failure(exc):
                await _mark_ga4_needs_reauth(db, connection, exc)
                raise HTTPException(
                    status_code=409, detail={"code": "GA4_NEEDS_REAUTH", "message": "GA4 재인증이 필요합니다."},
                ) from exc
            raise HTTPException(
                status_code=502, detail={"code": "GA4_TOKEN_REFRESH_FAILED", "message": exc.message},
            ) from exc
        try:
            properties = await list_properties(client, access_token=access_token)
        except GA4OAuthError as exc:
            raise HTTPException(
                status_code=502, detail={"code": "GA4_LIST_PROPERTIES_FAILED", "message": exc.message},
            ) from exc

    connection.encrypted_access_token = encrypt_channel_credential(access_token)
    await db.commit()
    return [GA4PropertyItem(**p) for p in properties]


class GA4SelectPropertyRequest(BaseModel):
    property_id: str


@router.post("/{org_id}/measurement-connections/ga4/select", response_model=MeasurementConnectionItem)
async def ga4_select_property_endpoint(
    org_id: uuid.UUID,
    body: GA4SelectPropertyRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> MeasurementConnectionItem:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_owner(db, auth, org_id)

    connection = await _get_ga4_connection(db, org_id=org_id)
    if connection is None:
        raise HTTPException(
            status_code=404, detail={"code": "GA4_NOT_CONNECTED", "message": "GA4가 연결되어 있지 않습니다."},
        )

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            access_token, _expires_in = await refresh_access_token(
                client, refresh_token=decrypt_channel_credential(connection.encrypted_refresh_token),
                client_id=settings.google_client_id, client_secret=settings.google_client_secret,
            )
        except GA4OAuthError as exc:
            if is_persistent_ga4_auth_failure(exc):
                await _mark_ga4_needs_reauth(db, connection, exc)
                raise HTTPException(
                    status_code=409, detail={"code": "GA4_NEEDS_REAUTH", "message": "GA4 재인증이 필요합니다."},
                ) from exc
            raise HTTPException(
                status_code=502, detail={"code": "GA4_TOKEN_REFRESH_FAILED", "message": exc.message},
            ) from exc
        try:
            properties = await list_properties(client, access_token=access_token)
        except GA4OAuthError as exc:
            raise HTTPException(
                status_code=502, detail={"code": "GA4_LIST_PROPERTIES_FAILED", "message": exc.message},
            ) from exc

    match = next((p for p in properties if p["property_id"] == body.property_id), None)
    if match is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "GA4_PROPERTY_NOT_FOUND", "message": "이 계정에서 접근 가능한 속성이 아닙니다."},
        )

    connection.encrypted_access_token = encrypt_channel_credential(access_token)
    connection.property_id = match["property_id"]
    connection.property_name = match["display_name"]
    connection.status = "connected"
    connection.reason = None
    connection.connected_at = datetime.now(timezone.utc)
    await db.commit()
    return _ga4_item(connection)


@router.delete("/{org_id}/measurement-connections/ga4", status_code=204)
async def ga4_disconnect_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> None:
    """계약 보강(해제 의미) — 토큰 폐기(Google revoke 호출)+행 삭제. **이미 모인
    유입 evidence(InsightSnapshot.normalized의 inflow_* 키)는 보존** — 이 함수는
    ga4_connections 행만 지운다, insight_snapshots는 절대 안 건드린다(과거 측정은
    사실이지 삭제 대상이 아니다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_owner(db, auth, org_id)

    connection = await _get_ga4_connection(db, org_id=org_id)
    if connection is None:
        return  # 멱등 — 이미 연결이 없으면 조용히 204.

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            await revoke_token(client, token=decrypt_channel_credential(connection.encrypted_refresh_token))
        except GA4OAuthError:
            # 덧붙임(b) — Google 쪽 폐기가 실패해도(이미 폐기됐거나 네트워크 문제) 우리
            # 쪽 연결 해제 자체는 계속 진행한다(사용자 관점에서 「해제됨」이 인질 잡히면
            # 안 된다). 로그는 이 예외가 이미 provider 원문을 [:500]로 들고 있다.
            pass

    await db.execute(delete(GA4Connection).where(GA4Connection.id == connection.id))
    await db.commit()
