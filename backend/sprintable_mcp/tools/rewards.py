"""보상 관련 MCP 도구 (3개)."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class GetWalletInput(SprintableInput):
    member_id: str


class GiveRewardInput(SprintableInput):
    member_id: str
    amount: float
    reason: str
    granted_by: str
    reference_type: str | None = None
    reference_id: str | None = None


class GetLeaderboardInput(SprintableInput):
    period: Literal["all", "daily", "weekly", "monthly"] | None = None
    limit: int | None = None


async def get_wallet(args: GetWalletInput) -> list[TextContent]:
    """팀원 보상 잔액 조회.

    story #4329 — 예전엔 `GET /api/v2/rewards`(적립 목록)에 `balance=true`를 붙여 보냈는데 그 라우트는 `balance`를 모른다 → 잔액이 아니라
    적립 목록이 왔다. 잔액은 `GET /api/v2/rewards/balance`(본인 또는 조직 관리자만)."""
    try:
        return ok(await client.get("/api/v2/rewards/balance", params={"project_id": client.require_project_id(), "member_id": args.member_id}))
    except Exception as exc:
        return err(exc)


async def give_reward(args: GiveRewardInput) -> list[TextContent]:
    """팀원 보상/패널티 지급."""
    try:
        body: dict = {
            "project_id": client.require_project_id(),
            "member_id": args.member_id,
            "amount": args.amount,
            "reason": args.reason,
            "granted_by": args.granted_by,
        }
        if args.reference_type:
            body["reference_type"] = args.reference_type
        if args.reference_id:
            body["reference_id"] = args.reference_id
        return ok(await client.post("/api/v2/rewards", json=body))
    except Exception as exc:
        return err(exc)


async def get_leaderboard_v2(args: GetLeaderboardInput) -> list[TextContent]:
    """보상 리더보드 조회.

    story #4329 — 예전엔 `GET /api/v2/rewards`(적립 목록)에 `type=leaderboard`를 붙여 보냈는데 그 라우트는 `type` · `period` · `limit`를
    모른다 → 순위가 아니라 적립 목록이 왔다. 순위는 `GET /api/v2/rewards/leaderboard`(period · limit를 받는다)."""
    try:
        params: dict = {"project_id": client.require_project_id()}
        if args.period:
            params["period"] = args.period
        if args.limit is not None:
            params["limit"] = str(args.limit)
        return ok(await client.get("/api/v2/rewards/leaderboard", params=params))
    except Exception as exc:
        return err(exc)
