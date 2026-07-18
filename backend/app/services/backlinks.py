"""story #1994(E-KNOWLEDGE-LINK S2) — 백링크 API 인가+페이지네이션 코어. 근본 설계 doc
design-org-knowledge-mentions-backlinks §8.

불변식(§8①): backlink 공개 = can_read(target_doc) AND can_read(source_resource). target 접근은
호출부(docs.py `_require_doc_project_access`)가 이미 검증한다 — 이 모듈은 **source** 접근을
mention 행 단위로 독립 판정한다(target 검사를 source에 상속하지 않는다 — 산티아고 리뷰가
잡은 갭: 멀티프로젝트 org에서 target doc project ≠ source doc project일 수 있다).

§8② canonical predicate 재사용(재구현 0):
  · doc source  ⇒ `accessible_project_ids_in_org`(project_auth.py — `has_project_access`와
    동일 3-way grant∪team_member∪owner-admin EXISTS의 **bulk** 형태. docs.py
    `_require_doc_project_access`가 쓰는 per-project SSOT를 요청당 1회 집합으로 해소).
  · chat_message source ⇒ `_can_read_conversation`(conversations.py — `_authorize_message_read`
    에서 추출한 canonical bool 술어, 동일 body. story #1994 B1 하드닝으로 raise 없는 total
    boolean predicate 계약이 되었다 — grant-loss caller가 한 mention을 poison하지 않는다).

산티아고 sabotage-probe 재구현(B2 근본원인 수정): 이전 draft는 "후보 윈도우 fetch → Python
authz filter → 부족하면 최대 5라운드 refetch" 패턴을 썼다 — has_project_access/participant
판정을 raw SQL로 재구현하면 드리프트 소스가 된다는 이유로 의도적으로 선택했으나, 이 추론이
틀렸다: bounded retry loop 자체가 "몇 라운드에서 멈추는가"가 숨은 미인가 행 개수에 의존하는
oracle-shaped 동작이다(§8③ "authz-before-pagination, SQL/WHERE 레벨, bounded Python retry
loop 아님" 요구를 DRY 우려와 맞바꾼 것 — 잘못된 트레이드오프). 대체 아키텍처(2-phase, 윈도우/
라운드 0):

Phase 1 — 요청당 **정확히 1회**, 페이지 무관하게 전체 인가된 source identity 집합을 해소한다:
  · doc: `accessible_project_ids_in_org`(SSOT bulk 헬퍼) 1회 호출 → `accessible_pids` 집합.
  · chat_message: 이 target doc을 멘션한 적 있는 distinct conversation_id 전체(윈도우/캡/
    라운드 없음 — 이 특정 doc에 대한 완전한 candidate 집합, client에 노출되지 않는 내부
    계산이라 그 자체로 oracle이 될 수 없다)를 가벼운 1개 쿼리로 조회 후, `_can_read_conversation`
    을 **distinct conversation_id당 정확히 1회**(round-cap/give-up 없음 — 실무상 소수) 호출해
    `readable_conv_ids` 집합을 구성한다.

Phase 2 — **단일** SQL 쿼리로 Phase 1이 해소한 집합을 WHERE 절에 직접 embed해 keyset 페이지네이션
(`(created_at DESC, id DESC)` 복합 정렬 + opaque composite cursor — B3, 아래 참조)한 authz-filtered
페이지를 정확히 반환한다. Python 쪽 authz 필터/재시도 0 — has_more/count는 이 단일 쿼리 결과에서만
계산되므로 §8③④(no pagination oracle)를 SQL 레벨에서 실제로 만족한다. content snippet(doc
title/message content)도 이 쿼리 결과에 자연히 포함되므로 "candidate content를 캐시해뒀다가
나중에 미인가로 판명되면 버리는" 단계 자체가 없다.

B3(같은 `created_at` tie 시 행 영구 손실) 수정: 단일-필드 `created_at`-only cursor(list_messages와
동일 관례)는 같은 timestamp에 여러 mention이 있으면 페이지 경계에서 일부가 영구 드롭될 수 있다.
이 모듈은 **의도적으로 list_messages의 관례와 다르게** `(created_at, id)` 복합 keyset +
opaque base64 cursor(`encode_cursor`/`decode_cursor` — 클라이언트는 완전 불투명 토큰으로만 취급,
서버만 디코드)를 쓴다. list_messages의 동형 tie-loss 갭은 이미 배포된 더 큰 blast-radius
엔드포인트라 이 story 스코프 밖(별도 트래킹) — PR 본문에 명시.

`created_by` 노출(Extra): mention.created_by는 raw UUID가 아니라 `sender`와 동일하게
`lookup_members_by_ids`로 해소한 `{id, name, type}` 요약(또는 미해소 시 null)으로 반환한다
(org 스코프 없는 raw UUID 노출은 그 자체로 정보 노출 리스크 — FE 미소비 확인, git log에
apps/web 소비 코드 없음. sender 필드와 동형 처리로 일관성 유지, 필드 자체는 유지).

no-oracle 불변식(§8④): 미인가 target doc은 이 모듈 호출 전(docs.py 라우트가 404)에 이미
걸러진다. source 미인가 mention은 Phase 2 쿼리의 WHERE 절 자체에서 걸러진다(반환 행에
아예 존재하지 않음) — has_more/next_cursor 어디에도 "몇 개가 걸러졌는지"가 드러나지 않는다.
unknown source_type은 fail-closed 제외(WHERE의 두 OR 분기 중 어느 쪽에도 매치되지 않음).
snippet은 항상 read-time 계산(mentions 테이블에 저장 안 함 — 영구 비정규화 금지).
"""
from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import and_, or_, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext
from app.models.conversation import ConversationMessage
from app.models.doc import Doc
from app.models.mention import Mention
from app.services.member_resolver import lookup_members_by_ids
from app.services.project_auth import accessible_project_ids_in_org

