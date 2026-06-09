"""② verification email silent-fail 가시화: send_email 미발송(콘솔 폴백/예외)을 삼키지 않는다.

register/resend 모두 send_email의 bool 반환을 사용 — 콘솔 폴백(False)이면 "sent"로 거짓 보고하지
않고 로깅 + 정확한 응답. (register는 가입 자체는 완료하되 실패를 로깅.)
"""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.anyio
async def test_resend_verification_reports_undelivered_not_sent(
    test_client, mock_session, auth_ctx, monkeypatch
):
    from app.models.user import User
    import app.routers.auth as auth_mod

    user = MagicMock(spec=User)
    user.id = uuid.UUID(auth_ctx.user_id)
    user.email = "test@example.com"
    user.email_verified = False
    res = MagicMock()
    res.scalar_one_or_none.return_value = user
    mock_session.execute = AsyncMock(return_value=res)

    # send_email은 함수 내부에서 import → 모듈 attr 패치로 가로챈다. False=콘솔 폴백(미발송).
    monkeypatch.setattr("app.services.email.send_email", lambda **kw: False)
    monkeypatch.setattr(auth_mod, "create_email_verification_token", lambda uid: "tok")

    resp = await test_client.post("/api/v2/auth/resend-verification")
    assert resp.status_code == 200
    body = resp.json()
    flat = str(body)
    # 거짓 "sent"가 아니라 미발송을 정확히 반영
    assert "could not be delivered" in flat or '"delivered": false' in flat.lower() or "delivered': False" in flat


@pytest.mark.anyio
async def test_resend_verification_reports_sent_when_delivered(
    test_client, mock_session, auth_ctx, monkeypatch
):
    from app.models.user import User
    import app.routers.auth as auth_mod

    user = MagicMock(spec=User)
    user.id = uuid.UUID(auth_ctx.user_id)
    user.email = "test@example.com"
    user.email_verified = False
    res = MagicMock()
    res.scalar_one_or_none.return_value = user
    mock_session.execute = AsyncMock(return_value=res)

    monkeypatch.setattr("app.services.email.send_email", lambda **kw: True)  # 실발송
    monkeypatch.setattr(auth_mod, "create_email_verification_token", lambda uid: "tok")

    resp = await test_client.post("/api/v2/auth/resend-verification")
    assert resp.status_code == 200
    assert "sent" in str(resp.json())
