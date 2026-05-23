from __future__ import annotations

import uuid

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.plan_feature import PlanFeature
from app.models.project_api_key import ProjectApiKey
from app.services.rate_limiter import TIER_LIMITS, get_rate_limiter, hash_api_key

_PK_PREFIX = "pk_live_"


async def _resolve_tier(token: str, db: AsyncSession) -> tuple[str, str]:
    """API Key plaintext → (tier, rate_key).
    Returns ('unknown', key) if key not found or revoked — caller should 403."""
    key_hash = hash_api_key(token)
    result = await db.execute(
        select(ProjectApiKey).where(
            ProjectApiKey.key_hash == key_hash,
            ProjectApiKey.revoked_at.is_(None),
        )
    )
    key_obj = result.scalar_one_or_none()
    if key_obj is None:
        return "unknown", token[:16]

    rate_key = f"pk:{key_obj.id}"

    if not key_obj.plan_feature_ids:
        return "free", rate_key

    feat_result = await db.execute(
        select(PlanFeature.tier).where(
            PlanFeature.id == key_obj.plan_feature_ids[0],
            PlanFeature.is_active.is_(True),
        )
    )
    tier = feat_result.scalar_one_or_none() or "free"
    return tier, rate_key


class RateLimitDependency:
    """Sliding-window rate limit dependency.

    Attach to any router that should enforce per-API-key or per-user limits.
    Adds X-RateLimit-Limit / X-RateLimit-Remaining / Retry-After headers.
    """

    def __init__(self, *, override_limit: int | None = None) -> None:
        self._override = override_limit

    async def __call__(
        self,
        request: Request,
        response: Response,
        auth: AuthContext = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> None:
        auth_header = request.headers.get("Authorization", "")
        is_pk = auth_header.startswith(f"Bearer {_PK_PREFIX}")

        if is_pk:
            token = auth_header[len("Bearer "):]
            tier, rate_key = await _resolve_tier(token, db)
            if tier == "unknown":
                raise HTTPException(status_code=401, detail="Invalid or revoked API key")
            limit = self._override or TIER_LIMITS.get(tier, TIER_LIMITS["free"])
        else:
            user_id = auth.user_id or "anon"
            rate_key = f"jwt:{user_id}"
            limit = self._override or TIER_LIMITS["jwt"]

        limiter = get_rate_limiter()
        allowed, remaining, retry_after = await limiter.check(rate_key, limit)

        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Remaining"] = str(remaining)

        if not allowed:
            response.headers["Retry-After"] = str(retry_after)
            raise HTTPException(
                status_code=429,
                detail={"code": "RATE_LIMITED", "message": "Too many requests", "retry_after": retry_after},
            )


rate_limit = RateLimitDependency()
