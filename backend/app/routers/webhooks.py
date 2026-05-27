import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.webhook_config import WebhookConfigRepository
from app.schemas.webhook_config import UpsertWebhookConfig, WebhookConfigResponse

router = APIRouter(prefix="/api/v2/webhooks", tags=["webhooks"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> WebhookConfigRepository:
    return WebhookConfigRepository(session, org_id)


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
        secret=body.secret,
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
