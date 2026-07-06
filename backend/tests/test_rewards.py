"""S30 AC: Rewards 라우터 단위 테스트 (8건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
GRANTER_ID = uuid.uuid4()
ENTRY_ID = uuid.uuid4()


def _mock_entry(amount: float = 10.0) -> MagicMock:
    e = MagicMock()
    e.id = ENTRY_ID
    e.org_id = ORG_ID
    e.project_id = PROJECT_ID
    e.member_id = MEMBER_ID
    e.granted_by = GRANTER_ID
    e.amount = amount
    e.currency = "TJSB"
    e.reason = "스프린트 완료"
    e.reference_type = None
    e.reference_id = None
    e.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return e


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_list_rewards_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.reward.RewardRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_entry()]

            async with client as c:
                resp = await c.get(f"/api/v2/rewards?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["reason"] == "스프린트 완료"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_rewards_with_member_filter_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.reward.RewardRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_entry()]

            async with client as c:
                resp = await c.get(f"/api/v2/rewards?project_id={PROJECT_ID}&member_id={MEMBER_ID}")

        assert resp.status_code == 200
        mock_list.assert_called_once_with(project_id=PROJECT_ID, member_id=MEMBER_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_balance_200():
    """prod 핫픽스(S20 MUST): self-or-org-admin 통과 시(caller 본인) 정상 동작."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.reward.RewardRepository.get_balance", new_callable=AsyncMock) as mock_bal, \
             patch("app.routers.rewards.is_caller_member", new_callable=AsyncMock, return_value=True):
            mock_bal.return_value = 150.0

            async with client as c:
                resp = await c.get(f"/api/v2/rewards/balance?project_id={PROJECT_ID}&member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["balance"] == 150.0
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_balance_403_when_not_self_or_admin():
    """prod 핫픽스(S20 MUST): 타 멤버 잔액 열람 차단(재무정보 노출)."""
    client, session, app = await _client()
    try:
        with patch("app.routers.rewards.is_caller_member", new_callable=AsyncMock, return_value=False), \
             patch("app.routers.rewards._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.get(f"/api/v2/rewards/balance?project_id={PROJECT_ID}&member_id={MEMBER_ID}")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_grant_reward_201():
    """prod 핫픽스(S20 MUST, 최우선): org-admin 통과 시 정상 동작·granted_by는 caller에서 서버파생."""
    client, session, app = await _client()
    try:
        resolved = MagicMock()
        resolved.id = GRANTER_ID
        with patch("app.repositories.reward.RewardRepository.grant", new_callable=AsyncMock) as mock_grant, \
             patch("app.routers.rewards._is_org_admin", new_callable=AsyncMock, return_value=True), \
             patch("app.routers.rewards.resolve_member", new_callable=AsyncMock, return_value=resolved), \
             patch("app.services.member_resolver.canonicalize_member_id", new_callable=AsyncMock, side_effect=lambda mid, _s: mid):
            mock_grant.return_value = _mock_entry(25.0)

            async with client as c:
                resp = await c.post("/api/v2/rewards", json={
                    "project_id": str(PROJECT_ID),
                    "member_id": str(MEMBER_ID),
                    "amount": 25.0,
                    "reason": "스프린트 완료",
                    "granted_by": str(uuid.uuid4()),  # S20: 바디값 무시(caller에서 서버-파생)
                })

        assert resp.status_code == 201
        assert resp.json()["currency"] == "TJSB"
        assert mock_grant.await_args.kwargs["granted_by"] == GRANTER_ID
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_grant_reward_403_when_not_org_admin():
    """prod 핫픽스(S20 MUST): org-admin 아니면 임의 리워드 발행 차단."""
    client, session, app = await _client()
    try:
        with patch("app.routers.rewards._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.post("/api/v2/rewards", json={
                    "project_id": str(PROJECT_ID),
                    "member_id": str(MEMBER_ID),
                    "amount": 25.0,
                    "reason": "스프린트 완료",
                    "granted_by": str(GRANTER_ID),
                })

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_grant_reward_404_member_not_in_project():
    client, session, app = await _client()
    try:
        resolved = MagicMock()
        resolved.id = GRANTER_ID
        with patch("app.repositories.reward.RewardRepository.grant", new_callable=AsyncMock) as mock_grant, \
             patch("app.routers.rewards._is_org_admin", new_callable=AsyncMock, return_value=True), \
             patch("app.routers.rewards.resolve_member", new_callable=AsyncMock, return_value=resolved), \
             patch("app.services.member_resolver.canonicalize_member_id", new_callable=AsyncMock, side_effect=lambda mid, _s: mid):
            mock_grant.return_value = None

            async with client as c:
                resp = await c.post("/api/v2/rewards", json={
                    "project_id": str(PROJECT_ID),
                    "member_id": str(uuid.uuid4()),
                    "amount": 10.0,
                    "reason": "테스트",
                    "granted_by": str(GRANTER_ID),
                })

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_leaderboard_all_200():
    client, session, app = await _client()
    try:
        mock_data = [
            {"member_id": MEMBER_ID, "balance": 200.0},
            {"member_id": GRANTER_ID, "balance": 100.0},
        ]
        with patch("app.repositories.reward.RewardRepository.leaderboard", new_callable=AsyncMock) as mock_lb:
            mock_lb.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/rewards/leaderboard?project_id={PROJECT_ID}&period=all")

        assert resp.status_code == 200
        assert len(resp.json()) == 2
        assert resp.json()[0]["balance"] == 200.0
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_leaderboard_weekly_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.reward.RewardRepository.leaderboard", new_callable=AsyncMock) as mock_lb:
            mock_lb.return_value = [{"member_id": MEMBER_ID, "balance": 50.0}]

            async with client as c:
                resp = await c.get(f"/api/v2/rewards/leaderboard?project_id={PROJECT_ID}&period=weekly&limit=10")

        assert resp.status_code == 200
        mock_lb.assert_called_once_with(project_id=PROJECT_ID, period="weekly", limit=10, cursor=None)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_leaderboard_invalid_period_400():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/rewards/leaderboard?project_id={PROJECT_ID}&period=invalid")

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_leaderboard_403_when_project_not_in_caller_org():
    """산티아고 SME fast-follow(S20 전수봉인): project_id가 caller org 소속 아니면 403
    (이전엔 project 소속 검증 자체가 없어 project_id만 알면 타 org 리더보드가 노출됐다)."""
    client, session, app = await _client()
    try:
        not_found = MagicMock()
        not_found.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=not_found)

        async with client as c:
            resp = await c.get(f"/api/v2/rewards/leaderboard?project_id={PROJECT_ID}&period=all")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
