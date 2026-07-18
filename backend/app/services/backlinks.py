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
  · chat_message source ⇒ `_resolve_readable_conversation_ids`(아래) — `_can_read_conversation`
    (conversations.py, `_authorize_message_read`에서 추출한 canonical bool 술어)과 **동치인
    판정 논리**(participant ∪ admin-bypass(휴먼 참가 시 carve-out))를 고정 개수 bulk 쿼리로
    재구성한다(산티아고 Blocker 2 — 아래 참조). `_can_read_conversation` 자체는 원래 단건
    호출부(list_messages/get_message 등)를 위해 그대로 유지하며, 이 hot path에서는 더 이상
    호출하지 않는다.

산티아고 sabotage-probe 재구현(B2 근본원인 수정, 2회차 pass): 최초 draft는 "후보 윈도우 fetch →
Python authz filter → 부족하면 최대 5라운드 refetch" 패턴을 썼다 — has_project_access/participant
판정을 raw SQL로 재구현하면 드리프트 소스가 된다는 이유로 의도적으로 선택했으나, 이 추론이
틀렸다: bounded retry loop 자체가 "몇 라운드에서 멈추는가"가 숨은 미인가 행 개수에 의존하는
oracle-shaped 동작이다(§8③ "authz-before-pagination, SQL/WHERE 레벨, bounded Python retry
loop 아님" 요구를 DRY 우려와 맞바꾼 것 — 잘못된 트레이드오프). 2회차 pass는 이를 "distinct
conversation_id당 `_can_read_conversation` 정확히 1회" 호출로 고쳤으나(round-cap 제거), 이것도
정적분석에서 잡혔다(Blocker 2, 3회차 pass) — per-conversation 호출 자체가 여전히 hidden
conversation 개수 N에 선형 비례하는 쿼리 카운트를 내는 query-count/timing oracle이었다(content는
안 새도 존재 개수가 샌다). 최종 아키텍처(2-phase, 윈도우/라운드/per-conversation-loop 0):

Phase 1 — 요청당 **정확히 1회**, 페이지 무관하게 전체 인가된 source identity 집합을 해소한다:
  · doc: `accessible_project_ids_in_org`(SSOT bulk 헬퍼) 1회 호출 → `accessible_pids` 집합.
  · chat_message: `_resolve_readable_conversation_ids`(아래 정의 — candidate 개수 N과 무관한
    고정 개수(~4개) bulk 쿼리) → `readable_conv_ids` 집합.

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

산티아고 정적분석 Blocker 1(org-scope 누락) 수정: `created_by`/`message.sender`는 mention/message
행 자체는 org-스코프 쿼리로 이미 안전해도, `created_by`/`sender_id`가 가리키는 member id를
`lookup_members_by_ids`로 해소한 결과는 **caller org 소속인지 검증한 적이 없었다** — 데이터
오손·다른 버그·이상 행 등으로 이 id가 타 org member를 가리키면 그 member의 name/type이 caller
org로 그대로 새는 IDOR이었다(row 자체를 숨기는 게 아니라, row에 붙는 신원 요약만 문제). 수정:
`ResolvedMember.org_id == org_id`(요청의 org)일 때만 `{id,name,type}`을 채우고, 아니면(비-resolve
포함 — `lookup_members_by_ids`의 legacy orphan fallback은 `org_id=uuid.UUID(int=0)`인 placeholder를
반환하므로 이 비교 하나로 "미해소"와 "타org 해소" 둘 다 걸린다) null. mention/backlink 행 자체는
그대로 노출(숨기지 않음 — target/source read access는 이미 별도로 검증됨, 이건 신원 요약만의 문제).

산티아고 정적분석 Blocker 2(per-conversation timing/query-count oracle) 수정: `_resolve_readable_
conversation_ids`는 과거 distinct candidate conversation마다 `_can_read_conversation`을 1회씩
호출했다 — 쿼리 수(및 지연)가 "이 doc을 멘션한 적 있는 숨겨진/미인가 conversation 개수"에
선형 비례해, content는 안 새도 존재 개수를 타이밍/쿼리-카운트로 추론 가능한 oracle이었다. 이제
고정 개수(~4개) bulk 쿼리로 재구현 — candidate 개수 N과 무관하게 O(1). 판정 논리는
`_can_read_conversation`과 동치(participant ∪ admin-bypass(휴먼 참가 시 carve-out)) — 다만
per-conversation 루프 없이 집합 연산으로 계산한다. `_can_read_conversation` 자체는 원래 단건
호출부(list_messages/get_message 등)를 위해 그대로 유지 — 이 hot path에서는 더 이상 쓰지 않는다.
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
from app.models.conversation import Conversation, ConversationParticipant, ConversationMessage
from app.models.doc import Doc
from app.models.mention import Mention
from app.models.project_access import ProjectAccess
from app.services.member_resolver import ResolvedMember, lookup_members_by_ids
from app.services.project_auth import accessible_project_ids_in_org, is_org_owner_or_admin

_SNIPPET_MAX = 160


def build_content_snippet(text_value: str, max_len: int = _SNIPPET_MAX) -> str:
    """공백/개행 정규화 후 max_len 글자로 절삭(+ ellipsis). read-time 계산(순수 함수) —
    mentions 테이블에 저장하지 않는다(§8④ no permanent snippet denormalization)."""
    normalized = " ".join((text_value or "").split())
    if len(normalized) <= max_len:
        return normalized
    return normalized[:max_len].rstrip() + "…"


def _member_summary_same_org(resolved: ResolvedMember | None, org_id: uuid.UUID) -> dict | None:
    """산티아고 Blocker 1: `lookup_members_by_ids`가 해소한 member가 caller org 소속일 때만
    `{id,name,type}` 요약을 노출한다. `resolved`가 None(미해소)이거나 `resolved.org_id != org_id`
    (타org 해소 — 데이터 오손/이상 mention.created_by·message.sender_id 등)이면 null. 이 검사
    하나로 두 케이스(미해소·타org)가 동시에 걸린다: `lookup_members_by_ids`의 legacy orphan
    fallback은 진짜 미해소 id에도 `org_id=uuid.UUID(int=0)`인 placeholder ResolvedMember를
    반환하므로, `resolved is not None`만으로는 미해소를 걸러내지 못한다 — org_id 비교가
    유일한 안전 게이트. 이 함수는 mention/backlink **행 자체**는 절대 숨기지 않는다(그건
    target/source read access가 이미 판정) — 신원 요약 필드 하나만 null 처리한다."""
    if resolved is None or resolved.org_id != org_id:
        return None
    return {"id": str(resolved.id), "name": resolved.name, "type": resolved.type}


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
    accessible_pids: set[uuid.UUID],
) -> set[uuid.UUID]:
    """Phase 1b(산티아고 Blocker 2 재구현): 이 target doc을 멘션한 적 있는 chat_message source의
    distinct conversation_id **전량**(윈도우/캡/라운드 없음 — client에 노출되지 않는 내부 계산이라
    그 자체로는 oracle이 될 수 없다)을 조회한 뒤, `_can_read_conversation`과 동치인 판정
    (participant ∪ admin-bypass(휴먼 참가 시 private carve-out))을 **candidate 개수 N과 무관한
    고정 개수(~4개) bulk 쿼리**로 계산한다 — per-conversation 루프(구 구현)는 hidden/미인가
    conversation 개수에 선형 비례하는 쿼리 카운트/지연을 냈다(query-count·timing amplification
    oracle). 이 함수는 그 자리를 정확히 고친다:

      쿼리 1: candidate 중 caller가 참가자인 conversation_id(raw participant row).
      쿼리 2: `_conversations_with_human_participant`(conversations.py, 이미 batched) 재사용 —
              candidate 중 휴먼 참가자가 있는 conversation_id(human_conv_ids). 나머지
              (agent-only) 만 admin-bypass 후보.
      쿼리 3: candidate 전체의 conversation_id → project_id 매핑(참가자 재검증 + admin-bypass
              해소 양쪽에 공용).
      쿼리 4: 휴먼 caller ⇒ org owner/admin 여부(단일 org-wide bool, `accessible_project_ids_in_org`
              4번째 EXISTS 분기와 동형 — project 무관 전체접근). 에이전트(API키) caller ⇒
              agent-only candidate가 걸친 distinct project 중 caller가 owner/admin grant를 가진
              project 집합(project 개수 무관 단일 쿼리, `get_project_role`의 에이전트 proj_role
              분기와 동형).

    참가자 재검증(B1 grant-loss와 정합 — 신규 쿼리 없음, `accessible_pids` 재사용): 원래
    `_can_read_conversation`의 participant 분기는 raw participant row만 보지 않는다 —
    `_resolve_member(project_id=conv_project_id)`로 **그 project에 대한 현재 접근**을 다시
    확인하고, 접근이 없으면(project_access 회수 등) raise → False로 정규화된다. 즉 참가자
    행이 남아있어도(참가 당시 스냅샷 — grant 회수로 자동 정리되지 않는다) 현재 project 접근이
    없으면 읽을 수 없다. 이 bulk 버전은 같은 결론을 새 쿼리 없이 낸다: `list_doc_backlinks`가
    doc-source 해소용으로 이미 계산해둔 `accessible_pids`(`accessible_project_ids_in_org` —
    `has_project_access`와 동일 3-branch SSOT의 bulk 형태)를 그대로 재사용해, raw participant
    conversation을 그 conversation의 project가 `accessible_pids`에 있을 때만 최종 채택한다.

    이후는 순수 Python 집합 연산(DB 호출 0) — `_can_read_conversation` 자체는 원래 단건 호출부
    (list_messages/get_message 등)를 위해 그대로 유지하며, 이 hot path에서는 더 이상 호출하지
    않는다."""
    from app.routers.conversations import (  # lazy: 순환 import 회피(기존 관례)
        _conversations_with_human_participant,
        _resolve_member,
    )

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
    candidate_ids = {uuid.UUID(str(r)) for r in rows}
    if not candidate_ids:
        return set()
    candidate_list = list(candidate_ids)

    # caller 신원 해소(org-level, project 무관) — `_can_read_conversation`의 첫 `_resolve_member`
    # 호출과 동형. grant-loss/orphan 등으로 신원 해소 자체가 실패하면 fail-closed(readable 0) —
    # `_can_read_conversation`의 "절대 raise하지 않는다" 계약을 이 bulk 버전에도 보존한다.
    try:
        sender = await _resolve_member(auth, org_id, db, project_id=None)
    except HTTPException:
        return set()
    caller_member_id = sender.id

    # ── 쿼리 1: candidate 중 caller가 참가자인 conversation(raw — 아래서 accessible_pids로 재검증) ──
    participant_rows = (await db.execute(
        select(ConversationParticipant.conversation_id)
        .where(
            ConversationParticipant.conversation_id.in_(candidate_list),
            ConversationParticipant.member_id == caller_member_id,
        )
        .distinct()
    )).scalars().all()
    participant_conv_ids_raw = {uuid.UUID(str(r)) for r in participant_rows}

    # ── 쿼리 2(재사용, 이미 batched): 휴먼 참가자가 있는 candidate ──
    human_conv_ids = await _conversations_with_human_participant(candidate_list, db)
    agent_only_candidates = candidate_ids - human_conv_ids

    # ── 쿼리 3: candidate 전체의 conversation_id → project_id 매핑 ──
    proj_rows = (await db.execute(
        select(Conversation.id, Conversation.project_id)
        .where(Conversation.id.in_(candidate_list))
    )).all()
    conv_project_map = {uuid.UUID(str(cid)): uuid.UUID(str(pid)) for cid, pid in proj_rows}

    # participant 최종 채택 = raw participant row ∩ (그 project에 caller의 현재 접근이 있음).
    participant_conv_ids = {
        cid for cid in participant_conv_ids_raw
        if conv_project_map.get(cid) in accessible_pids
    }

    if not agent_only_candidates:
        return participant_conv_ids

    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    admin_bypass_conv_ids: set[uuid.UUID] = set()

    if is_api_key:
        # ── 쿼리 4(에이전트): agent-only candidate가 걸친 distinct project 중 caller가
        # owner/admin grant를 가진 project 집합 — project 개수 무관 단일 쿼리.
        distinct_project_ids = list({
            conv_project_map[cid] for cid in agent_only_candidates if cid in conv_project_map
        })
        if distinct_project_ids:
            admin_pid_rows = (await db.execute(
                select(ProjectAccess.project_id)
                .where(
                    ProjectAccess.member_id == caller_member_id,
                    ProjectAccess.project_id.in_(distinct_project_ids),
                    ProjectAccess.role.in_(("owner", "admin")),
                    ProjectAccess.permission == "granted",
                )
                .distinct()
            )).scalars().all()
            admin_project_ids = {uuid.UUID(str(r)) for r in admin_pid_rows}
            admin_bypass_conv_ids = {
                cid for cid in agent_only_candidates
                if conv_project_map.get(cid) in admin_project_ids
            }
    else:
        # ── 쿼리 4(휴먼): org owner/admin은 project 무관 org-wide 단일 boolean.
        if await is_org_owner_or_admin(db, uuid.UUID(str(auth.user_id)), org_id):
            admin_bypass_conv_ids = set(agent_only_candidates)

    return participant_conv_ids | admin_bypass_conv_ids


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
    accessible_pids_set = set(await accessible_project_ids_in_org(db, uid, org_id))
    accessible_pids = list(accessible_pids_set)
    readable_conv_ids = list(
        await _resolve_readable_conversation_ids(db, org_id, doc_id, auth, accessible_pids_set)
    )

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
            "created_by": _member_summary_same_org(creator, org_id),
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
                "sender": _member_summary_same_org(sender, org_id),
            }
        data.append(item)

    next_cursor = None
    if has_more and page_rows:
        last_mention = page_rows[-1].Mention
        next_cursor = encode_cursor(last_mention.created_at, last_mention.id)

    return {"data": data, "meta": {"next_cursor": next_cursor, "has_more": has_more}}
