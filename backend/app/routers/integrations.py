import os
import json
import base64
import urllib.parse
import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.project import OrgMember
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/v2/integrations", tags=["integrations"])


def _err(code: str, message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(
        {"data": None, "error": {"code": code, "message": message}, "meta": None},
        status_code=status,
    )


@router.get("/slack/connect")
async def slack_connect(
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id")
    project_id_str = auth.claims.get("app_metadata", {}).get("project_id")
    if not org_id_str:
        return _err("FORBIDDEN", "org_id required", 403)

    org_id = uuid.UUID(org_id_str)
    user_id = uuid.UUID(auth.user_id)

    result = await session.execute(
        select(OrgMember).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == user_id,
            OrgMember.deleted_at.is_(None),
        )
    )
    org_member = result.scalar_one_or_none()
    if not org_member or org_member.role not in ("owner", "admin"):
        return _err("FORBIDDEN", "Admin access required", 403)

    client_id = os.environ.get("SLACK_CLIENT_ID")
    redirect_uri = os.environ.get("SLACK_REDIRECT_URI")
    if not client_id or not redirect_uri:
        return _err("BAD_REQUEST", "Slack OAuth is not configured", 400)

    state = base64.urlsafe_b64encode(
        json.dumps({"orgId": org_id_str, "projectId": project_id_str, "source": "slack-settings"}).encode()
    ).decode().rstrip("=")

    params = urllib.parse.urlencode({
        "client_id": client_id,
        "scope": "channels:read,chat:write,incoming-webhook",
        "redirect_uri": redirect_uri,
        "state": state,
    })
    url = f"https://slack.com/oauth/v2/authorize?{params}"
    return JSONResponse({"data": {"url": url}, "error": None, "meta": None})
