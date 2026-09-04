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
from app.services.channel_app_credentials import (
    get_channel_app_credentials,
    resolve_app_credentials,
    resolve_app_credentials_source,
    upsert_channel_app_credentials,
)
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


async def _require_owner_or_admin(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """story 5b27b32f(AC2) — 샌드박스 연결 생성은 실 OAuth 연결(_require_owner, owner
    전용)보다 넓은 owner/admin(channel_posts.py::_require_owner_or_admin·site_posts.py와
    동형 폭 — 테스트 인프라라 취소·회수와 같은 급으로 취급, 실제 외부 계정 자격을
    다루는 실채널 연결보다는 덜 민감하다는 판단)."""
    resolved = await _require_human(db, auth, org_id)
    if resolved.role not in ("owner", "admin"):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY",
                "message": "샌드박스 채널 연결은 조직 owner 또는 admin만 가능합니다.",
            },
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
    # story #3394(AC4, S2c BE 선행) — 어댑터가 선언한 글자 수 한도(Threads=500). FE가
    # 하드코딩하면 다른 채널이 붙을 때 값이 틀리는 재발(담롱군 §4-6)이 난다 — 선언 안 한
    # 채널이면 null("한도 미확認", 지어내지 않는다).
    max_text_length: int | None = None
    # story #3419(AC4) — 「이 연결로 지금 발행 글을 회수할 수 있나」의 최종 판정값(어댑터
    # `supports_unpublish` ∧ 연결 `scopes`에 필요 스코프 포함, PO 확定 산식 그대로). FE가
    # 이 값 하나로 버튼을 그리거나 안 그린다 — scopes 원본을 노출해 FE가 다시 판정하게
    # 만들지 않는다(판정 로직 단일 지점).
    can_unpublish: bool = False
    # 페드루 PO 리뷰(2026-09-04, PR#3774) — can_unpublish=false 하나로는 FE가 유나
    # §17-11의 두 문구(「미지원」vs「재연결하면 회수 가능」)를 못 가른다. 어느 쪽인지
    # 명시하는 판정값 — can_unpublish=true면 항상 null(막힌 이유가 없다).
    # 'unsupported' = 어댑터가 이 채널에 회수 자체를 선언 안 함(재연결해도 안 풀림,
    # §17-11 문구 대상 아님 — 그 절 자체가 "스코프 부족"만 다룬다) ·
    # 'scope_insufficient' = 어댑터는 지원하는데 이 연결에 필요 스코프가 없음(재연결
    # 하면 풀림 — §17-11 owner/member 문구가 이 값 전용).
    unpublish_blocked_reason: str | None = None
    # story 620beefc(AC2) — 어댑터 이미지 규격 선언 노출(§13 규격 문구 3요소 중 "무엇이·
    # 얼마까지" 축 — FE가 하드코딩하지 않고 이 값으로 문구를 조립한다. max_text_length와
    # 동형 관례: 이미지 미지원 채널(image_max_count=0)이면 image_max_count=0으로 그대로
    # 노출(null이 아니다 — "0건 허용"과 "모른다"는 다르다, 이 필드는 항상 선언돼 있다).
    image_formats: list[str] = []
    image_max_bytes: int = 0
    image_aspect_max: float = 0.0
    image_width_min: int = 0
    image_width_max: int = 0
    image_color_space: str = ""
    image_max_count: int = 0


