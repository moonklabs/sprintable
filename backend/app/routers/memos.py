import os
import uuid
import logging

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.team import TeamMember
from app.repositories.memo import MemoReplyRepository, MemoRepository
from app.routers.events import publish_event
from app.schemas.memo import CreateMemo, CreateReply, MemoListResponse, MemoResponse, ReplyResponse, UpdateMemo

router = APIRouter(prefix="/api/v2/memos", tags=["memos"])


async def _collect_reply_webhook_urls(
    db: AsyncSession, assigned_to: uuid.UUID | None, created_by: uuid.UUID | None, sender_id: uuid.UUID
) -> list[str]:
    recipient_ids = {assigned_to, created_by} - {sender_id, None}
    if not recipient_ids:
        return []
    rows = await db.execute(
        select(TeamMember.webhook_url).where(
            TeamMember.id.in_(recipient_ids),
            TeamMember.is_active.is_(True),
            TeamMember.webhook_url.isnot(None),
        )
    )
    return [row[0] for row in rows if row[0]]


def _fire_webhook(url: str, content: str, title: str, memo_url: str) -> None:
    try:
        if "discord.com/api/webhooks" in url or "discordapp.com/api/webhooks" in url:
            payload: dict = {"content": content}
            if memo_url:
                payload["embeds"] = [{"title": title, "url": memo_url}]
        else:
            payload = {"text": content}
        httpx.post(url, json=payload, timeout=10)
    except Exception:  # noqa: BLE001
        logger.warning("reply webhook fire failed url=%s", url, exc_info=True)


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> MemoRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required",
        )
    return MemoRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[MemoListResponse])
async def list_memos(
    project_id: uuid.UUID | None = Query(default=None),
    assigned_to: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    q: str | None = Query(default=None),
    repo: MemoRepository = Depends(_get_repo),
) -> list[MemoListResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if assigned_to:
        filters["assigned_to"] = assigned_to
    if status_filter:
        filters["status"] = status_filter
    if q:
        filters["q"] = q
    memos = await repo.list(**filters)
    return [MemoListResponse.model_validate(m) for m in memos]


@router.post("", response_model=MemoListResponse, status_code=201)
async def create_memo(
    body: CreateMemo,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> MemoListResponse:
    repo = MemoRepository(session, body.org_id)
    memo = await repo.create(
        project_id=body.project_id,
        content=body.content,
        memo_type=body.memo_type,
        title=body.title,
        assigned_to=body.assigned_to,
        created_by=body.created_by,
        supersedes_id=body.supersedes_id,
        memo_metadata=body.memo_metadata,
    )
    publish_event(str(body.org_id), "memo_created", {"id": str(memo.id)})
    return MemoListResponse.model_validate(memo)


@router.get("/{id}", response_model=MemoResponse)
async def get_memo(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    repo: MemoRepository = Depends(_get_repo),
) -> MemoResponse:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    reply_repo = MemoReplyRepository(db)
    replies = await reply_repo.list_by_memo(id)
    reply_items = [ReplyResponse.model_validate(r) for r in replies]
    # update= 로 replies 오버라이드하여 ORM lazy-load 방지
    response = MemoResponse.model_validate(memo, update={"replies": reply_items, "reply_count": len(reply_items)})
    return response


@router.patch("/{id}", response_model=MemoListResponse)
async def update_memo(
    id: uuid.UUID,
    body: UpdateMemo,
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    data = body.model_dump(exclude_unset=True)
    memo = await repo.update(id, **data)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    publish_event(str(repo.org_id), "memo_updated", {"id": str(id)})
    return MemoListResponse.model_validate(memo)


@router.delete("/{id}", status_code=200)
async def delete_memo(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.soft_delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Memo not found")
    return {"ok": True}


@router.post("/{id}/replies", response_model=ReplyResponse, status_code=201)
async def add_reply(
    id: uuid.UUID,
    body: CreateReply,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    repo: MemoRepository = Depends(_get_repo),
) -> ReplyResponse:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    reply_repo = MemoReplyRepository(db)
    reply = await reply_repo.create(
        memo_id=id, content=body.content, created_by=body.created_by, review_type=body.review_type
    )
    publish_event(str(repo.org_id), "reply_created", {"id": str(reply.id), "memo_id": str(id)})

    # 세션이 열려 있는 지금 webhook URLs 수집 후 BackgroundTasks에 HTTP 발송 위임
    webhook_urls = await _collect_reply_webhook_urls(db, memo.assigned_to, memo.created_by, body.created_by)
    if webhook_urls:
        app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "")
        memo_url = f"{app_url}/memos?id={id}" if app_url else ""
        content = f"📩 **새 답신**\n{reply.content[:500]}"
        title = memo.title or "메모 답신"
        for url in webhook_urls:
            background_tasks.add_task(_fire_webhook, url, content, title, memo_url)

    return ReplyResponse.model_validate(reply)


@router.post("/{id}/resolve", response_model=MemoListResponse)
async def resolve_memo(
    id: uuid.UUID,
    resolved_by: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    memo = await repo.resolve(id, resolved_by)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    return MemoListResponse.model_validate(memo)


@router.post("/{id}/archive", response_model=MemoListResponse)
async def archive_memo(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    memo = await repo.archive(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    return MemoListResponse.model_validate(memo)


@router.post("/{id}/read", status_code=200)
async def mark_read(
    id: uuid.UUID,
    team_member_id: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    await repo.mark_read(id, team_member_id)
    return {"ok": True}


@router.get("/{id}/linked-docs")
async def get_linked_docs(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> list[dict]:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    links = await repo.get_doc_links(id)
    return [{"id": str(l.id), "memo_id": str(l.memo_id), "doc_id": str(l.doc_id)} for l in links]


@router.post("/convert", status_code=201)
async def convert_to_doc(
    memo_id: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    memo = await repo.get(memo_id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    # Phase B stub — actual doc creation in Phase D
    return {"ok": True, "memo_id": str(memo_id), "doc_id": None}
