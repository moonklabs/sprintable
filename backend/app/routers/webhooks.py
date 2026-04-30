import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.webhook_config import WebhookConfigRepository
from app.schemas.webhook_config import UpsertWebhookConfig, WebhookConfigResponse

router = APIRouter(prefix="/api/v2/webhooks", tags=["webhooks"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> WebhookConfigRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required")
    return WebhookConfigRepository(session, uuid.UUID(str(org_id_str)))


@router.get("/config", response_model=list[WebhookConfigResponse])
async def list_webhook_configs(
    project_id: uuid.UUID | None = Query(default=None),
    repo: WebhookConfigRepository = Depends(_get_repo),
) -> list[WebhookConfigResponse]:
    items = await repo.list(project_id=project_id)
    return [WebhookConfigResponse.model_validate(i) for i in items]


@router.put("/config", response_model=WebhookConfigResponse)
async def upsert_webhook_config(
    body: UpsertWebhookConfig,
    repo: WebhookConfigRepository = Depends(_get_repo),
) -> WebhookConfigResponse:
    config = await repo.upsert(
        member_id=body.member_id,
        url=body.url,
        project_id=body.project_id,
        events=body.events,
        is_active=body.is_active,
    )
    return WebhookConfigResponse.model_validate(config)


@router.delete("/config", status_code=200)
async def delete_webhook_config(
    id: uuid.UUID = Query(...),
    repo: WebhookConfigRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="WebhookConfig not found")
    return {"ok": True}
