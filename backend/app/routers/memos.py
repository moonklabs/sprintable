import uuid
import asyncio
import logging

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
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


async def _dispatch_reply_webhooks(db: AsyncSession, memo: object, reply: object, sender_id: uuid.UUID) -> None:
    try:
        from app.models.memo import Memo, MemoReply  # noqa: PLC0415

        m: Memo = memo  # type: ignore[assignment]
        r: MemoReply = reply  # type: ignore[assignment]

        recipient_ids = {m.assigned_to, m.created_by} - {sender_id, None}
        if not recipient_ids:
            return

        rows = await db.execute(
            select(TeamMember.webhook_url).where(
                TeamMember.id.in_(recipient_ids),
                TeamMember.is_active.is_(True),
                TeamMember.webhook_url.isnot(None),
            )
        )
        urls = [row[0] for row in rows if row[0]]
        if not urls:
            return

        app_url = __import__("os").environ.get("NEXT_PUBLIC_APP_URL", "")
        memo_url = f"{app_url}/memos?id={m.id}" if app_url else ""

        async with httpx.AsyncClient(timeout=10) as client:
            for url in urls:
                try:
                    if "discord.com/api/webhooks" in url or "discordapp.com/api/webhooks" in url:
                        payload = {
                            "content": f"📩 **새 답신**\n{r.content[:500]}",
                            "embeds": [{"title": m.title or "메모 답신", "url": memo_url}] if memo_url else [],
                        }
                    else:
                        payload = {"text": f"새 답신: {r.content[:200]}"}
                    await client.post(url, json=payload)
                except Exception:  # noqa: BLE001
                    pass
    except Exception:  # noqa: BLE001
        logger.warning("reply webhook dispatch failed", exc_info=True)


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
    response = MemoResponse.model_validate(memo)
    response.replies = [ReplyResponse.model_validate(r) for r in replies]
    response.reply_count = len(replies)
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

    # Discord 웹훅 발송 (비동기, 실패 무시)
    asyncio.create_task(_dispatch_reply_webhooks(db, memo, reply, body.created_by))

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