_SNIPPET_MAX = 160


def build_content_snippet(text_value: str, max_len: int = _SNIPPET_MAX) -> str:
    """공백/개행 정규화 후 max_len 글자로 절삭(+ ellipsis). read-time 계산(순수 함수) —
    mentions 테이블에 저장하지 않는다(§8④ no permanent snippet denormalization)."""
    normalized = " ".join((text_value or "").split())
    if len(normalized) <= max_len:
        return normalized
    return normalized[:max_len].rstrip() + "…"


def encode_cursor(created_at: datetime, id_: uuid.UUID) -> str:
    """story #1994 B3: opaque composite keyset cursor — `(created_at, id)` 둘 다 인코드해
    같은 `created_at`을 가진 여러 mention이 페이지 경계에서 영구 드롭되지 않도록 한다.
    클라이언트는 이 토큰을 절대 파싱하지 않고(불투명) 그대로 다음 요청의 `before`에 되돌려준다."""
    payload = {"created_at": created_at.isoformat(), "id": str(id_)}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_cursor(token: str) -> tuple[datetime, uuid.UUID]:
    """`encode_cursor`의 역함수. 손상/변조된 토큰은 400(Invalid cursor format) — 파싱 실패를
    500으로 흘리지 않는다."""
    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii"))
        payload = json.loads(raw)
        return datetime.fromisoformat(payload["created_at"]), uuid.UUID(str(payload["id"]))
    except Exception as exc:  # noqa: BLE001 — 모든 파싱 실패를 균일하게 400으로 정규화
        raise HTTPException(status_code=400, detail="Invalid cursor format") from exc


async def _resolve_readable_conversation_ids(
    db: AsyncSession,
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    auth: AuthContext,
) -> set[uuid.UUID]:
    """Phase 1b: 이 target doc을 멘션한 적 있는 chat_message source의 distinct conversation_id
    **전량**(윈도우/캡/라운드 없음 — 이 특정 target doc에 대한 완전한 candidate 집합, client에
    노출되지 않는 내부 계산이라 그 자체로는 oracle이 될 수 없다) 조회 후, B1-하드닝된
    `_can_read_conversation`을 conversation_id당 정확히 1회 호출해 readable set을 구성한다.
    round-cap/give-up 없음 — B2가 고치는 정확히 그 지점(더 이상 "몇 라운드에서 멈추는가"가
    없다)."""
    from app.routers.conversations import _can_read_conversation  # lazy: 순환 import 회피(기존 관례)

    rows = (await db.execute(
        text(
            """
            SELECT DISTINCT cm.conversation_id
            FROM mentions m
            JOIN conversation_messages cm ON cm.id = m.source_id
            WHERE m.org_id = :org_id
              AND m.target_type = 'doc'
              AND m.target_id = :doc_id
              AND m.source_type = 'chat_message'
            """
        ),
        {"org_id": org_id, "doc_id": doc_id},
    )).scalars().all()
    conv_ids = {uuid.UUID(str(r)) for r in rows}

    readable: set[uuid.UUID] = set()
    for conv_id in conv_ids:
        if await _can_read_conversation(conv_id, db, auth, org_id):
            readable.add(conv_id)
    return readable


