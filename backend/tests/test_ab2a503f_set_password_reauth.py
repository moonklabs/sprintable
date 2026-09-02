"""story #ab2a503f([버그·보안·HIGH] set-password가 재인증 0으로 탈취 세션/API키에 비밀번호를
심는다 — 2FA 해제 우회 체인의 STEP1·계정탈취 발판). 설계 doc(deecc92c) §③ pin 계획 그대로.

구 POST /set-password(get_current_user만 요구, 재인증 0)를 완전히 제거하고 이메일 확인
링크 2단계(request→confirm)로 대체했다 — "지금 이 순간의 사람"이 링크를 클릭해야만 실제
DB write(confirm)가 일어난다. API키 경로(hu_live_*·sk_live_* 둘 다)는 request 단계에서
무조건 403 — 이메일 링크는 API키 세션과 무관하게 브라우저에서 별도로 완결되므로 API키가
"인증 강도"에 아무 기여를 안 한다(설계 doc §④)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import jwt
import pytest


def _make_user(*, hashed_password: str = "", locale: str = "ko") -> MagicMock:
    from app.models.user import User

    user = MagicMock(spec=User)
    user.id = uuid.uuid4()
    user.email = "oauth-user@example.com"
    user.hashed_password = hashed_password
    user.locale = locale
    return user


def _refresh_token_update_calls(mock_session: AsyncMock):
    return [
        c.args[0] for c in mock_session.execute.call_args_list
        if hasattr(c.args[0], "table") and c.args[0].table.name == "refresh_tokens"
    ]


def _user_update_calls(mock_session: AsyncMock):
    return [
        c.args[0] for c in mock_session.execute.call_args_list
        if hasattr(c.args[0], "table") and c.args[0].table.name == "users"
    ]


# ── ⭐핵심 RED→GREEN pin — 구 엔드포인트 완전 제거 ──────────────────────────────


@pytest.mark.anyio
async def test_old_set_password_endpoint_no_longer_exists(test_client):
    """구 POST /api/v2/auth/set-password(재인증 0으로 즉시 write하던 그 경로)가 완전히
    사라졌는지 — 라우트 자체가 없어야 한다(404). 이 코드베이스를 이 pin 도입 「이전」
    커밋으로 되돌리면 200이 나 즉시 RED가 되는 것이 이 스토리의 존재 이유."""
    resp = await test_client.post("/api/v2/auth/set-password", json={"new_password": "NewP@ssw0rd1"})
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_request_does_not_immediately_write_password(test_client, mock_session, auth_ctx, monkeypatch):
    """⭐핵심 pin — /set-password/request가 200을 반환해도 hashed_password가 그 자리에서
    즉시 안 바뀐다(= confirm 없이는 비번이 안 심긴다). request가 하는 유일한 DB 관찰가능
    변화는 없음(이메일 발송뿐) — users 테이블 UPDATE 자체가 0건이어야 한다."""
    user = _make_user(hashed_password="")
    monkeypatch.setattr("app.routers.auth._get_user_by_id", AsyncMock(return_value=user))
    monkeypatch.setattr("app.services.email.send_email", lambda **kw: True)

    resp = await test_client.post("/api/v2/auth/set-password/request", json={"new_password": "NewP@ssw0rd1"})
    assert resp.status_code == 200
    assert resp.json()["data"]["delivered"] is True
    assert _user_update_calls(mock_session) == [], "request 단계에서 users 테이블이 이미 갱신됨 — 재인증 우회"


# ── confirm — 양성대조 + refresh revoke ────────────────────────────────────────


@pytest.mark.anyio
async def test_confirm_with_valid_token_sets_password_and_revokes_refresh_tokens(test_client, mock_session, monkeypatch):
    """confirm이 실제 write 지점이다(양성대조) — hashed_password가 토큰에 실린 해시로
    채워지고, password_set_at도 채워진다. 그리고 확認 성공 시 해당 user의 활성
    RefreshToken 전량이 revoked_at 채워진다(탈취 refresh token으로 이후 /auth/refresh가
    401 — #3247 우회체인의 「+61초 iat」 재현이 이제 막힌다)."""
    from app.core.security import create_set_password_confirm_token, hash_password

    user = _make_user(hashed_password="")
    monkeypatch.setattr("app.routers.auth._get_user_by_id", AsyncMock(return_value=user))

    new_hash = hash_password("NewP@ssw0rd1")
    token = create_set_password_confirm_token(str(user.id), new_hash)

    resp = await test_client.get(f"/api/v2/auth/set-password/confirm?token={token}")
    assert resp.status_code == 200

    user_updates = _user_update_calls(mock_session)
    assert len(user_updates) == 1
    values = user_updates[0].compile().params
    assert values["hashed_password"] == new_hash
    assert values["password_set_at"] is not None

    refresh_updates = _refresh_token_update_calls(mock_session)
    assert len(refresh_updates) == 1, "confirm 성공 시 refresh token 전량 revoke가 실행되지 않음"
    refresh_values = refresh_updates[0].compile().params
    assert refresh_values["revoked_at"] is not None

    mock_session.commit.assert_awaited()


@pytest.mark.anyio
async def test_confirm_with_expired_token_400(test_client, mock_session):
    """만료된 토큰(15분 초과) → 400. exp를 과거로 직접 서명(freeze_time 없이 동등 효과)."""
    from app.core.security import _get_secret

    user_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    expired_payload = {
        "sub": user_id, "type": "set_password_confirm", "new_password_hash": "x",
        "iat": int((now - timedelta(minutes=20)).timestamp()),
        "exp": int((now - timedelta(minutes=5)).timestamp()),
    }
    token = jwt.encode(expired_payload, _get_secret(), algorithm="HS256")

    resp = await test_client.get(f"/api/v2/auth/set-password/confirm?token={token}")
    assert resp.status_code == 400
    assert _user_update_calls(mock_session) == []


@pytest.mark.anyio
async def test_confirm_with_wrong_purpose_token_rejected(test_client, mock_session):
    """교차토큰 방어(#3279/#3140 관례 재사용) — email_verification용으로 서명된 토큰을
    set-password/confirm에 흘려도 거부돼야 한다(type 불일치)."""
    from app.core.security import create_email_verification_token

    token = create_email_verification_token(str(uuid.uuid4()))
    resp = await test_client.get(f"/api/v2/auth/set-password/confirm?token={token}")
    assert resp.status_code == 400
    assert _user_update_calls(mock_session) == []


@pytest.mark.anyio
async def test_confirm_toctou_rejected_when_password_already_set(test_client, mock_session, monkeypatch):
    """TOCTOU fail-closed — 토큰 발급 후 15분 사이 다른 경로로 이미 비밀번호가 생겼으면
    confirm이 거부한다(재확인 없이 덮어쓰지 않음)."""
    from app.core.security import create_set_password_confirm_token

    user = _make_user(hashed_password="already-has-one")
    monkeypatch.setattr("app.routers.auth._get_user_by_id", AsyncMock(return_value=user))
    token = create_set_password_confirm_token(str(user.id), "irrelevant-hash")

    resp = await test_client.get(f"/api/v2/auth/set-password/confirm?token={token}")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "ALREADY_HAS_PASSWORD"
    assert _user_update_calls(mock_session) == []


# ── API키 경로 거부 pin(설계 doc §④) ────────────────────────────────────────────


@pytest.mark.anyio
async def test_request_rejects_agent_api_key(test_client, mock_session, auth_ctx, monkeypatch):
    """sk_live_*(에이전트 API키) 기원 호출 → 403, hashed_password 불변."""
    auth_ctx.claims = {"app_metadata": {"api_key_id": str(uuid.uuid4())}}
    user = _make_user(hashed_password="")
    monkeypatch.setattr("app.routers.auth._get_user_by_id", AsyncMock(return_value=user))

    resp = await test_client.post("/api/v2/auth/set-password/request", json={"new_password": "NewP@ssw0rd1"})
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "REQUIRES_INTERACTIVE_SESSION"
    assert _user_update_calls(mock_session) == []


@pytest.mark.anyio
async def test_request_rejects_human_personal_api_key(test_client, mock_session, auth_ctx, monkeypatch):
    """⭐hu_live_*(휴먼 개인 API키) 기원 호출도 예외 없이 403 — is_au_billable_agent류
    과금 판별자를 그대로 갖다 썼다면 이 케이스가 통과(actor_type=="human"이라 놓침)했을
    것이다(그라운딩 중 실제로 발견한 함정, app/dependencies/auth.py _resolve_human_api_key
    참고 — human_api_key_id는 api_key_id와 다른 claim 키에 실린다)."""
    auth_ctx.claims = {"app_metadata": {"human_api_key_id": str(uuid.uuid4()), "actor_type": "human"}}
    user = _make_user(hashed_password="")
    monkeypatch.setattr("app.routers.auth._get_user_by_id", AsyncMock(return_value=user))

    resp = await test_client.post("/api/v2/auth/set-password/request", json={"new_password": "NewP@ssw0rd1"})
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "REQUIRES_INTERACTIVE_SESSION"
    assert _user_update_calls(mock_session) == []


@pytest.mark.anyio
async def test_request_allows_normal_browser_session(test_client, mock_session, auth_ctx, monkeypatch):
    """양성대조 — api_key_id도 human_api_key_id도 없는 정상 JWT 브라우저 세션(auth_ctx 기본값)
    은 여전히 통과한다(회귀 0)."""
    user = _make_user(hashed_password="")
    monkeypatch.setattr("app.routers.auth._get_user_by_id", AsyncMock(return_value=user))
    monkeypatch.setattr("app.services.email.send_email", lambda **kw: True)

    resp = await test_client.post("/api/v2/auth/set-password/request", json={"new_password": "NewP@ssw0rd1"})
    assert resp.status_code == 200


# ── 회귀 — 기존 게이트 유지 ──────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_request_when_already_has_password_400(test_client, mock_session, auth_ctx, monkeypatch):
    """hashed_password != ""(이미 비번 있는 계정) → 기존 ALREADY_HAS_PASSWORD(400) 그대로."""
    user = _make_user(hashed_password="already-set")
    monkeypatch.setattr("app.routers.auth._get_user_by_id", AsyncMock(return_value=user))

    resp = await test_client.post("/api/v2/auth/set-password/request", json={"new_password": "NewP@ssw0rd1"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "ALREADY_HAS_PASSWORD"


# ── rate limit 배선(#2444 관례 — 실제 429는 test_2444가 이미 그 메커니즘을 pin) ──────


def test_request_route_uses_isolated_resend_verification_limiter():
    """request_set_password가 공유 limiter가 아니라 격리된 resend_verification_limiter를
    참조하는지 — test_2444_resend_verification_rate_limit_redis.py와 동형 검증(런타임 배선
    증명, 문자열 grep 아님). 실제 3/hour 강제 자체는 그 파일이 이미 pin(이 스토리는 «내
    라우트가 그 메커니즘에 실제로 연결됐는지»만 본다)."""
    from app.core.rate_limit import limiter, resend_verification_limiter
    from app.routers.auth import request_set_password

    name = f"{request_set_password.__module__}.{request_set_password.__name__}"
    assert name in resend_verification_limiter._route_limits
    assert name not in limiter._route_limits
