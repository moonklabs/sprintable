"""S1 (org-level 멀티프로젝트 에이전트): _resolve_api_key 가 단일 project 핀이 아니라
grant SSOT 기반 project_ids[] 집합을 claim 에 싣는지 검증.

- 단일 프로젝트 에이전트: project_ids=[p], project_id=p (back-compat, 거동 동일).
- 멀티 프로젝트 에이전트: project_ids=[p1,p2,...], project_id=기본(첫) — team_members 뷰 N행
  (멀티프로젝트)에서도 MultipleResultsFound 크래시 없이 해소.
- 양 경로(flag off/on) 모두 project_ids 동일 산출 → 생명선 parity 보존.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG = uuid.uuid4()
MEMBER = uuid.uuid4()
P1 = uuid.uuid4()
P2 = uuid.uuid4()
APIKEY_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _api_key_obj():
    k = MagicMock()
    k.revoked_at = None
    k.expires_at = None
    k.last_used_at = None
    k.scope = ["read", "write"]
    k.id = APIKEY_ID
    k.member_id = MEMBER
    k.team_member_id = MEMBER
    return k


def _ak_result():
    r = MagicMock()
    r.scalar_one_or_none.return_value = _api_key_obj()
    return r


def _tm_result(project_id):
    """레거시 경로: select(TeamMember)...scalars().first()."""
    tm = MagicMock()
    tm.id = MEMBER
    tm.org_id = ORG
    tm.project_id = project_id
    r = MagicMock()
    r.scalars.return_value.first.return_value = tm
    return r


def _member_result():
    """anchor 경로: select(Member)...scalar_one_or_none()."""
    m = MagicMock()
    m.id = MEMBER
    m.org_id = ORG
    r = MagicMock()
    r.scalar_one_or_none.return_value = m
    return r


def _profile_result(project_id):
    """anchor 경로: 첫 agent_project_profiles.project_id."""
    r = MagicMock()
    r.scalar_one_or_none.return_value = project_id
    return r


@pytest.mark.anyio
async def test_legacy_multiproject_emits_project_ids_no_crash():
    from app.core import config as _cfg
    from app.dependencies.auth import _resolve_api_key

    _cfg.settings.member_ssot_apikey_cut = False
    try:
        session = MagicMock()
        # 레거시: api_key 조회 → team_member 조회
        session.execute = AsyncMock(side_effect=[_ak_result(), _tm_result(P1)])
        with patch("app.dependencies.auth.hash_token", return_value="h"), patch(
            "app.services.project_auth.accessible_project_ids_in_org",
            new=AsyncMock(return_value=[P1, P2]),
        ):
            ctx = await _resolve_api_key("sk_live_x", session)
        meta = ctx.claims["app_metadata"]
        assert meta["project_ids"] == [str(P1), str(P2)]
        assert meta["project_id"] == str(P1)  # 기본 = 뷰 첫 행
        assert ctx.user_id == str(MEMBER)
    finally:
        _cfg.settings.member_ssot_apikey_cut = False


@pytest.mark.anyio
async def test_anchor_multiproject_emits_project_ids():
    from app.core import config as _cfg
    from app.dependencies.auth import _resolve_api_key

    _cfg.settings.member_ssot_apikey_cut = True
    try:
        session = MagicMock()
        # anchor: api_key 조회 → member 조회 → 첫 profile 조회
        session.execute = AsyncMock(
            side_effect=[_ak_result(), _member_result(), _profile_result(P1)]
        )
        with patch("app.dependencies.auth.hash_token", return_value="h"), patch(
            "app.services.project_auth.accessible_project_ids_in_org",
            new=AsyncMock(return_value=[P1, P2]),
        ):
            ctx = await _resolve_api_key("sk_live_x", session)
        meta = ctx.claims["app_metadata"]
        assert meta["project_ids"] == [str(P1), str(P2)]
        assert meta["project_id"] == str(P1)
    finally:
        _cfg.settings.member_ssot_apikey_cut = False


@pytest.mark.anyio
async def test_single_project_backcompat_legacy():
    """단일 프로젝트 에이전트는 project_ids=[p]·project_id=p 로 기존 거동 유지."""
    from app.core import config as _cfg
    from app.dependencies.auth import _resolve_api_key

    _cfg.settings.member_ssot_apikey_cut = False
    try:
        session = MagicMock()
        session.execute = AsyncMock(side_effect=[_ak_result(), _tm_result(P1)])
        with patch("app.dependencies.auth.hash_token", return_value="h"), patch(
            "app.services.project_auth.accessible_project_ids_in_org",
            new=AsyncMock(return_value=[P1]),
        ):
            ctx = await _resolve_api_key("sk_live_x", session)
        meta = ctx.claims["app_metadata"]
        assert meta["project_ids"] == [str(P1)]
        assert meta["project_id"] == str(P1)
    finally:
        _cfg.settings.member_ssot_apikey_cut = False


@pytest.mark.anyio
async def test_default_project_id_always_in_project_ids_backfill_gap():
    """백필 갭 방어: accessible 가 비어도(grant 누락) 기본 project_id 는 project_ids 에 포함 →
    require_project_access 자기차단 모순 방지."""
    from app.core import config as _cfg
    from app.dependencies.auth import _resolve_api_key

    _cfg.settings.member_ssot_apikey_cut = False
    try:
        session = MagicMock()
        session.execute = AsyncMock(side_effect=[_ak_result(), _tm_result(P1)])
        with patch("app.dependencies.auth.hash_token", return_value="h"), patch(
            "app.services.project_auth.accessible_project_ids_in_org",
            new=AsyncMock(return_value=[]),  # grant 누락 시나리오
        ):
            ctx = await _resolve_api_key("sk_live_x", session)
        meta = ctx.claims["app_metadata"]
        assert meta["project_id"] == str(P1)
        assert meta["project_ids"] == [str(P1)]  # 기본 프로젝트 폴백 포함
    finally:
        _cfg.settings.member_ssot_apikey_cut = False
