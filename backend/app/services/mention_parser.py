"""story #1993(E-KNOWLEDGE-LINK S1) — mentions write-path 파서. 근본 설계 doc
design-org-knowledge-mentions-backlinks §2.

두 개의 독립된 순수 추출 함수 + 두 개의 DB write 헬퍼로 구성된다:

  · `extract_chat_doc_mention_ids` — 채팅 메시지 content 에서 `[title](entity:doc:<uuid>)`
    토큰(FE `apps/web/src/components/chat/chat-input.tsx` applyEntity 가 만드는 정확한 포맷 —
    `#` 트리거 검색 결과 선택 시 삽입)을 정규식으로 추출한다. 채팅 메시지는 수정 불가 전제라
    파서도 매번 전체를 새로 파싱해 insert-only 로 쓴다(재조정 불필요).
  · `extract_doc_mention_ids` — doc content(HTML — tiptap `editor.getHTML()` 그대로 저장,
    content_format 무관하게 실제 마크업은 HTML)에서 wikiLink(`<span data-type="wikiLink"
    data-doc-id="...">`) 와 pageEmbed(`<div data-page-embed data-doc-id="...">`) 의
    `data-doc-id` attribute 를 추출한다. **정규식이 아닌 `html.parser.HTMLParser` 사용** —
    attribute 순서가 보장되지 않는다는 게 설계 doc 의 근거(mergeAttributes 가 만드는 순서는
    tiptap 내부 구현에 의존하므로 위치 기반 정규식은 취약).

두 함수 모두 malformed 토큰(파싱 실패·잘못된 UUID)은 **조용히 스킵**한다 — 멘션 파싱 실패로
본 메시지/문서 저장 전체가 실패하면 안 된다는 원칙(AC와 별개로, 파서 자체의 malformed-tolerance).
자기참조(target doc == source doc)는 두 write 헬퍼가 공통으로 드롭한다.

story/epic 멘션은 **파싱하지 않는다**(스키마 CHECK 는 여지를 열어두되 이번 스토리는 doc 만 —
과확장 금지). 확장 시 `_CHAT_TOKEN_RE`의 `type` 그룹을 소비하는 분기만 추가하면 된다(현재는
`doc` 타입만 필터링).

기존 `mentioned_ids`(ConversationMessage 컬럼·멤버 알림용) 파이프라인은 이 모듈이 전혀
참조하지 않는다 — 완전히 독립된 병행 경로.
"""
from __future__ import annotations

import re
import uuid
from html.parser import HTMLParser

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.mention import Mention
from app.services.member_resolver import canonicalize_member_id

_UUID_RE = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

# FE `applyEntity`(chat-input.tsx) 가 만드는 정확한 토큰: `[title](entity:<type>:<id>) `.
# title 은 `[...]` 안에 임의 텍스트(escape 없음 — applyEntity 는 asset 경로만 이스케이프한다) ·
# id 는 UUID. type 그룹을 남겨 향후 story/epic 확장 시 재사용 가능하게 하되, 이번엔 doc 만 필터.
_CHAT_TOKEN_RE = re.compile(
    r"\[[^\]]*\]\(entity:(?P<type>[a-z]+):(?P<id>" + _UUID_RE + r")\)"
)


def extract_chat_doc_mention_ids(content: str) -> list[uuid.UUID]:
    """채팅 메시지 content 에서 `entity:doc:<uuid>` 토큰의 doc id 를 순서 보존 + 중복 제거로 추출.

    malformed(정규식 미매치·잘못된 UUID)는 자연히 스킵된다. story/epic 등 다른 entity type
    토큰은 무시(doc 만 스코프)."""
    if not content:
        return []
    seen: set[uuid.UUID] = set()
    result: list[uuid.UUID] = []
    for m in _CHAT_TOKEN_RE.finditer(content):
        if m.group("type") != "doc":
            continue
        try:
            doc_id = uuid.UUID(m.group("id"))
        except (ValueError, AttributeError):
            continue
        if doc_id not in seen:
            seen.add(doc_id)
            result.append(doc_id)
    return result


class _DocMentionHTMLParser(HTMLParser):
    """wikiLink(`span[data-type=wikiLink]`)·pageEmbed(`div[data-page-embed]`) 의 data-doc-id
    attribute 를 순서 무관하게 추출. 정규식 대신 HTMLParser 를 쓰는 이유(설계 doc §2 근거):
    tiptap `mergeAttributes`/`renderHTML` 이 만드는 attribute 순서가 보장되지 않아 위치 기반
    정규식은 attribute 순서가 바뀌면 깨진다 — HTMLParser 는 attrs 를 (name, value) 튜플 리스트로
    주므로 dict 화해 이름으로 조회하면 순서 무관.
    """

    def __init__(self) -> None:
        super().__init__()
        self.doc_ids: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        if tag == "span" and attr_map.get("data-type") == "wikiLink":
            doc_id = attr_map.get("data-doc-id")
            if doc_id:
                self.doc_ids.append(doc_id)
        elif tag == "div" and "data-page-embed" in attr_map:
            doc_id = attr_map.get("data-doc-id")
            if doc_id:
                self.doc_ids.append(doc_id)


