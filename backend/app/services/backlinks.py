"""story #1994(E-KNOWLEDGE-LINK S2) — 백링크 API 인가+페이지네이션 코어. 근본 설계 doc
design-org-knowledge-mentions-backlinks §8.

불변식(§8①): backlink 공개 = can_read(target_doc) AND can_read(source_resource). target 접근은
호출부(docs.py `_require_doc_project_access`)가 이미 검증한다 — 이 모듈은 **source** 접근을
mention 행 단위로 독립 판정한다(target 검사를 source에 상속하지 않는다 — 산티아고 리뷰가
잡은 갭: 멀티프로젝트 org에서 target doc project ≠ source doc project일 수 있다).

## 5회차 pass — 산티아고 Blocker 1(project_access_valid atom 자체가 stale pre-resolved list)

4회차는 top-level 불리언 **구조**(participant∧project_access_valid ∨ ¬human∧admin_bypass_
eligible)를 `conversation_auth.conversation_readable_predicate`로 SSOT화했지만, 그 안의
`project_access_valid` **atom**은 여전히 이 모듈이 메인 statement 실행 **이전**에 별도
`accessible_project_ids_in_org(db, uid, org_id)` SELECT로 Python `set`/`list`로 materialize한
뒤 `Doc.project_id.in_(accessible_pids)`/`Conversation.project_id.in_(accessible_pids)`로
메인 statement에 리터럴 바인딩했다 — "판정 로직의 불리언 구조는 같은 statement·같은 스냅샷
안에서 평가된다"는 4회차의 TOCTOU-by-construction 주장이 top-level 구조에만 해당했지,
`project_access_valid` atom 자체에는 적용되지 않았던 것(그 사전 SELECT와 메인 statement
사이에 grant가 revoke되면 메인 statement는 그 revoke를 못 본다 — 정확히 4회차가 없앴다고
주장한 그 2-phase TOCTOU 클래스가 atom 레벨에서 재발).

fix: `app.services.project_auth.project_access_valid_correlated`(신규) — `has_project_access`의
4-branch WHERE-로직을 `_project_access_predicate`(SSOT)로 뽑아 SQLAlchemy Core `exists()`로
재작성, 리터럴 project_id(has_project_access)든 outer 쿼리의 correlated 컬럼(`Doc.project_id`/
`Conversation.project_id`)이든 **같은 함수**가 컴파일한다(문자열 템플릿 중복 타이핑 없음 —
Core exists()가 컬럼 참조의 정체에 무관하게 동일 로직을 렌더). 이 모듈은 이제 `accessible_
project_ids_in_org`를 전혀 호출하지 않는다 — doc-source·chat-source 양쪽 `project_access_valid`
모두 메인 statement의 WHERE절에 직접 correlate된 EXISTS로 심는다. `admin_bypass_eligible`은
다른 atom(caller-level 사실 — 요청당 1회 사전계산이 4회차 자체 논리로 정당함, staleness
문제 없음 확인)이라 그대로 사전계산 유지.

## 4회차 pass — 산티아고 아키텍처 지적(재구현 자체가 드리프트 원인) 근본수정

3회차의 `_resolve_readable_conversation_ids`는 "conversation을 읽을 수 있는가"를
`conversations.py` `_can_read_conversation`과 **별개로** 처음부터 다시 짠 Python/SQL
조합이었다 — 두 구현이 "동치"라고 docstring으로만 주장했을 뿐, 실제로는 벌크 재구현판의
conversation→project_id 매핑 쿼리에 `Conversation.org_id == org_id` 필터가 없어(Blocker 1)
org-A 휴먼 owner/admin이 org-B의 agent-only 대화 메시지를 admin-bypass로 열람 가능한
cross-org IDOR이 있었다. 산티아고의 진단: "재구현을 반복하는 것 자체가 드리프트 소스"이며,
요구한 fix는 두 가지다.

1. **canonical predicate SSOT화**: `app.services.conversation_auth.conversation_readable_
   predicate`(신규) — participant∧project-access-valid ∨ ¬human-participant∧admin-bypass를
   SQLAlchemy Core 불리언 표현식으로 정확히 한 곳에 박음. `_can_read_conversation`(단건)과
   이 모듈(벌크) **둘 다 같은 함수**를 호출한다(재구현 0).
2. **TOCTOU-by-construction**: "Phase 1 = readable conversation id 집합을 SELECT해 Python
   set으로 materialize" → "Phase 2 = 그 집합을 IN절에 넣어 페이지 SELECT" 2-phase 구조 자체가
   문제였다(두 statement 사이에 revoke가 커밋되면 Phase 2가 stale 집합을 신뢰). 4회차는 그
   predicate를 **메인 SQL 문의 WHERE절에 직접 correlate**해 심는다 — doc-source join·keyset
   pagination과 **같은 단일 statement·같은 스냅샷** 안에서 chat-source 인가까지 평가된다.
   `_resolve_readable_conversation_ids`(구 2-phase 헬퍼)는 이 pass에서 완전히 삭제됐다.

### org-boundary(Blocker 1) 구체 수정

chat_message-source 후보를 만나는 `ConversationMessage` outerjoin 뒤에 `Conversation`을
**한 번 더 outerjoin**하며, 그 ON절에 `Conversation.org_id == org_id`를 명시한다(Doc
outerjoin이 이미 `Doc.org_id == org_id`를 ON절에 두는 것과 동형 — mentions.org_id가 호출자
org라는 사실이 SOURCE 쪽(conversation_messages가 실제로 속한 conversation)의 org까지
보장하지 않는다는 게 Blocker 1의 핵심이었다: mentions는 caller org로 스코프돼 있어도, 그
mentions 행이 가리키는 conversation_messages.id가 **다른 org의 conversation**에 속할 수
있다 — write-path 불변식만 믿지 않고 read-time에 명시 검증). 이 JOIN이 org 불일치로 매치
실패하면 `Conversation.id`가 NULL이 되고, WHERE절의 `Conversation.id.isnot(None)` 가드가
그 행을 chat-source 분기에서 확실히 탈락시킨다(admin-bypass가 이 org 경계를 우회할 방법이
없다 — admin_bypass_eligible도 이 Conversation 조인 결과의 `project_id`를 correlate하므로
join 자체가 실패하면 애초에 평가되지 않는다).

## 캐노니컬 predicate 재사용(재구현 0, §8②)

  · doc source  ⇒ `project_access_valid_correlated(Doc.project_id, ...)`(project_auth.py —
    `has_project_access`와 **같은** `_project_access_predicate` SSOT를 `Doc.project_id`에
    correlate. §5회차부터 사전 bulk SELECT 없음 — 메인 statement 안에서 행마다 correlated
    EXISTS로 평가).
  · chat_message source ⇒ `conversation_auth.conversation_readable_predicate`(위 §4회차
    참조) — `project_access_valid`엔 `project_access_valid_correlated(Conversation.project_id,
    ...)`(doc-source와 동일 SSOT 호출, `Conversation.project_id`에 correlate)를 넘긴다,
    `admin_bypass_eligible`엔 호출부가 요청당 정확히 1회 해소한 caller-level 사실(휴먼=org
    owner/admin bool, 에이전트=owner/admin grant를 가진 project id 집합)을 넘긴다.
    `project_access_valid`는 이제 candidate 개수 N과 무관한 게 아니라 **행마다 correlated
    서브쿼리로 재평가**된다(단일 메인 statement 안에서 — 별도 쿼리/왕복 없음, 아래 Blocker 2
    갱신 참조). `admin_bypass_eligible`만 여전히 요청당 1회 사전계산(다른 atom, staleness
    문제 없음).

## 산티아고 정적분석 Blocker 2(2·3회차, per-conversation timing/query-count oracle) — 근본 해소

2·3회차는 candidate conversation 개수 N에 비례하는 쿼리(윈도우/라운드/per-conversation
`_can_read_conversation` 호출)를 냈다. 4회차는 애초에 "readable conversation id 집합"이라는
개념 자체를 없앴다 — candidate conversation을 나열하는 쿼리조차 존재하지 않는다(메인
statement가 mentions→conversation_messages→conversations JOIN으로 필요한 후보만 이미
스캔한다). §5회차: `accessible_project_ids_in_org` 사전 SELECT까지 제거돼(Blocker 1 fix —
`project_access_valid`가 이제 메인 statement 내부의 correlated EXISTS), 왕복 쿼리 수는 4회차
대비 **1개 더 줄었다**. 요청당 정확히 1회씩만 실행되는 것은: 캐너 신원 해소(`_resolve_member`,
1~2 SELECT), admin-bypass 사실 해소(휴먼= `is_org_owner_or_admin` 1회, 에이전트=owner/admin
grant project id bulk 1회) — 전부 candidate 개수 N과 무관한 고정 쿼리 수(O(1), round-trip 기준).
`project_access_valid`는 더 이상 별도 쿼리가 아니라 메인 페이지 쿼리 1개의 SQL 텍스트 안에
correlated 서브쿼리(EXISTS)로 인라인된다 — PostgreSQL 플래너가 그 서브쿼리를 후보 행마다
재평가하지만, 이는 **네트워크 왕복(round-trip)이 아니라 단일 statement 내부 실행 비용**이므로
"쿼리 수(round-trip count)" O(1) 불변식은 그대로 유지된다(round-trip count와 단일 statement의
내부 SQL 실행 계획 복잡도는 별개 축 — §8③④ no-oracle 불변식은 round-trip/응답 shape 기준이라
영향 없음). 메인 페이지 쿼리 1회 + 최종 페이지 행의 sender/created_by 배치 해소 1회(N+1 없음,
기존 관례 유지)를 더해도 요청당 **round-trip** 쿼리 수는 4회차의 7에서 **6**으로 줄었다(아래
구조적 증명 테스트 참조 — `accessible_project_ids_in_org` 사전 SELECT 소멸분).

Phase 2 SQL — **단일** 쿼리로 인가+doc/chat 두 source-type join+keyset 페이지네이션
(`(created_at DESC, id DESC)` 복합 정렬 + opaque composite cursor — B3, 아래 참조)을 모두
수행한다. Python 쪽 authz 필터/재시도 0 — has_more/count는 이 단일 쿼리 결과에서만
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
걸러진다. source 미인가 mention은 메인 쿼리의 WHERE 절 자체에서 걸러진다(반환 행에
아예 존재하지 않음) — has_more/next_cursor 어디에도 "몇 개가 걸러졌는지"가 드러나지 않는다.
unknown source_type은 fail-closed 제외(WHERE의 두 OR 분기 중 어느 쪽에도 매치되지 않음).
snippet은 항상 read-time 계산(mentions 테이블에 저장 안 함 — 영구 비정규화 금지).

산티아고 정적분석 Blocker 1(org-scope 누락, 3회차) 수정: `created_by`/`message.sender`는 mention/message
행 자체는 org-스코프 쿼리로 이미 안전해도, `created_by`/`sender_id`가 가리키는 member id를
`lookup_members_by_ids`로 해소한 결과는 **caller org 소속인지 검증한 적이 없었다** — 데이터
오손·다른 버그·이상 행 등으로 이 id가 타 org member를 가리키면 그 member의 name/type이 caller
org로 그대로 새는 IDOR이었다(row 자체를 숨기는 게 아니라, row에 붙는 신원 요약만 문제). 수정:
`ResolvedMember.org_id == org_id`(요청의 org)일 때만 `{id,name,type}`을 채우고, 아니면(비-resolve
포함 — `lookup_members_by_ids`의 legacy orphan fallback은 `org_id=uuid.UUID(int=0)`인 placeholder를
반환하므로 이 비교 하나로 "미해소"와 "타org 해소" 둘 다 걸린다) null. mention/backlink 행 자체는
그대로 노출(숨기지 않음 — target/source read access는 이미 별도로 검증됨, 이건 신원 요약만의 문제).
"""
from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import and_, false as sa_false, or_, select, true as sa_true, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext
from app.models.conversation import Conversation, ConversationMessage
from app.models.doc import Doc
from app.models.mention import Mention
from app.models.project import Project
from app.models.project_access import ProjectAccess
from app.services.conversation_auth import conversation_readable_predicate
from app.services.member_resolver import ResolvedMember, lookup_members_by_ids
from app.services.project_auth import (
    is_org_owner_or_admin,
    project_access_valid_correlated,
)

