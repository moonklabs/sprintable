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
    """팀원 보상 잔액 조회."""
    try:
        return ok(await client.get("/api/v2/rewards", params={"project_id": client.project_id, "member_id": args.member_id, "balance": "true"}))
    except Exception as exc:
        return err(str(exc))


async def give_reward(args: GiveRewardInput) -> list[TextContent]:
    """팀원 보상/패널티 지급."""
    body: dict = {
        "project_id": client.project_id,
        "member_id": args.member_id,
        "amount": args.amount,
        "reason": args.reason,
        "granted_by": args.granted_by,
    }
    if args.reference_type:
        body["reference_type"] = args.reference_type
    if args.reference_id:
        body["reference_id"] = args.reference_id
    try:
        return ok(await client.post("/api/v2/rewards", json=body))
    except Exception as exc:
        return err(str(exc))


async def get_leaderboard_v2(args: GetLeaderboardInput) -> list[TextContent]:
    """보상 리더보드 조회."""
    params: dict = {"project_id": client.project_id, "type": "leaderboard"}
    if args.period:
        params["period"] = args.period
    if args.limit is not None:
        params["limit"] = str(args.limit)
    try:
        return ok(await client.get("/api/v2/rewards", params=params))
    except Exception as exc:
        return err(str(exc))