def extract_doc_mention_ids(html_content: str) -> list[uuid.UUID]:
    """doc content(HTML) 에서 wikiLink/pageEmbed 의 data-doc-id 를 순서 보존 + 중복 제거로 추출.

    malformed HTML(HTMLParser 가 못 견디는 조각)·malformed UUID 는 조용히 스킵 — 파서 예외로
    전체 doc 저장이 실패하면 안 된다."""
    if not html_content:
        return []
    parser = _DocMentionHTMLParser()
    try:
        parser.feed(html_content)
        parser.close()
    except Exception:
        # HTMLParser 는 malformed 마크업에도 대체로 관대(best-effort recovery)하지만, 방어적으로
        # 예외 자체도 삼킨다 — 여기까지 왔으면 이미 파싱된 partial 결과를 그대로 쓴다(전체 실패 금지).
        pass
    seen: set[uuid.UUID] = set()
    result: list[uuid.UUID] = []
    for raw in parser.doc_ids:
        try:
            doc_id = uuid.UUID(raw)
        except ValueError:
            continue
        if doc_id not in seen:
            seen.add(doc_id)
            result.append(doc_id)
    return result


async def insert_chat_mentions(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    message_id: uuid.UUID,
    content: str,
    created_by: uuid.UUID,
) -> None:
    """채팅 write-path: insert-only(메시지 불변 전제 — 재조정 불필요). 자기참조 개념이 없다
    (source=chat_message, target=doc — 항상 다른 타입). 같은 트랜잭션(caller 의 세션 그대로
    사용·별도 커밋 없음) — 실패 시 예외가 그대로 propagate 되어 caller(메시지 전송 트랜잭션)
    전체가 롤백된다(AC4 원자성)."""
    target_ids = extract_chat_doc_mention_ids(content)
    if not target_ids:
        return
    canonical_created_by = await canonicalize_member_id(created_by, db)
    stmt = pg_insert(Mention).values([
        {
            "id": uuid.uuid4(),
            "org_id": org_id,
            "source_type": "chat_message",
            "source_id": message_id,
            "target_type": "doc",
            "target_id": target_id,
            "created_by": canonical_created_by,
        }
        for target_id in target_ids
    ])
    # UNIQUE(source_type, source_id, target_type, target_id) 방어 — insert-only 전제라 원칙적으로
    # 이 message_id 에 대한 기존 row 는 없지만(신규 메시지), 같은 메시지 안에 동일 doc 을 가리키는
    # 토큰이 두 번 이상 남아도(추출 단계에서 이미 dedupe 하지만 방어적으로) 무해하게 흡수한다.
    stmt = stmt.on_conflict_do_nothing(constraint="uq_mentions_source_target")
    await db.execute(stmt)


async def reconcile_doc_mentions(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    html_content: str,
    created_by: uuid.UUID,
) -> None:
    """doc write-path: diff 기반 reconcile(create/update 공용 — create 는 existing=∅ 이라 순수
    insert 로 귀결). 새 content 에 더 이상 없는 기존 mentions 는 삭제, 새로 생긴 건
    ON CONFLICT DO NOTHING 으로 insert. 자기참조(target doc == source doc)는 드롭.

    같은 트랜잭션(caller 세션 그대로) — 실패 시 예외 propagate 로 caller(doc 저장 트랜잭션)
    전체가 롤백된다(AC4 원자성)."""
    target_ids = {tid for tid in extract_doc_mention_ids(html_content) if tid != doc_id}

    existing_ids = set(
        (
            await db.execute(
                select(Mention.target_id).where(
                    Mention.source_type == "doc",
                    Mention.source_id == doc_id,
                    Mention.target_type == "doc",
                )
            )
        ).scalars().all()
    )

    stale_ids = existing_ids - target_ids
    if stale_ids:
        from sqlalchemy import delete as sa_delete

        await db.execute(
            sa_delete(Mention).where(
                Mention.source_type == "doc",
                Mention.source_id == doc_id,
                Mention.target_type == "doc",
                Mention.target_id.in_(stale_ids),
            )
        )

    new_ids = target_ids - existing_ids
    if new_ids:
        canonical_created_by = await canonicalize_member_id(created_by, db)
        stmt = pg_insert(Mention).values([
            {
                "id": uuid.uuid4(),
                "org_id": org_id,
                "source_type": "doc",
                "source_id": doc_id,
                "target_type": "doc",
                "target_id": target_id,
                "created_by": canonical_created_by,
            }
            for target_id in new_ids
        ])
        stmt = stmt.on_conflict_do_nothing(constraint="uq_mentions_source_target")
        await db.execute(stmt)
