"""story #3159 — activation 라우터 유닛(checklist/unsubscribe). SQL 실측은
test_3159_onboarding_activation_realdb.py — 여기는 엔드포인트 분기(401/404/422 형태)만."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from jose import JWTError

from app.core.security import create_email_unsubscribe_token, decode_email_unsubscribe_token
from app.routers.activation import get_checklist, get_unsubscribe


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── 토큰 유틸리티(email_verification token과 동형, test_auth_email_verification.py 참조) ──

def test_unsubscribe_token_roundtrip():
    uid = str(uuid.uuid4())
    token = create_email_unsubscribe_token(uid)
    payload = decode_email_unsubscribe_token(token)
    assert payload["sub"] == uid
    assert payload["type"] == "email_unsubscribe"


def test_unsubscribe_token_wrong_type_rejected():
    from app.core.security import _get_secret
    from jose import jwt
    from datetime import datetime, timezone, timedelta
    payload = {"sub": str(uuid.uuid4()), "type": "access", "exp": int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp())}
    token = jwt.encode(payload, _get_secret(), algorithm="HS256")
    with pytest.raises(JWTError):
        decode_email_unsubscribe_token(token)


@pytest.mark.anyio
async def test_get_checklist_404_when_user_missing():
    db = AsyncMock()
    db.get = AsyncMock(return_value=None)
    auth = type("A", (), {"user_id": str(uuid.uuid4())})()
    with pytest.raises(HTTPException) as ei:
        await get_checklist(db=db, auth=auth)
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_get_checklist_returns_state():
    db = AsyncMock()
    user = object()
    db.get = AsyncMock(return_value=user)
    auth = type("A", (), {"user_id": str(uuid.uuid4())})()
    state = {"steps": {}, "completed": 3, "total": 5, "all_complete": False}
    with patch("app.routers.activation.get_activation_state", AsyncMock(return_value=state)):
        res = await get_checklist(db=db, auth=auth)
    assert res.status_code == 200


@pytest.mark.anyio
async def test_get_unsubscribe_invalid_token_400():
    db = AsyncMock()
    with patch("app.routers.activation.decode_email_unsubscribe_token", side_effect=JWTError("bad")):
        res = await get_unsubscribe(token="bogus", db=db)
    assert res.status_code == 400


@pytest.mark.anyio
async def test_get_unsubscribe_not_found_404():
    db = AsyncMock()
    uid = str(uuid.uuid4())
    with patch("app.routers.activation.decode_email_unsubscribe_token", return_value={"sub": uid}), \
         patch("app.routers.activation.unsubscribe_user", AsyncMock(return_value=False)):
        res = await get_unsubscribe(token="tok", db=db)
    assert res.status_code == 404


@pytest.mark.anyio
async def test_get_unsubscribe_success_200():
    db = AsyncMock()
    uid = str(uuid.uuid4())
    with patch("app.routers.activation.decode_email_unsubscribe_token", return_value={"sub": uid}), \
         patch("app.routers.activation.unsubscribe_user", AsyncMock(return_value=True)):
        res = await get_unsubscribe(token="tok", db=db)
    assert res.status_code == 200
