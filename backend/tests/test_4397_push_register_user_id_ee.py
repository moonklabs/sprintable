"""story #4397 — registration stores the person behind the caller (the router wiring; the repository side is in the realdb file)."""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.schemas.push_device import RegisterPushDevice
from ee.routers import push_devices as pd


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_register_hands_the_person_to_the_upsert():
    repo = AsyncMock()
    member, person = uuid.uuid4(), uuid.uuid4()
    repo.upsert.return_value = SimpleNamespace(
        id=uuid.uuid4(), org_id=uuid.uuid4(), member_id=member, expo_push_token="ExponentPushToken[a]", apns_device_token=None,
        platform="android", device_id=None, app_version=None, is_active=True, created_at=None, last_seen_at=None,
    )
    body = RegisterPushDevice(expo_push_token="ExponentPushToken[a]", platform="android")
    with patch.object(pd.PushDeviceResponse, "model_validate", side_effect=lambda d: d):
        await pd.register_push_device(body, repo=repo, caller_member_id=member, caller_user_id=person, _ee=None)
    assert repo.upsert.await_args.kwargs["user_id"] == person
    assert repo.upsert.await_args.kwargs["member_id"] == member


@pytest.mark.anyio
@pytest.mark.parametrize(("resolved_user", "expected"), [(uuid.UUID(int=7), uuid.UUID(int=7)), (None, None)])
async def test_caller_user_id_is_the_resolved_person_and_none_for_an_agent(resolved_user, expected):
    resolved = SimpleNamespace(id=uuid.uuid4(), user_id=resolved_user)
    with patch("app.services.member_resolver.resolve_member", AsyncMock(return_value=resolved)):
        got = await pd._get_caller_user_id(auth=object(), org_id=uuid.uuid4(), session=object())
    assert got == expected
