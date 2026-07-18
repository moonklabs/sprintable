"""story #1994(E-KNOWLEDGE-LINK S2) — 백링크 API 인가+페이지네이션 코어. 근본 설계 doc
design-org-knowledge-mentions-backlinks §8.

불변식(§8①): backlink 공개 = can_read(target_doc) AND can_read(source_resource). target 접근은
호출부(docs.py `_require_doc_project_access`)가 이미 검증한다 — 이 모듈은 **source** 접근을
mention 행 단위로 독립 판정한다(target 검사를 source에 상속하지 않는다 — 산티아고 리뷰가
잡은 갭: 멀티프로젝트 org에서 target doc project ≠ source doc project일 수 있다).

§8② canonical predicate 재사용(재구현 0):
  · doc source  ⇒ `has_project_access`(project_auth.py — docs.py `_require_doc_project_access`가
    쓰는 그 SSOT를 그대로 호출).
  · chat_message source ⇒ `_can_read_conversation`(conversations.py — `_authorize_message_read`
    에서 추출한 canonical bool 술어, 동일 body).

§8③ all-SQL 원칙은 그 두 SSOT 함수 내부(3-way grant∪team_member∪owner-admin EXISTS)가 지킨다.
이 모듈 자체는 "후보 윈도우 fetch → authz filter(Python, SSOT 함수만 호출) → 부족하면 refetch"
패턴을 쓴다 — has_project_access/participant 판정을 raw SQL로 재구현하면 그게 드리프트
소스가 되므로 의도적으로 피한다(설계 doc의 명시적 결정). count(len(data))/has_more는 **authz
필터를 통과한 집합에서만** 계산한다.

§8④ no-oracle: 미인가 target doc은 이 모듈 호출 전(docs.py 라우트가 404)에 이미 걸러진다.
source 미인가 mention은 조용히 드롭 — has_more/next_cursor 어디에도 "몇 개가 걸러졌는지"가
드러나지 않는다(authz-filtered 집합 기준으로만 페이지네이션). unknown source_type은
fail-closed 제외(신 source_type 확장 시 이 모듈이 명시 분기를 추가하기 전엔 노출 0).
snippet은 항상 read-time 계산(mentions 테이블에 저장 안 함 — 영구 비정규화 금지).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext
from app.models.conversation import ConversationMessage
from app.models.doc import Doc
from app.models.mention import Mention
from app.services.member_resolver import lookup_members_by_ids
from app.services.project_auth import has_project_access

# 후보 윈도우 크기 = limit * 배율(상한 캡). has_project_access/`_can_read_conversation` 판정
# 비용이 낮지 않아(각각 SQL EXISTS 3-way) 과도한 윈도우는 지양 — 그래도 부족하면 라운드를 늘린다.
_WINDOW_MULTIPLIER = 3
_WINDOW_CAP = 300
# 전량 미인가(pathological) candidate 구간에서 무한정 refetch 하지 않도록 라운드 상한.
# 상한 도달 시 has_more=False로 보수적 마감(추가 인가 항목이 실제로 남아있어도 페이지네이션이
# 거기서 멈춘다 — 기능적 손실일 뿐 보안 누출은 아니다: 미인가 존재 자체를 드러내지 않는다).
_MAX_ROUNDS = 5
_SNIPPET_MAX = 160


def build_content_snippet(text: str, max_len: int = _SNIPPET_MAX) -> str:
    """공백/개행 정규화 후 max_len 글자로 절삭(+ ellipsis). read-time 계산(순수 함수) —
    mentions 테이블에 저장하지 않는다(§8④ no permanent snippet denormalization)."""
    normalized = " ".join((text or "").split())
    if len(normalized) <= max_len:
        return normalized
    return normalized[:max_len].rstrip() + "…"


def _merge_sort_limit(candidates: list[Mention], limit: int) -> tuple[list[Mention], bool]:
    """authz 통과 mention 후보(라운드별로 이미 created_at DESC 순서지만 방어적으로 재정렬)를
    병합정렬 후 limit(+1 여유분으로 has_more 판정)로 슬라이스. 순수 함수(DB 무관) — unit test 대상.
    has_more/next_cursor는 이 authorized 집합에서만 계산된다(§8③④ no pagination oracle)."""
    ordered = sorted(candidates, key=lambda m: m.created_at, reverse=True)
    has_more = len(ordered) > limit
    return ordered[:limit], has_more


@dataclass
class _AuthzCaches:
    """라운드 간 재사용되는 메모이제이션 캐시 — has_project_access/`_can_read_conversation`을
    distinct project_id/conversation_id당 정확히 1회만 호출하기 위함(N+1 방지 핵심)."""
    doc_access: dict[uuid.UUID, bool]
    conv_access: dict[uuid.UUID, bool]
    doc_info: dict[uuid.UUID, tuple[uuid.UUID, str]]        # doc_id -> (project_id, title)
    msg_info: dict[uuid.UUID, tuple[uuid.UUID, str, uuid.UUID | None]]  # msg_id -> (conversation_id, content, sender_id)

    @classmethod
    def empty(cls) -> "_AuthzCaches":
        return cls(doc_access={}, conv_access={}, doc_info={}, msg_info={})


async def _authorize_round(
    db: AsyncSession,
    org_id: uuid.UUID,
    auth: AuthContext,
    candidates: list[Mention],
    caches: _AuthzCaches,
) -> list[Mention]:
    """이번 라운드 candidate mentions을 source_type별로 배치 조회(N+1 없음) 후 §8② canonical
    predicate로 인가 판정. 인가 통과분만 반환(원래 순서 보존 — candidates가 이미 created_at DESC)."""
    new_doc_ids = {
        c.source_id for c in candidates if c.source_type == "doc" and c.source_id not in caches.doc_info
    }
    if new_doc_ids:
        rows = (await db.execute(
            select(Doc.id, Doc.project_id, Doc.title).where(
                Doc.id.in_(new_doc_ids),
                Doc.org_id == org_id,
                Doc.deleted_at.is_(None),  # soft-deleted source doc 배제
            )
        )).all()
        for row in rows:
            caches.doc_info[row.id] = (row.project_id, row.title)
        # deleted_at IS NOT NULL/미존재로 안 걸린 id는 caches.doc_info에 안 남는다 → 직렬화 단계 skip.

    new_msg_ids = {
        c.source_id for c in candidates if c.source_type == "chat_message" and c.source_id not in caches.msg_info
    }
    if new_msg_ids:
        rows = (await db.execute(
            select(
                ConversationMessage.id, ConversationMessage.conversation_id,
                ConversationMessage.content, ConversationMessage.sender_id,
            ).where(ConversationMessage.id.in_(new_msg_ids))
        )).all()
        for row in rows:
            caches.msg_info[row.id] = (row.conversation_id, row.content, row.sender_id)

    # distinct project_id당 has_project_access 정확히 1회(§ Recommended architecture — SSOT 재구현 회피).
    new_project_ids = {pid for pid, _title in caches.doc_info.values()} - caches.doc_access.keys()
    if new_project_ids:
        uid = uuid.UUID(str(auth.user_id))
        for project_id in new_project_ids:
            caches.doc_access[project_id] = await has_project_access(db, uid, project_id, org_id)

    # distinct conversation_id당 _can_read_conversation 정확히 1회(canonical predicate 재사용).
    new_conv_ids = {cid for cid, _content, _sid in caches.msg_info.values()} - caches.conv_access.keys()
    if new_conv_ids:
        from app.routers.conversations import _can_read_conversation  # lazy: 순환 import 회피(기존 관례)

        for conversation_id in new_conv_ids:
            caches.conv_access[conversation_id] = await _can_read_conversation(
                conversation_id, db, auth, org_id,
            )

    authorized: list[Mention] = []
    for c in candidates:
        if c.source_type == "doc":
            info = caches.doc_info.get(c.source_id)
            if info is None:
                continue  # soft-deleted/미존재 source doc → 제외
            project_id, _title = info
            if caches.doc_access.get(project_id):
                authorized.append(c)
        elif c.source_type == "chat_message":
            info = caches.msg_info.get(c.source_id)
            if info is None:
                continue  # 미존재 source message → 제외
            conversation_id, _content, _sender_id = info
            if caches.conv_access.get(conversation_id):
                authorized.append(c)
        # else: unknown source_type → fail-closed 제외(스키마 CHECK가 이미 chat_message|doc만
        # 허용하지만, 방어적으로 명시 — 향후 source_type 확장 시 이 분기가 명시 추가 전까진 노출 0).
    return authorized


async def list_doc_backlinks(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    auth: AuthContext,
    limit: int,
    before: datetime | None,
) -> dict:
    """GET /api/v2/docs/{id}/backlinks 코어. 호출부(docs.py)가 target doc 접근을 이미 검증했다는
    전제(§8① target read access는 별도·기존 라우트 책임) — 여기선 source 접근만 행 단위로 판정한다.

    반환: `{"data": [...], "meta": {"next_cursor": str|None, "has_more": bool}}` — list_messages와
    동일 shape(AC1 "same convention"). data 항목: {id, source_type, source_id, created_by,
    created_at, doc: {id,title}|None, message: {id,conversation_id,content_snippet,sender}|None}.
    """
    caches = _AuthzCaches.empty()
    authorized: list[Mention] = []
    cursor = before
    window = min(max(limit, 1) * _WINDOW_MULTIPLIER, _WINDOW_CAP)

    for _round in range(_MAX_ROUNDS):
        stmt = (
            select(Mention)
            .where(
                Mention.org_id == org_id,
                Mention.target_type == "doc",
                Mention.target_id == doc_id,
            )
            .order_by(Mention.created_at.desc())
            .limit(window)
        )
        if cursor is not None:
            stmt = stmt.where(Mention.created_at < cursor)
        candidates = (await db.execute(stmt)).scalars().all()
        if not candidates:
            break

        authorized.extend(await _authorize_round(db, org_id, auth, list(candidates), caches))

        exhausted = len(candidates) < window  # 이 윈도우 밑으로 더 이상 raw mention row가 없다.
        cursor = candidates[-1].created_at
        if len(authorized) > limit or exhausted:
            break
        # else: 라운드 상한까지 더 오래된 윈도우를 refetch(§ Recommended architecture pagination pattern).

    page, has_more = _merge_sort_limit(authorized, limit)

    sender_ids = {
        caches.msg_info[m.source_id][2]
        for m in page
        if m.source_type == "chat_message"
        and caches.msg_info.get(m.source_id) is not None
        and caches.msg_info[m.source_id][2] is not None
    }
    sender_map = await lookup_members_by_ids(sender_ids, db)

    data: list[dict] = []
    for m in page:
        item: dict = {
            "id": str(m.id),
            "source_type": m.source_type,
            "source_id": str(m.source_id),
            "created_by": str(m.created_by) if m.created_by else None,
            "created_at": m.created_at.isoformat(),
            "doc": None,
            "message": None,
        }
        if m.source_type == "doc":
            info = caches.doc_info.get(m.source_id)
            if info is not None:
                _project_id, title = info
                item["doc"] = {"id": str(m.source_id), "title": title}
        elif m.source_type == "chat_message":
            info = caches.msg_info.get(m.source_id)
            if info is not None:
                conversation_id, content, sender_id = info
                sender = sender_map.get(sender_id) if sender_id else None
                item["message"] = {
                    "id": str(m.source_id),
                    "conversation_id": str(conversation_id),
                    "content_snippet": build_content_snippet(content),
                    "sender": (
                        {"id": str(sender.id), "name": sender.name, "type": sender.type}
                        if sender is not None else None
                    ),
                }
        data.append(item)

    next_cursor = page[-1].created_at.isoformat() if has_more and page else None
    return {"data": data, "meta": {"next_cursor": next_cursor, "has_more": has_more}}
