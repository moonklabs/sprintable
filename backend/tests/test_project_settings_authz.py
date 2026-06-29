"""E-MEMBER-POLICY(9b8d634b): project_settings authz — 직전 authz 0(보안 갭) 차단.

PATCH(설정 변경) = project owner/admin(has_project_role min='admin'·org floor 포함). GET(열람) = project
member(has_project_access·테넌시). 둘 다 미통과 시 403. (모델/owner 1급은 S1~S4서 이미 구축·여기선 설정 authz 배선.)
"""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.routers import project_settings as ps


def _auth():
    a = MagicMock()
    a.user_id = str(uuid.uuid4())
    return a


@pytest.mark.anyio
async def test_patch_settings_requires_owner_admin():
    body = MagicMock()
    body.project_id = uuid.uuid4()
    body.standup_deadline = "09:00"
    # 비-owner/admin → 403 (직전엔 authz 0 으로 누구나 변경 가능했던 갭).
    with patch.object(ps, "has_project_role", new_callable=AsyncMock, return_value=False):
        with pytest.raises(HTTPException) as e:
            await ps.upsert_project_settings(body=body, session=AsyncMock(), auth=_auth())
        assert e.value.status_code == 403


@pytest.mark.anyio
async def test_patch_settings_checks_admin_min_role():
    body = MagicMock()
    body.project_id = uuid.uuid4()
    body.standup_deadline = "09:00"
    # owner/admin 통과 시 authz 호출이 min_role='admin' 인지(레벨 정합). session 은 authz 後 차단해 호출인자만 확認.
    mock_hpr = AsyncMock(return_value=True)
    sess = AsyncMock()
    sess.execute = AsyncMock(side_effect=RuntimeError("past-authz"))  # authz 통과 후 도달 증명
    with patch.object(ps, "has_project_role", mock_hpr):
        with pytest.raises(RuntimeError, match="past-authz"):
            await ps.upsert_project_settings(body=body, session=sess, auth=_auth())
    assert mock_hpr.await_args.kwargs.get("min_role") == "admin"


# GET(읽기·standup_deadline)은 저민감이라 authed user 면 허용(기존 동작 유지)·write(PATCH)만 게이트.