_SNIPPET_MAX = 160


def build_content_snippet(text_value: str, max_len: int = _SNIPPET_MAX) -> str:
    """공백/개행 정규화 후 max_len 글자로 절삭(+ ellipsis). read-time 계산(순수 함수) —
    mentions 테이블에 저장하지 않는다(§8④ no permanent snippet denormalization)."""
    normalized = " ".join((text_value or "").split())
    if len(normalized) <= max_len:
        return normalized
    return normalized[:max_len].rstrip() + "…"


def _member_summary_same_org(resolved: ResolvedMember | None, org_id: uuid.UUID) -> dict | None:
    """산티아고 Blocker 1(3회차): `lookup_members_by_ids`가 해소한 member가 caller org 소속일
    때만 `{id,name,type}` 요약을 노출한다. `resolved`가 None(미해소)이거나 `resolved.org_id !=
    org_id`(타org 해소 — 데이터 오손/이상 mention.created_by·message.sender_id 등)이면 null. 이
    검사 하나로 두 케이스(미해소·타org)가 동시에 걸린다: `lookup_members_by_ids`의 legacy
    orphan fallback은 진짜 미해소 id에도 `org_id=uuid.UUID(int=0)`인 placeholder ResolvedMember를
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


async def _chat_predicate_inputs(
    db: AsyncSession,
    org_id: uuid.UUID,
    auth: AuthContext,
):
    """§4회차: 메인 쿼리의 chat-source WHERE절에 correlate할 `conversation_readable_predicate`
    입력(caller_member_id·admin_bypass_eligible)을 **요청당 정확히 1회**(candidate 개수 N과
    무관, 윈도우/라운드/per-conversation 호출 0 — Blocker 2 근본해소) 해소한다. 이 함수 자체는
    conversation을 단 하나도 조회하지 않는다("readable id 집합"이라는 개념이 이제 없다) — caller
    가 누구인지·admin인지만 O(1)로 알아낸다. 반환값은 그대로 `conversation_readable_predicate`에
    넘겨져 메인 statement의 correlated EXISTS/`.in_()` 표현식으로 컴파일된다.

    §5회차(산티아고 Blocker 1): `project_access_valid` atom은 이 함수가 다루지 않는다 — 그건
    `list_doc_backlinks`가 `project_access_valid_correlated(Conversation.project_id, ...)`를
    메인 statement에 직접 correlate해 심는다(별도 사전 SELECT 없음). 이 함수는 여전히
    admin_bypass_eligible(caller-level 사실, O(1) 사전계산이 정당한 이유는 모듈 docstring 참조)만
    다룬다.

    caller 신원 해소가 실패하면(HTTPException — grant-loss/orphan 등, `_can_read_conversation`의
    "절대 raise하지 않는다" 계약과 동일 정신) `caller_member_id=None`을 반환해 호출부가 chat-source
    분기 자체를 `false()`로 완전히 닫게 한다(doc-source 분기는 전혀 영향받지 않음 — 한 caller
    신원 해소 실패가 전체 응답을 poison하지 않는다는 B1 불변식과 동형)."""
    from app.routers.conversations import _resolve_member  # lazy: 순환 import 회피(기존 관례)

    try:
        sender = await _resolve_member(auth, org_id, db, project_id=None)
    except HTTPException:
        return None, sa_false()
    caller_member_id = sender.id

    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        # 에이전트: org 내에서 caller가 owner/admin grant를 가진 project id 집합 — 단일 bulk
        # 쿼리(candidate 개수 무관). `Project.org_id == org_id`로 명시 스코프(Blocker 1과 동일
        # 원칙 — grant 자체는 write-path 불변식상 항상 같은 org겠지만, read-time에도 명시
        # 검증해 "쓰기 경로만 믿지 않는다"는 이 story의 반복 교훈을 여기도 적용).
        admin_pid_rows = (await db.execute(
            select(ProjectAccess.project_id)
            .select_from(ProjectAccess)
            .join(Project, Project.id == ProjectAccess.project_id)
            .where(
                ProjectAccess.member_id == caller_member_id,
                ProjectAccess.role.in_(("owner", "admin")),
                ProjectAccess.permission == "granted",
                Project.org_id == org_id,
            )
            .distinct()
        )).scalars().all()
        admin_project_ids = {uuid.UUID(str(r)) for r in admin_pid_rows}
        admin_bypass_eligible = (
            Conversation.project_id.in_(admin_project_ids) if admin_project_ids else sa_false()
        )
    else:
        # 휴먼: org owner/admin 여부 — 단일 org-wide bool(project 무관, candidate 개수 무관).
        caller_is_org_admin = await is_org_owner_or_admin(db, uuid.UUID(str(auth.user_id)), org_id)
        admin_bypass_eligible = sa_true() if caller_is_org_admin else sa_false()

    return caller_member_id, admin_bypass_eligible


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

    # ── 요청당 정확히 1회, candidate 개수 N과 무관하게 해소하는 caller-level 사실(admin-bypass) ──
    # §5회차(산티아고 Blocker 1): `project_access_valid`는 더 이상 여기서 사전 SELECT/materialize
    # 하지 않는다 — `project_access_valid_correlated(...)`를 메인 statement의 WHERE절에 직접
    # correlate해 심는다(아래 stmt 참조). caller-level admin-bypass 사실만 O(1) 사전계산(round 4
    # 근거 그대로 — 별개 atom, staleness 문제 없음: admin 여부는 project별 project_access_valid와
    # 달리 room/grant revoke 타이밍에 좌우되지 않는 caller 신원 사실).
    uid = uuid.UUID(str(auth.user_id))

    caller_member_id, admin_bypass_eligible = await _chat_predicate_inputs(db, org_id, auth)
    if caller_member_id is None:
        chat_predicate = sa_false()
    else:
        chat_predicate = conversation_readable_predicate(
            Conversation.id,
            caller_member_id=caller_member_id,
            # §5회차 Blocker 1 fix: 별도 사전 SELECT로 만든 project id 집합의 `.in_()` 멤버십이
            # 아니라, 메인 statement와 **같은 스냅샷**에서 평가되는 correlated EXISTS(doc-source의
            # `project_access_valid_correlated(Doc.project_id, ...)`와 동일 SSOT 호출) —
            # TOCTOU-by-construction을 project_access_valid atom에도 적용.
            project_access_valid=project_access_valid_correlated(
                Conversation.project_id, caller_id=uid, org_id=org_id,
            ),
            admin_bypass_eligible=admin_bypass_eligible,
        )

    # ── 단일 authz-embedded keyset 쿼리 — Python authz filter/retry 0, 2-phase 없음 ──
    # mentions.source_id는 polymorphic(FK 없음: docs.id 또는 conversation_messages.id) —
    # 두 conditional LEFT JOIN(+ chat-source는 Conversation까지 세 번째 LEFT JOIN)으로 각각의
    # source_type에서만 매치시킨다. Conversation JOIN의 ON절 `Conversation.org_id == org_id`가
    # Blocker 1(org-scope 누락) fix — Doc JOIN의 `Doc.org_id == org_id`와 동형. §8③ 요구대로
    # 인가 predicate(doc: accessible_pids 멤버십, chat: conversation_readable_predicate)를
    # WHERE 절에 직접 embed한다(별도 SELECT로 먼저 집합을 만들지 않음 — TOCTOU-by-construction).
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
        .outerjoin(
            Conversation,
            and_(
                Conversation.id == ConversationMessage.conversation_id,
                Conversation.org_id == org_id,  # ⭐ Blocker 1(4회차): org 경계 명시 검증
            ),
        )
        .where(
            Mention.org_id == org_id,
            Mention.target_type == "doc",
            Mention.target_id == doc_id,
            or_(
                and_(
                    Mention.source_type == "doc",
                    # §5회차 Blocker 1 fix: 사전 IN-list가 아니라 correlated EXISTS(같은 statement
                    # ·같은 스냅샷 — 위 chat-source project_access_valid와 동일 SSOT 호출).
                    project_access_valid_correlated(Doc.project_id, caller_id=uid, org_id=org_id),
                ),
                and_(
                    Mention.source_type == "chat_message",
                    # org join이 매치 실패하면(다른 org 소속 conversation) Conversation.id가
                    # NULL — 이 가드가 그 행을 admin-bypass 포함 어떤 경로로도 확실히 탈락시킨다.
                    Conversation.id.isnot(None),
                    chat_predicate,
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
