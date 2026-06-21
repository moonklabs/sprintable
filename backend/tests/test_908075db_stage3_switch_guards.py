"""908075db 단계3: switch_project/switch_org override 밴드에이드 가드 gate(flag-off-only).

flag-on(de-fallback SSOT): 가드 skip → kept 코드(capture/last_project_id) + de-fallback이 project_id·
last_project_id 를 ⭐**둘 다** target 으로 커버(가드 없이도 정합). flag-off(prod): 가드 유지 → wrong
de-fallback 결과를 target 으로 보정(무회귀). 둘 다 결과 동일(target) = parity.
"""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers.auth import SwitchProjectRequest, SwitchOrganizationRequest, switch_project, switch_organization

ORG = uuid.uuid4()
USER = uuid.uuid4()
TARGET = uuid.uuid4()
WRONG = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _user():
    u = MagicMock()
    u.id = USER
    u.email = "e@test.com"
    u.last_project_id = None
    u.last_org_id = ORG
    return u


def _auth():
    a = MagicMock()
    a.user_id = str(USER)
    return a


async def _run_switch_project(flag: bool, defallback_pid):
    """switch_project 호출 → (token app_metadata, user.last_project_id) 반환."""
    user = _user()
    session = AsyncMock()
    captured = {}

    def _ct(uid, email=None, app_metadata=None):
        captured["md"] = dict(app_metadata or {})
        return {"access_token": "a", "refresh_token": "r"}

    md = {"org_id": str(ORG), "project_id": (str(defallback_pid) if defallback_pid else None),
          "role": "member", "projects": []}
    with patch("app.routers.auth.settings.build_app_metadata_defallback", flag), \
         patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)), \
         patch("app.routers.auth.has_project_access", new=AsyncMock(return_value=True)), \
         patch("app.routers.auth._build_app_metadata", new=AsyncMock(return_value=md)), \
         patch("app.routers.auth.create_tokens", _ct), \
         patch("app.routers.auth.create_refresh_token", return_value=("rt", None)), \
         patch("app.routers.auth._store_refresh_token", new=AsyncMock()):
        await switch_project(SwitchProjectRequest(project_id=TARGET), session, _auth())
    return captured["md"], user.last_project_id


@pytest.mark.anyio
async def test_switch_project_flag_on_covers_both_without_guard():
    """⭐flag-on: 가드 skip 이어도 project_id + last_project_id 둘 다 target(de-fallback=target)."""
    md, last_pid = await _run_switch_project(flag=True, defallback_pid=TARGET)
    assert md["project_id"] == str(TARGET)   # ⓐ de-fallback 이 target 존중
    assert last_pid == TARGET                # ⓑ kept 1229 last_project_id=target


@pytest.mark.anyio
async def test_switch_project_flag_off_guard_corrects_wrong():
    """flag-off(prod): de-fallback 이 wrong 줘도 가드가 target 으로 보정(무회귀)."""
    md, last_pid = await _run_switch_project(flag=False, defallback_pid=WRONG)
    assert md["project_id"] == str(TARGET)   # 가드 override → target
    assert last_pid == TARGET                # 가드 재설정 → target


async def _run_switch_org(flag: bool, first_accessible, defallback_pid):
    """switch_organization 호출 → (token app_metadata, user.last_project_id)."""
    user = _user()
    session = AsyncMock()
    # org_members membership = exists, first_accessible_project_id = first_accessible
    mem = MagicMock()
    mem.scalar_one_or_none.return_value = 1
    session.execute = AsyncMock(return_value=mem)
    captured = {}

    def _ct(uid, email=None, app_metadata=None):
        captured["md"] = dict(app_metadata or {})
        return {"access_token": "a", "refresh_token": "r"}

    md = {"org_id": str(ORG), "role": "member", "projects": []}
    if defallback_pid:
        md["project_id"] = str(defallback_pid)
    with patch("app.routers.auth.settings.build_app_metadata_defallback", flag), \
         patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)), \
         patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=first_accessible)), \
         patch("app.routers.auth._build_app_metadata", new=AsyncMock(return_value=md)), \
         patch("app.routers.auth.create_tokens", _ct), \
         patch("app.routers.auth.create_refresh_token", return_value=("rt", None)), \
         patch("app.routers.auth._store_refresh_token", new=AsyncMock()):
        await switch_organization(SwitchOrganizationRequest(org_id=ORG), session, _auth())
    return captured["md"], user.last_project_id


@pytest.mark.anyio
async def test_switch_org_flag_on_covers_target_without_guard():
    """⭐flag-on: 가드 skip 이어도 project_id(first_accessible) + last_project_id 둘 다 정합."""
    md, last_pid = await _run_switch_org(flag=True, first_accessible=TARGET, defallback_pid=TARGET)
    assert md["project_id"] == str(TARGET) and last_pid == TARGET


@pytest.mark.anyio
async def test_switch_org_flag_on_zero_project_org_null():
    """⭐flag-on 0-project org(first_accessible None): de-fallback 도 project 없음 → md project 없음·
    last_project_id None(가드 pop/null 없이도 정합)."""
    md, last_pid = await _run_switch_org(flag=True, first_accessible=None, defallback_pid=None)
    assert md.get("project_id") in (None, "") and last_pid is None


@pytest.mark.anyio
async def test_switch_org_flag_off_guard_corrects():
    """flag-off(prod): de-fallback wrong → 가드가 캡처 target 으로 재확정(무회귀)."""
    md, last_pid = await _run_switch_org(flag=False, first_accessible=TARGET, defallback_pid=WRONG)
    assert md["project_id"] == str(TARGET) and last_pid == TARGET