async def list_doc_backlinks(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    auth: AuthContext,
    limit: int,
    cursor: str | None,
) -> dict:
    """GET /api/v2/docs/{id}/backlinks 코어. 호출부(docs.py)가 target doc 접근을 이미 검증했다는
    전제(§8① target read access는 별도·기존 라우트 책임) — 여기선 source 접근만 mention 행
    단위로 판정한다.

    반환: `{"data": [...], "meta": {"next_cursor": str|None, "has_more": bool}}` — list_messages와
    동일 shape(AC1 "same convention"). data 항목: {id, source_type, source_id, created_by,
    created_at, doc: {id,title}|None, message: {id,conversation_id,content_snippet,sender}|None}.
    `created_by`는 raw UUID가 아니라 `{id,name,type}`|None(sender와 동형 처리 — Extra fix).
    `next_cursor`는 opaque composite base64 토큰(B3) — `before` query param에 그대로 되돌려준다.
    """
    cursor_key: tuple[datetime, uuid.UUID] | None = None
    if cursor:
        cursor_key = decode_cursor(cursor)

    # ── Phase 1: 요청당 정확히 1회, 전체 인가된 source identity 집합 해소(윈도우/라운드 없음) ──
    uid = uuid.UUID(str(auth.user_id))
    accessible_pids = list(set(await accessible_project_ids_in_org(db, uid, org_id)))
    readable_conv_ids = list(await _resolve_readable_conversation_ids(db, org_id, doc_id, auth))

    # ── Phase 2: 단일 authz-embedded keyset 쿼리 — Python authz filter/retry 0 ──
    # mentions.source_id는 polymorphic(FK 없음: docs.id 또는 conversation_messages.id) —
    # 두 conditional LEFT JOIN으로 각각의 source_type에서만 매치시킨다(§8③ 요구대로
    # WHERE 절에 인가 집합을 직접 embed).
    stmt = (
        select(
            Mention,
            Doc.project_id.label("doc_project_id"),
            Doc.title.label("doc_title"),
            ConversationMessage.conversation_id.label("msg_conversation_id"),
            ConversationMessage.content.label("msg_content"),
            ConversationMessage.sender_id.label("msg_sender_id"),
        )
        .select_from(Mention)
        .outerjoin(
            Doc,
            and_(
                Doc.id == Mention.source_id,
                Mention.source_type == "doc",
                Doc.org_id == org_id,
                Doc.deleted_at.is_(None),  # soft-deleted source doc 배제
            ),
        )
        .outerjoin(
            ConversationMessage,
            and_(
                ConversationMessage.id == Mention.source_id,
                Mention.source_type == "chat_message",
            ),
        )
        .where(
            Mention.org_id == org_id,
            Mention.target_type == "doc",
            Mention.target_id == doc_id,
            or_(
                and_(
                    Mention.source_type == "doc",
                    Doc.project_id.in_(accessible_pids),
                ),
                and_(
                    Mention.source_type == "chat_message",
                    ConversationMessage.conversation_id.in_(readable_conv_ids),
                ),
            ),
        )
    )
    if cursor_key is not None:
        cursor_created_at, cursor_id = cursor_key
        stmt = stmt.where(tuple_(Mention.created_at, Mention.id) < tuple_(cursor_created_at, cursor_id))

    stmt = stmt.order_by(Mention.created_at.desc(), Mention.id.desc()).limit(limit + 1)

    rows = (await db.execute(stmt)).all()
    has_more = len(rows) > limit
    page_rows = rows[:limit]

    # 최종 페이지 행에서만 sender/created_by 배치 해소(N+1 없음 — §ⓝ 기존 관례 유지).
    sender_ids = {
        r.msg_sender_id for r in page_rows
        if r.Mention.source_type == "chat_message" and r.msg_sender_id is not None
    }
    creator_ids = {r.Mention.created_by for r in page_rows if r.Mention.created_by is not None}
    member_map = await lookup_members_by_ids(sender_ids | creator_ids, db)

    data: list[dict] = []
    for r in page_rows:
        m = r.Mention
        creator = member_map.get(m.created_by) if m.created_by is not None else None
        item: dict = {
            "id": str(m.id),
            "source_type": m.source_type,
            "source_id": str(m.source_id),
            "created_by": (
                {"id": str(creator.id), "name": creator.name, "type": creator.type}
                if creator is not None else None
            ),
            "created_at": m.created_at.isoformat(),
            "doc": None,
            "message": None,
        }
        if m.source_type == "doc":
            item["doc"] = {"id": str(m.source_id), "title": r.doc_title}
        elif m.source_type == "chat_message":
            sender = member_map.get(r.msg_sender_id) if r.msg_sender_id is not None else None
            item["message"] = {
                "id": str(m.source_id),
                "conversation_id": str(r.msg_conversation_id),
                "content_snippet": build_content_snippet(r.msg_content),
                "sender": (
                    {"id": str(sender.id), "name": sender.name, "type": sender.type}
                    if sender is not None else None
                ),
            }
        data.append(item)

    next_cursor = None
    if has_more and page_rows:
        last_mention = page_rows[-1].Mention
        next_cursor = encode_cursor(last_mention.created_at, last_mention.id)

    return {"data": data, "meta": {"next_cursor": next_cursor, "has_more": has_more}}