def _to_response(row) -> ChannelConnectionResponse:
    adapter = get_channel_adapter(row.channel)
    max_text_length = adapter.max_text_length if adapter is not None and adapter.max_text_length > 0 else None
    supports_unpublish = adapter is not None and adapter.supports_unpublish
    has_required_scope = bool(
        supports_unpublish and adapter.unpublish_required_scope in (row.scopes or [])
    )
    can_unpublish = supports_unpublish and has_required_scope
    if can_unpublish:
        unpublish_blocked_reason = None
    elif not supports_unpublish:
        unpublish_blocked_reason = "unsupported"
    else:
        unpublish_blocked_reason = "scope_insufficient"
    return ChannelConnectionResponse(
        id=row.id, channel=row.channel, account_id=row.account_id, account_label=row.account_label,
        credential_kind=row.credential_kind, status=row.status,
        token_expires_at=row.token_expires_at.isoformat() if row.token_expires_at else None,
        last_refreshed_at=row.last_refreshed_at.isoformat() if row.last_refreshed_at else None,
        last_error=row.last_error, can_auto_refresh=can_auto_refresh(row.refresh_mode),
        connected_by=row.connected_by, created_at=row.created_at.isoformat(), updated_at=row.updated_at.isoformat(),
        unpublish_blocked_reason=unpublish_blocked_reason,
        max_text_length=max_text_length, can_unpublish=can_unpublish,
        image_formats=list(adapter.image_formats) if adapter is not None else [],
        image_max_bytes=adapter.image_max_bytes if adapter is not None else 0,
        image_aspect_max=adapter.image_aspect_max if adapter is not None else 0.0,
        image_width_min=adapter.image_width_min if adapter is not None else 0,
        image_width_max=adapter.image_width_max if adapter is not None else 0,
        image_color_space=adapter.image_color_space if adapter is not None else "",
        image_max_count=adapter.image_max_count if adapter is not None else 0,
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


class AppCredentialsRequest(BaseModel):
    app_id: str
    app_secret: str


class AppCredentialsPutResponse(BaseModel):
    """PUT 응답 — secret은 절대 안 실림(페드루 PO 2026-09-03 08:29Z). app_id는 owner가 방금
    직접 입력한 값을 그대로 되돌려줄 뿐이라 비밀이 아니다(GET과 달리 끝4자리로 자르지 않음)."""
    configured: bool
    app_id: str


class AppCredentialsStatusResponse(BaseModel):
    """GET 응답 — app_id는 끝 4자리만(페드루 PO 지시).

    `effective_source`(페드루 PO 2026-09-03 11:19Z, 유나 화면설계 실측) — resolve_app_
    credentials()의 3단 해석 결과 그대로("org"|"platform"|"none"). `configured`(=조직이
    직접 등록했나)와는 다른 축 — configured=false라도 effective_source="platform"이면
    화면은 「공용 앱으로 연결 가능」을 보여줄 수 있고, "none"이면 authorize가 409로 막힌다는
    뜻이라 그 사실을 미리 알려야 한다."""
    configured: bool
    app_id_suffix: str | None = None
    updated_by: uuid.UUID | None = None
    updated_at: str | None = None
    effective_source: str = "none"


def _app_id_suffix(app_id: str) -> str:
    return app_id[-4:] if len(app_id) >= 4 else app_id


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


class ChannelConnectionAgentVisibleItem(BaseModel):
    """story #3399(AC8) — 채널 포스트 초안(#3374)을 만들려면 `connection_id`가 필요한데,
    전체 목록(`GET .../channel-connections`)은 human-only(AC6, 토큰 인접 필드까지 실린다)라
    에이전트는 지금 그 id를 알 방법이 없다. 이 자리는 **별도 엔드포인트**로 연다(기존
    human-only 엔드포인트를 열어젖히지 않는다 — pin된 `test_agent_gets_403_on_every_
    endpoint` 회귀 방지) — 필드는 발행 도구가 채널을 골라 초안을 만드는 데 필요한 최소
    (id·channel·account_label·status)뿐, 토큰·`token_expires_at`·`last_error`·
    `connected_by` 등은 절대 안 싣는다."""
    id: uuid.UUID
    channel: str
    account_label: str | None
    status: str


def _to_agent_visible_item(row) -> ChannelConnectionAgentVisibleItem:
    return ChannelConnectionAgentVisibleItem(
        id=row.id, channel=row.channel, account_label=row.account_label, status=row.status,
    )


@router.get(
    "/{org_id}/channel-connections/agent-visible", response_model=list[ChannelConnectionAgentVisibleItem],
)
async def list_channel_connections_agent_visible_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[ChannelConnectionAgentVisibleItem]:
    """story #3399(AC8) — 휴먼·에이전트 둘 다 호출 가능(초안 API·목록 API와 동형 —
    actor_type 가드 없음, `get_verified_org_id`만으로 org 스코프 충분). 전체 목록
    엔드포인트(위)와 달리 `_require_human()`을 안 부른다 — 그게 이 엔드포인트의 존재
    이유다."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    rows = await list_channel_connections(db, org_id=org_id)
    return [_to_agent_visible_item(r) for r in rows]


class AvailableChannelItem(BaseModel):
    """story f30da19a(AC1, 페드루 PO 확定 2026-09-04) — 「연결 만들기」 버튼이 FE에서
    하드코딩/env 분기 없이 그릴 수 있게 `CHANNEL_ADAPTERS` 레지스트리를 그대로 노출.
    sandbox는 그 레지스트리 자체가 `SANDBOX_CHANNEL_ENABLED`일 때만 항목을 갖고 있어
    (channel_adapters.py 상단 조건부 등재) prod에서는 자동으로 빠진다 — 이 엔드포인트에
    별도 필터링 로직이 없다.

    페드루 리뷰 B2(2026-09-04) — 원래 AC의 `oauth: bool`을 `credential_kind: str`
    그대로 노출으로 정정. `bool`이면 "oauth vs 그 외"만 구별되는데, 미래에
    `credential_kind="pasted_secret"`인 채널이 추가되면 그것도 `oauth=false`가 돼
    FE가 sandbox와 같은 BFF POST 분기(§경계 AC2)로 잘못 보낸다 — "oauth|pasted_secret|
    none" 3값 자체가 FE 분기의 SSOT라 값을 지어내지 않고 그대로 넘긴다."""
    channel: str
    display_name: str
    credential_kind: str
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — "social"(짧은 글·
    # channel_post) vs "blog"(site_post) 구분. FE가 "채널 연결" 화면과 "블로그 목적지"
    # 화면을 이 값 하나로 분기한다(additive — 기존 필드 무변경).
    kind: str


@router.get(
    "/{org_id}/channel-connections/available-channels", response_model=list[AvailableChannelItem],
)
async def list_available_channels_endpoint(
    org_id: uuid.UUID,
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[AvailableChannelItem]:
    """story f30da19a(AC1) — 목록 엔드포인트(`agent-visible`)와 동형: `_require_human()`을
    안 부른다(org 멤버면 에이전트도 조회 가능 — 이 응답엔 토큰 인접 필드가 아예 없어
    AC6의 human-only 근거가 적용되지 않는다). DB 조회 0 — 레지스트리 자체가 SSOT라
    org마다 다른 값이 없다(org_id는 스코프 검증에만 쓴다).

    story e4fc29fa(페드루 PO 리뷰 B1, 2026-09-04) — 이 목록은 "연결 만들기" 버튼 대상
    이다(엔드포인트 자체 목적, f30da19a AC1). `requires_connection=False`인 채널
    (hosted_site — 연결 없이 항상 사용 가능)은 목록에서 뺀다 — 안 그러면 FE(#3435
    AC2)가 credential_kind="none"만 보고 「샌드박스 연결 만들기」 분기를 잘못 탄다."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    return [
        AvailableChannelItem(
            channel=channel, display_name=cfg.display_name, credential_kind=cfg.credential_kind,
            kind=cfg.kind,
        )
        for channel, cfg in CHANNEL_ADAPTERS.items()
        if cfg.requires_connection
    ]


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

    # 선생님 지적·페드루 PO 정정(2026-09-03 08:29Z) — 조직이 자기 채널 앱 자격을 등록 안
    # 했으면(플랫폼 기본값도 없으면) authorize 진입 자체를 여기서 막는다. Meta 호출 0건.
    app_credentials = await resolve_app_credentials(db, org_id=org_id, channel=channel)
    if app_credentials is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "CHANNEL_APP_CREDENTIALS_MISSING",
                "message": "이 조직에 등록된 채널 앱 자격이 없습니다. 먼저 앱 자격을 등록해주세요.",
            },
        )
    app_id, _app_secret = app_credentials
    del _app_secret  # authorize엔 app_id만 필요 — secret은 여기서 즉시 폐기(콜백 단계에서 다시 조회).

    code_verifier, code_challenge = generate_pkce_pair()
    try:
        state = sign_channel_oauth_state(
            org_id=org_id, requester_member_id=resolved.id, channel=channel, code_verifier=code_verifier,
        )
    except ChannelOAuthStateNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if channel == "threads":
        from app.services.threads_oauth import build_authorize_url
        url = build_authorize_url(
            redirect_uri=_redirect_uri(org_id, channel), state=state, code_challenge=code_challenge, app_id=app_id,
        )
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

    # authorize 단계와 별도로 다시 조회 — 콜백은 브라우저 왕복(수초~수분) 뒤라 그 사이 owner가
    # 자격을 바꿨을 수 있고, authorize에서 app_secret을 굳이 이 함수 스코프까지 들고 있지
    # 않게 한 설계(위 authorize 참고)의 자연스러운 대응.
    app_credentials = await resolve_app_credentials(db, org_id=org_id, channel=channel)
    if app_credentials is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "CHANNEL_APP_CREDENTIALS_MISSING",
                "message": "이 조직에 등록된 채널 앱 자격이 없습니다. 먼저 앱 자격을 등록해주세요.",
            },
        )
    app_id, app_secret = app_credentials

    from app.services.threads_oauth import exchange_code_for_short_lived_token, exchange_for_long_lived_token, test_connection

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            short_lived_token, external_account_id = await exchange_code_for_short_lived_token(
                client, code=body.code, redirect_uri=_redirect_uri(org_id, channel),
                code_verifier=oauth_state.code_verifier, app_id=app_id, app_secret=app_secret,
            )
            long_lived_token, expires_in = await exchange_for_long_lived_token(
                client, short_lived_token=short_lived_token, app_secret=app_secret,
            )
            account = await test_connection(client, access_token=long_lived_token)
        except ThreadsOAuthError as exc:
            raise HTTPException(status_code=400, detail={"code": exc.code, "message": exc.message}) from exc
        finally:
            del app_secret  # ⛔즉시 소비 후 폐기 — 더 들고 있지 않는다.

    row = await upsert_channel_connection(
        db, org_id=org_id, channel=channel, account_id=external_account_id,
        account_label=account.get("username"), credential_kind=adapter.credential_kind,
        access_token=long_lived_token, refresh_token=None,
        token_expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
        refresh_mode=adapter.refresh_mode, scopes=adapter.scope.split(","), connected_by=resolved.id,
    )
    return _to_response(row)


@router.post("/{org_id}/channel-connections/sandbox", response_model=ChannelConnectionResponse, status_code=201)
async def create_sandbox_channel_connection(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ChannelConnectionResponse:
    """story 5b27b32f(AC2) — OAuth 없는 샌드박스 연결 생성. dev org에 실 Meta 자격이
    없어(채널 연결 0건) 발행 명령·cron tick·cancel·unpublish·429·컨테이너 폴링 경로를
    dev에서 라이브로 못 밟던 병목을 푼다. `upsert_channel_connection`(story #3373 AC8
    기존 함수, 신규 로직 0)을 그대로 재사용 — 같은 (org, "sandbox", account_id) 재호출은
    새 행이 아니라 기존 행 갱신(멱등, 실 OAuth 콜백과 동일 계약).

    이 채널 자체가 `SANDBOX_CHANNEL_ENABLED=true`일 때만 CHANNEL_ADAPTERS에 등재되므로
    (channel_adapters.py) prod에선 이 엔드포인트를 호출해도 404(어댑터 없음)로 막힌다 —
    라우트 자체를 조건부로 등록하지 않는 이유는 fail-closed 축을 어댑터 레지스트리 하나로
    모으기 위함(AC5의 기동 시점 가드와 같은 SSOT)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner_or_admin(db, auth, org_id)

    adapter = get_channel_adapter("sandbox")
    if adapter is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "CHANNEL_SANDBOX_DISABLED",
                "message": "이 환경에서 샌드박스 채널이 비활성화돼 있습니다(SANDBOX_CHANNEL_ENABLED).",
            },
        )

    row = await upsert_channel_connection(
        db, org_id=org_id, channel="sandbox", account_id=f"sandbox-{org_id}",
        account_label="Sandbox", credential_kind=adapter.credential_kind,
        access_token="sandbox-dummy-access-token", refresh_token=None,
        token_expires_at=None, refresh_mode=adapter.refresh_mode,
        scopes=adapter.scope.split(","), connected_by=resolved.id,
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


@router.put("/{org_id}/channel-connections/{channel}/app-credentials", response_model=AppCredentialsPutResponse)
async def set_channel_app_credentials(
    org_id: uuid.UUID,
    channel: str,
    body: AppCredentialsRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> AppCredentialsPutResponse:
    """선생님 지적·페드루 PO 정정(2026-09-03 08:29Z) — 조직별 채널 앱(Meta 등) 자격 등록.
    owner 전용(에이전트는 _require_owner→_require_human 체인에서 403). 응답에 secret은
    절대 안 실린다(AppCredentialsPutResponse에 필드 자체가 없음)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner(db, auth, org_id)
    row = await upsert_channel_app_credentials(
        db, org_id=org_id, channel=channel, app_id=body.app_id, app_secret=body.app_secret, updated_by=resolved.id,
    )
    return AppCredentialsPutResponse(configured=True, app_id=row.app_id)


@router.get("/{org_id}/channel-connections/{channel}/app-credentials", response_model=AppCredentialsStatusResponse)
async def get_channel_app_credentials_status(
    org_id: uuid.UUID,
    channel: str,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> AppCredentialsStatusResponse:
    """유나 «설정 미완» 상태의 서버 근거(페드루 PO 2026-09-03 08:29Z) — member 이상이면 조회
    가능(list_channel_connections_endpoint와 동일 tier — 응답에 secret·app_id 전체 어느
    것도 없다, 끝 4자리뿐이라 비밀 노출 0)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_human(db, auth, org_id)
    row = await get_channel_app_credentials(db, org_id=org_id, channel=channel)
    effective_source = await resolve_app_credentials_source(db, org_id=org_id, channel=channel)
    if row is None:
        return AppCredentialsStatusResponse(configured=False, effective_source=effective_source)
    return AppCredentialsStatusResponse(
        configured=True, app_id_suffix=_app_id_suffix(row.app_id),
        updated_by=row.updated_by, updated_at=row.updated_at.isoformat(),
        effective_source=effective_source,
    )


class PublishingLimitResponse(BaseModel):
    quota_usage: int
    quota_total: int
    quota_duration_seconds: int


@router.get(
    "/{org_id}/channel-connections/{connection_id}/publishing-limit", response_model=PublishingLimitResponse,
)
async def get_channel_publishing_limit(
    org_id: uuid.UUID,
    connection_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> PublishingLimitResponse:
    """story #f8f7cb0f(Phase1·마케팅운영) — 발행 한도 잔량(UI 표시용, provider 실조회).
    휴먼 전용(test_channel_connection과 동형 — member 이상이면 충분, owner 제한 없음).
    발행 직전 서버 내부 재조회(channel_posts.publish_channel_post_draft)와 같은 함수
    (threads_publish.get_publishing_limit)를 쓴다 — 단일 조회 경로."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_human(db, auth, org_id)

    row = await get_channel_connection(db, org_id=org_id, connection_id=connection_id)
    if row is None:
        raise HTTPException(status_code=404, detail="channel connection not found")

    access_token = decrypt_for_use(row)
    if access_token is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "CHANNEL_CONNECTION_NOT_ACTIVE", "message": "연결에 저장된 토큰이 없습니다."},
        )

    from app.services.channel_adapters import get_publish_client_module
    from app.services.threads_publish import ThreadsPublishError

    # story 5b27b32f — sandbox 연결이면 sandbox_publish로 우회(publish 경로와 동일 디스패치).
    get_publishing_limit = get_publish_client_module(row.channel).get_publishing_limit

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                quota_usage, quota_total, quota_duration = await get_publishing_limit(
                    client, access_token=access_token, threads_user_id=row.account_id,
                )
            except ThreadsPublishError as exc:
                if exc.status_code in (401, 403):
                    await apply_refresh_failure(db, connection=row, error_message=exc.message)
                    raise HTTPException(
                        status_code=409,
                        detail={"code": "CHANNEL_TOKEN_EXPIRED", "message": exc.message},
                    ) from exc
                raise HTTPException(
                    status_code=502,
                    detail={"code": "CHANNEL_PUBLISH_PROVIDER_ERROR", "message": exc.message},
                ) from exc
    finally:
        del access_token  # ⛔즉시 소비 후 폐기 — test_channel_connection과 동일 관례.

    return PublishingLimitResponse(
        quota_usage=quota_usage, quota_total=quota_total, quota_duration_seconds=quota_duration,
    )
