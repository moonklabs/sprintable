"""C-S6: Supabase Realtime presence → FastAPI presence (in-memory, TTL 45s)

Supabase 채널 기반 presence를 FastAPI in-memory 저장소로 대체.
클라이언트는 30초마다 POST /heartbeat로 presence를 갱신하고
GET /api/v2/memos/{id}/presence로 현재 보고 있는 사람 목록을 조회.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.dependencies.auth import AuthContext, get_current_user

router = APIRouter(prefix="/api/v2/memos", tags=["presence"])

_PRESENCE_TTL_SEC = 45

@dataclass
class PresenceEntry:
    user_id: str
    name: str
    typing: bool
    state: str  # "viewing" | "typing"
    updated_at: float = field(default_factory=time.time)


# memo_id → {user_id: PresenceEntry}
_presence_store: dict[str, dict[str, PresenceEntry]] = {}


def _evict_expired(memo_id: str) -> None:
    now = time.time()
    store = _presence_store.get(memo_id, {})
    expired = [uid for uid, e in store.items() if now - e.updated_at > _PRESENCE_TTL_SEC]
    for uid in expired:
        store.pop(uid, None)


@router.post("/{memo_id}/presence")
async def update_presence(
    memo_id: uuid.UUID,
    typing: bool = False,
    name: str = "",
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    """POST /api/v2/memos/{id}/presence — 현재 보고 있음 알림 (TTL 45s)."""
    mid = str(memo_id)
    if mid not in _presence_store:
        _presence_store[mid] = {}
    _presence_store[mid][auth.user_id] = PresenceEntry(
        user_id=auth.user_id,
        name=name or auth.email or auth.user_id,
        typing=typing,
        state="typing" if typing else "viewing",
    )
    _evict_expired(mid)
    return JSONResponse({"ok": True})


@router.get("/{memo_id}/presence")
async def get_presence(
    memo_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    """GET /api/v2/memos/{id}/presence — 현재 보고 있는 사람 목록."""
    mid = str(memo_id)
    _evict_expired(mid)
    entries = [
        {**asdict(e), "updated_at": e.updated_at}
        for uid, e in _presence_store.get(mid, {}).items()
        if uid != auth.user_id
    ]
    return JSONResponse({"data": entries})
