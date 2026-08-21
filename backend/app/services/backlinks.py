"""story #1994(E-KNOWLEDGE-LINK S2) — 백링크 API 인가+페이지네이션 코어. 근본 설계 doc
design-org-knowledge-mentions-backlinks §8.

불변식(§8①): backlink 공개 = can_read(target_doc) AND can_read(source_resource). target 접근은
호출부(docs.py `_require_doc_project_access`)가 이미 검증한다 — 이 모듈은 **source** 접근을
mention 행 단위로 독립 판정한다(target 검사를 source에 상속하지 않는다 — 산티아고 리뷰가
잡은 갭: 멀티프로젝트 org에서 target doc project ≠ source doc project일 수 있다).

## 6회차(마지막 atom) pass — 산티아고 잔여 지적: admin_bypass_eligible도 같은 버그 클래스였다

5회차는 `project_access_valid` atom을 pre-resolve(사전 SELECT → Python 값 → 메인 statement
리터럴 바인딩)에서 correlated EXISTS로 전환했지만, `admin_bypass_eligible` atom은 "caller-level
사실이라 staleness 문제 없음"이라는 이유로 그대로 뒀다. 산티아고 6회차(라운드5) 리뷰: 그 판단
자체가 틀렸다 — `admin_bypass_eligible`도 정확히 같은 "사전 SELECT → 메인 statement 실행
사이의 revoke 윈도우" TOCTOU 클래스다. 휴먼 분기는 `is_org_owner_or_admin` 1회 SELECT 결과를
`sa_true()`/`sa_false()` 상수로 굳혀 메인 statement에 넘겼고(그 사이 org role이 회수되면 메인
statement는 못 봄), 에이전트 분기는 owner/admin project grant id 집합을 bulk SELECT로
materialize해 `Conversation.project_id.in_(admin_project_ids)`로 리터럴 바인딩했다(그 사이 grant가
회수되면 마찬가지로 못 봄) — project_access_valid가 5회차 이전에 갖고 있던 것과 완전히 동형인
2-phase 구조.

fix: `app.services.project_auth.org_admin_valid_correlated`(휴먼)·`project_admin_valid_correlated`
(에이전트, 신규) — 둘 다 SQLAlchemy Core `exists()`로, 메인 statement의 WHERE절에 직접
correlate할 수 있는 표현식을 반환한다(사전 SELECT 0회). `_chat_predicate_inputs`는 이제
`caller_member_id`·`is_api_key`만 O(1)로 해소하고, 실제 `admin_bypass_eligible` correlated
표현식 조립은 `list_doc_backlinks`(메인 쿼리 조립부, `Conversation.project_id` outer 컬럼에
접근 가능한 유일한 지점)가 담당한다 — caller가 human XOR agent이므로 `is_api_key`로 어느
correlated 표현식을 쓸지만 분기하고, 분기된 표현식 자체는 항상 correlated(pre-resolve 0).

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
5회차 당시엔 "다른 atom(caller-level 사실) — staleness 문제 없음"이라 판단해 그대로
사전계산(요청당 1회 SELECT → bool/`.in_()` 리터럴 바인딩)을 유지했다 — **이 판단은 6회차에서
산티아고가 틀렸다고 지적**했고(정확히 같은 pre-resolve TOCTOU 클래스), 6회차 pass가
`admin_bypass_eligible`도 correlated EXISTS로 전환했다(위 §6회차 참조 — 이 문단은 5회차
시점의 판단을 역사적으로 남겨두되, 실제 최신 동작은 §6회차가 SSOT).

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
    `admin_bypass_eligible`엔 §6회차부터 `org_admin_valid_correlated`(휴먼)/
    `project_admin_valid_correlated`(에이전트, `Conversation.project_id`에 correlate)를 넘긴다
    (5회차까지는 호출부가 요청당 1회 사전 해소한 caller-level bool/`.in_()` 멤버십이었으나,
    6회차가 이것도 correlated EXISTS로 전환 — 위 §6회차 참조).
    `project_access_valid`/`admin_bypass_eligible` **둘 다** 이제 candidate 개수 N과 무관한 게
    아니라 **행마다 correlated 서브쿼리로 재평가**된다(단일 메인 statement 안에서 — 별도
    쿼리/왕복 없음, 아래 Blocker 2 갱신 참조). caller 신원 해소(`_resolve_member`)만 여전히
    요청당 1회 사전 해소(pre-resolve 대상이 "caller가 누구인가"이지 "그 caller가 지금
    권한이 있는가"가 아니라 staleness 문제 자체가 없음 — 신원은 요청 도중 바뀌지 않는다).

## 산티아고 정적분석 Blocker 2(2·3회차, per-conversation timing/query-count oracle) — 근본 해소

2·3회차는 candidate conversation 개수 N에 비례하는 쿼리(윈도우/라운드/per-conversation
`_can_read_conversation` 호출)를 냈다. 4회차는 애초에 "readable conversation id 집합"이라는
개념 자체를 없앴다 — candidate conversation을 나열하는 쿼리조차 존재하지 않는다(메인
statement가 mentions→conversation_messages→conversations JOIN으로 필요한 후보만 이미
스캔한다). §5회차: `accessible_project_ids_in_org` 사전 SELECT까지 제거돼(Blocker 1 fix —
`project_access_valid`가 이제 메인 statement 내부의 correlated EXISTS), 왕복 쿼리 수는 4회차
대비 **1개 더 줄었다**(4회차의 7 → 5회차의 6 — admin-bypass 사실 해소는 이 시점까지도 여전히
요청당 1회 사전 SELECT였다: 휴먼= `is_org_owner_or_admin` 1회, 에이전트=owner/admin grant
project id bulk 1회).

§6회차(마지막 atom): `admin_bypass_eligible`도 correlated EXISTS로 전환되며 그 사전 SELECT
1회가 **추가로 사라졌다** — 왕복 쿼리 수는 5회차의 6에서 **5**로 줄었다(아래 구조적 증명
테스트 참조). 요청당 정확히 1회씩만 실행되는 것은 이제 caller 신원 해소(`_resolve_member`,
1~2 SELECT)뿐이다 — admin 여부·project 접근 가능 여부 둘 다 더 이상 별도 SELECT가 아니라
메인 페이지 쿼리 1개의 SQL 텍스트 안에 correlated 서브쿼리(EXISTS)로 인라인된다.
PostgreSQL 플래너가 그 서브쿼리들을 후보 행마다 재평가하지만, 이는 **네트워크 왕복
(round-trip)이 아니라 단일 statement 내부 실행 비용**이므로 "쿼리 수(round-trip count)" O(1)
불변식은 그대로 유지된다(round-trip count와 단일 statement의 내부 SQL 실행 계획 복잡도는
별개 축 — §8③④ no-oracle 불변식은 round-trip/응답 shape 기준이라 영향 없음). 메인 페이지
쿼리 1회 + 최종 페이지 행의 sender/created_by 배치 해소 1회(N+1 없음, 기존 관례 유지)를
더해도 요청당 **round-trip** 쿼리 수는 5회차의 6에서 **5**로 줄었다(아래 구조적 증명 테스트
참조 — admin-bypass 사실 사전 SELECT 소멸분. `docs.py` 라우터 레벨의 target doc 조회 1회 +
`has_project_access` target 인가 1회를 포함한 전체 엔드포인트 기준으로는 6회차의 5회는
5회차의 6회 대비 1회 감소).

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

import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import and_, false as sa_false, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import decode_cursor, encode_cursor
from app.dependencies.auth import AuthContext
from app.models.conversation import Conversation, ConversationMessage
from app.models.doc import Doc
from app.models.meeting import Meeting
from app.models.pm import Story
from app.models.reference import Reference
from app.models.visual_artifact import VisualArtifact
from app.services.conversation_auth import conversation_readable_predicate
from app.services.member_resolver import ResolvedMember, lookup_members_by_ids
from app.services.project_auth import (
    org_admin_valid_correlated,
    project_access_valid_correlated,
    project_admin_valid_correlated,
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



async def _chat_predicate_inputs(
    db: AsyncSession,
    org_id: uuid.UUID,
    auth: AuthContext,
):
    """§6회차(마지막 atom): 메인 쿼리의 chat-source WHERE절에 correlate할
    `conversation_readable_predicate` 입력 중 caller 신원(`caller_member_id`)과 caller 종류
    (`is_api_key`)만 **요청당 정확히 1회**(candidate 개수 N과 무관, 윈도우/라운드/
    per-conversation 호출 0 — Blocker 2 근본해소) 해소한다. 이 함수 자체는 conversation을 단
    하나도 조회하지 않는다("readable id 집합"이라는 개념이 이제 없다).

    §5회차(산티아고 Blocker 1): `project_access_valid` atom은 이 함수가 다루지 않는다 — 그건
    `list_doc_backlinks`가 `project_access_valid_correlated(Conversation.project_id, ...)`를
    메인 statement에 직접 correlate해 심는다(별도 사전 SELECT 없음).

    §6회차(마지막 atom, 산티아고 라운드5 리뷰 잔여 지적): `admin_bypass_eligible` atom도 이
    함수가 더 이상 다루지 않는다 — 예전엔 여기서 휴먼=`is_org_owner_or_admin` 1회 SELECT,
    에이전트=owner/admin grant project id 집합 bulk SELECT 1회로 **사전 계산**해 bool
    리터럴/`.in_()` 멤버십으로 메인 statement에 바인딩했다(project_access_valid와 정확히 같은
    "pre-resolve → 메인 statement 리터럴 바인딩" TOCTOU 클래스가 admin_bypass_eligible atom에
    남아 있었다 — 5회차가 project_access_valid에서 근절한 것과 동형 갭, 마지막 남은 atom).
    이제 이 함수는 `is_api_key`만 반환하고, 실제 `admin_bypass_eligible` correlated 표현식
    조립은 `Conversation.project_id`(outer 쿼리 컬럼 — 이 함수 스코프엔 없음)가 필요해
    `list_doc_backlinks`(메인 쿼리 조립부)가 `org_admin_valid_correlated`/
    `project_admin_valid_correlated`를 직접 호출한다(사전 SELECT 0회).

    caller 신원 해소가 실패하면(HTTPException — grant-loss/orphan 등, `_can_read_conversation`의
    "절대 raise하지 않는다" 계약과 동일 정신) `caller_member_id=None`을 반환해 호출부가 chat-source
    분기 자체를 `false()`로 완전히 닫게 한다(doc-source 분기는 전혀 영향받지 않음 — 한 caller
    신원 해소 실패가 전체 응답을 poison하지 않는다는 B1 불변식과 동형)."""
    from app.routers.conversations import _resolve_member  # lazy: 순환 import 회피(기존 관례)

    try:
        sender = await _resolve_member(auth, org_id, db, project_id=None)
    except HTTPException:
        return None, None
    caller_member_id = sender.id
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    return caller_member_id, is_api_key


# ─── story #2266(C-8) — target_type 일반화, 허용목록(allowlist) ──────────────────
# PO 판정(2026-07-28): target_type을 자유 파라미터로 열면 «게이트가 안 선 타입까지 통과하는
# 구멍»이 생긴다 — 이 함수는 TARGET 접근 검증을 스스로 하지 않고(§8①) 호출부(라우터)가
# 이미 검증했다는 전제로 짜여 있기 때문(위 docstring 참조). 그래서 "이 타입은 호출부가 실제로
# 게이트를 세웠다"를 이 allowlist가 보증한다 — 코드 레벨 계약이지 편의 목록이 아니다.
BACKLINKS_ALLOWED_TARGET_TYPES = frozenset({"doc", "story", "artifact", "gate", "pull_request"})
# ⛔registry(reference_registry.ENTITY_RESOLVERS)의 나머지 타입(epic 등)이 여기 없는 이유는
# "의도적 제외"가 아니라 **게이트 미비**다 — 그 타입들의 라우터에 아직 이 함수와 동형인
# TARGET project-access 선-게이트(docs.py._require_doc_project_access ·
# stories.py._assert_story_project_access)가 없다. 게이트가 서는 순서대로 여기 추가한다.
# story #2721(2026-08-17): artifact 추가 — visual_artifacts.py의 `_get_artifact_or_404`가
# 이미 동형 TARGET project-access 게이트(org_id+project_id 조합 404)라 그대로 재사용,
# 새 게이트 발명 0. WRITE(entity_references에 target_type=artifact 저장)는 reference_registry.
# ENTITY_RESOLVERS에 이미 등재돼 실측 확認됨(그라운딩) — 이 스토리는 READ(backlinks 조회)
# 축만 연다.
# story #2889(S2h①, 페드루 확定 2026-08-21) — gate·pull_request 추가. WRITE 측 등록은
# reference_registry.ENTITY_RESOLVERS(완전지원)가 아니라 TARGET_ONLY_TYPES다(검색 handler 등
# 나머지 계약이 안 서는 이유는 reference_registry.py의 _resolve_gates/_resolve_pull_requests
# docstring 참고) — 이 함수는 완전지원과 무관하게 TARGET 접근이 «호출 라우터가 이미 검증»
# 했다는 계약만 요구하므로(위 §8① 불변식) TARGET_ONLY 타입도 문제없이 연다. TARGET 게이트는
# gates.py::get_gate_backlinks(resolve_work_item_project_id 재사용)·github_integration.py::
# get_pr_link_backlinks(delete_link과 동일 게이트) 신규.


class UnsupportedBacklinkTargetTypeError(ValueError):
    """target_type이 BACKLINKS_ALLOWED_TARGET_TYPES 밖 — 호출 라우터가 400으로 번역한다.

    ⛔PO 리뷰(2026-07-28): 지금은 이 분기가 HTTP 경로로 «도달 불가»하다 — docs.py/stories.py
    둘 다 target_type을 client 입력이 아니라 고정 literal("doc"/"story")로 넘긴다. 그래서
    「아무도 안 타는 분기」로 보여 다음 사람이 지울 위험이 있다 — 지우면 안 된다. **허용목록이
    언젠가 client 입력(예: 단일 generic `/entities/{type}/{id}/backlinks` 라우트)을 받게 되는
    날, 이 분기가 TARGET 게이트 누락을 막는 유일한 방어선**이 된다. 지금도
    `test_list_entity_backlinks_rejects_unsupported_target_type`이 이 분기를 직접 타서
    커버리지에 살아 있고, 허용목록을 게이트 없이 늘리면 그 테스트가 걸린다(RED로 잡는다는
    뜻이 아니라 — 허용목록에 추가한 사람이 이 클래스의 존재를 코드에서 보게 된다는 뜻)."""


# ⛔story #2277(E-CONNECT) target_type → model — count_zero_referenced_entities 전용.
# 이 dict의 키를 늘릴 땐 반드시 BACKLINKS_ALLOWED_TARGET_TYPES도 같이 늘어 있어야 한다
# (파생이 아니라 하드코딩인 이유: model 클래스 자체는 registry가 담을 수 없는 타입정보라
# 여기 한 곳에만 둔다) — 이 방향의 부분집합 관계만 요구된다(하위 ⊆ 상위), **역방향은 아니다**.
# story #2889(S2h①, 2026-08-21): gate·pull_request는 BACKLINKS_ALLOWED_TARGET_TYPES엔
# 있지만 여기 의도적으로 없다 — ①Gate엔 soft-delete 컬럼 자체가 없어(gate.py, 상태기계
# row는 절대 안 지워짐) 아래 루프의 `model.deleted_at.is_(None)` 필터가 AttributeError로
# 죽는다 ②"고아 참조" 감사(story #2277 원 취지)는 자유텍스트 제목이 있는 doc/story류에
# 의미 있는 지표이지, gate/PR(제목 없는 상태 레코드)엔 적용 대상이 아니다(감사할 "미언급"
# 개념 자체가 어색). BACKLINKS_ALLOWED_TARGET_TYPES 확장의 실 목적(chat 임베드 역참조 조회)은
# _ZERO_REF_MODELS와 무관하게 이미 충족된다.
_ZERO_REF_MODELS: dict[str, type] = {"doc": Doc, "story": Story, "artifact": VisualArtifact}


async def count_zero_referenced_entities(
    session: AsyncSession, org_id: uuid.UUID | None = None,
) -> dict[str, int]:
    """story #2277 AC1/AC2 — target_type별로 "가리키는 참조가 0건"인 엔티티 수를 센다.
    대상 타입은 #2266이 세운 `BACKLINKS_ALLOWED_TARGET_TYPES`(doc·story)와 동일 허용목록만
    쓴다(AC1 — 별도 목록을 새로 만들지 않는다). org_id=None(기본)이면 전체 org 스코프.

    ⛔AC2 후속(PO 정정, 2026-07-29): 이 함수가 세는 수는 「고아」가 아니라 「이 항목을 가리키는
    mention/embed/proof 참조가 entity_references에 0건」이라는 사실뿐이다 — `entity_references`
    테이블 자체가 아직 얕게 채워진 상태(참조추적 기능이 신생)라면 이 수의 대부분은 「실제로
    미언급」이 아니라 「추적이 아직 안 돈 것」이다. 그래서 이 함수를 부르는 자리는 항상
    `count_entity_references_total`(아래)도 같이 불러 분모를 나란히 실어야 한다(cron endpoint
    참조) — 절대값만 단독으로 보고하지 않는다."""
    counts: dict[str, int] = {}
    for target_type in sorted(BACKLINKS_ALLOWED_TARGET_TYPES):
        model = _ZERO_REF_MODELS[target_type]
        stmt = (
            select(func.count())
            .select_from(model)
            .outerjoin(
                Reference,
                and_(Reference.target_type == target_type, Reference.target_id == model.id),
            )
            .where(model.deleted_at.is_(None), Reference.id.is_(None))
        )
        if org_id is not None:
            stmt = stmt.where(model.org_id == org_id)
        counts[target_type] = (await session.execute(stmt)).scalar_one()
    return counts


async def count_entity_references_total(session: AsyncSession, org_id: uuid.UUID | None = None) -> int:
    """story #2277 AC2/AC3 — `entity_references` 총행수(분모). `count_zero_referenced_entities`의
    결과를 단독으로 보고하면 다음 사람이 그 수를 「고아 수」로 오독한다(2026-07-29 dev 실측:
    zero_referenced doc 871/story 2497인데 이 총행수가 62뿐이라 실은 분모미채움이었다) — 이
    함수가 그 오독을 막는 짝이다."""
    stmt = select(func.count()).select_from(Reference)
    if org_id is not None:
        stmt = stmt.where(Reference.org_id == org_id)
    return (await session.execute(stmt)).scalar_one()


async def list_entity_backlinks(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    target_type: str,
    target_id: uuid.UUID,
    auth: AuthContext,
    limit: int,
    cursor: str | None,
) -> dict:
    """GET /api/v2/{docs,stories}/{id}/backlinks 코어(#2266 — target_type 일반화). 호출부
    (docs.py/stories.py)가 target 접근을 이미 검증했다는 전제(§8① target read access는 별도·
    기존 라우트 책임) — 여기선 source 접근만 mention 행 단위로 판정한다.

    story #2266: `target_type`은 `BACKLINKS_ALLOWED_TARGET_TYPES`(허용목록)에 있는 값만
    받는다 — 그 밖의 값은 `UnsupportedBacklinkTargetTypeError`(호출부가 400으로 번역). SOURCE
    측 로직(authz predicate·응답 item shape)은 target_type과 완전히 무관하다(SELECT/JOIN이
    `Reference.source_id`·`Reference.source_type` 기준이지 target 기준이 아니다) — 그래서
    이 함수는 target_type이 늘어도 SOURCE 쪽 쿼리를 한 글자도 안 바꾼다.

    반환: `{"data": [...], "meta": {"next_cursor": str|None, "has_more": bool}}` — list_messages와
    동일 shape(AC1 "same convention"). data 항목: {id, source_type, source_id, created_by,
    created_at, still_exists, doc: {id,title}|None, message: {id,conversation_id,content_snippet,
    sender}|None}. `created_by`는 raw UUID가 아니라 `{id,name,type}`|None(sender와 동형 처리 —
    Extra fix).

    `still_exists`(story #2299, E-CONNECT — "끊어진 참조 가시성" 배선): 이 backlink item의
    **SOURCE**(target이 아니다 — target은 URL의 id 자신이고, 이 함수에 도달했다는 것 자체가
    호출부의 404 게이트를 통과했다는 뜻이라 항상 존재한다. "끊어짐"이 있을 수 있는 쪽은
    source뿐이다)가 아직 살아 있는지. doc/meeting/story source는 soft-delete 여부
    (`*.deleted_at`)로 판정 — 예전엔 이 조건이 JOIN에 있어 삭제된 source가 결과에서 통째로
    빠졌다(PO가 "조용히 사라지는 것"으로 재판정, `test_soft_deleted_source_doc_excluded` 개정).
    ⛔story #2319(정정) — chat_message source도 이제 같은 패턴이다. 이 함수가 작성될 당시
    chat_message는 "SOURCE_ONLY_TYPES(불변, soft-delete 없음)"라 가정해 항상 True를 하드코딩
    했었으나, #2319가 메시지 삭제(tombstone — 행은 남고 content만 지워짐)를 도입하면서 그
    가정이 깨졌다. `ConversationMessage.deleted_at`도 doc/meeting/story와 동형으로 판정한다.
    genuinely-missing message row(하드삭제/오손 데이터, 이 필드가 다루는 대상이 아님)는
    여전히 결과에서 제외된다(`test_missing_source_message_excluded_no_crash`, 이 스토리가
    안 건드림 — "삭제 lifecycle"과 "오손 데이터"는 다른 문제).

    ⛔story #2299 AC⑥(이 판이 못 잡는 것 선언):
      · `reference_core.list_references`는 여전히 아무도 안 부른다(#2591이 증명한 채 그대로 —
        이 story는 그 함수를 살리지 않았다, PO 판정대로 "안 도는 문"을 살리는 대신 여기
        `list_entity_backlinks`에 별도로 얹었다. `list_references`를 살릴지는 별건).
      · story/task 등 doc이 아닌 source_type은 이 함수가 애초에 다루지 않는다(위 docstring
        "source_type은 chat_message·doc 뿐" — still_exists도 그 두 종류에만 존재).
      · target 자신이 이 응답 처리 도중(요청과 요청 사이가 아니라 같은 요청 내에서) 삭제되는
        TOCTOU 창은 다루지 않는다(호출부의 404 게이트가 요청 시작 시점 1회 확인 — 그 이후
        target 삭제는 이 응답에 반영 안 됨, 기존 backlinks 전체의 기존 계약과 동일).

    `next_cursor`는 opaque composite base64 토큰(B3) — `before` query param에 그대로 되돌려준다.
    """
    if target_type not in BACKLINKS_ALLOWED_TARGET_TYPES:
        raise UnsupportedBacklinkTargetTypeError(target_type)

    cursor_key: tuple[datetime, uuid.UUID] | None = None
    if cursor:
        cursor_key = decode_cursor(cursor)

    # ── 요청당 정확히 1회, candidate 개수 N과 무관하게 해소하는 caller 신원 사실 ──
    # §5회차(산티아고 Blocker 1): `project_access_valid`는 여기서 사전 SELECT/materialize하지
    # 않는다 — `project_access_valid_correlated(...)`를 메인 statement의 WHERE절에 직접
    # correlate해 심는다(아래 stmt 참조).
    # §6회차(마지막 atom): `admin_bypass_eligible`도 더 이상 여기서 사전 SELECT하지 않는다 —
    # `_chat_predicate_inputs`는 이제 caller가 누구인지(`caller_member_id`)·어떤 종류인지
    # (`is_api_key`)만 O(1)로 해소하고, 실제 admin-bypass 판정은 아래에서
    # `org_admin_valid_correlated`(휴먼)/`project_admin_valid_correlated`(에이전트,
    # `Conversation.project_id`에 correlate)로 메인 statement에 직접 심는다 — project_access_valid와
    # 정확히 동일한 "pre-resolve 제거 → 메인 statement 내부 correlated EXISTS" 전환.
    uid = uuid.UUID(str(auth.user_id))

    caller_member_id, is_api_key = await _chat_predicate_inputs(db, org_id, auth)
    if caller_member_id is None:
        chat_predicate = sa_false()
    else:
        # caller는 human XOR agent(둘 다일 수 없음) — 어느 correlated 표현식을 쓸지는
        # caller-level 사실(`is_api_key`)로 결정하지만, 결정된 표현식 자체는 pre-resolve된
        # 값이 아니라 메인 statement의 스냅샷 안에서 평가되는 correlated EXISTS다(항상
        # 정확히 하나의 correlated 표현식만 조립됨 — Python bool 사전계산 0).
        admin_bypass_eligible = (
            project_admin_valid_correlated(
                Conversation.project_id, caller_id=caller_member_id, org_id=org_id,
            )
            if is_api_key
            else org_admin_valid_correlated(caller_id=uid, org_id=org_id)
        )
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
            # §6회차(마지막 atom) fix: 위에서 조립한 correlated EXISTS — 사전계산된 bool/`.in_()`
            # 멤버십이 아니라 메인 statement 실행 시점의 스냅샷으로 평가된다.
            admin_bypass_eligible=admin_bypass_eligible,
        )

    # ── 단일 authz-embedded keyset 쿼리 — Python authz filter/retry 0, 2-phase 없음 ──
    # ⛔story #2273(C-1b): source는 entity_references(Reference)에서 읽는다(#2259가 세운 표,
    # #2273이 write-path와 같은 배포로 read도 재배선 — read/write를 가르면 그 사이 창에서
    # 화면이 거짓말한다, PO 판정). source_field == "body" 필터는 이 read-path가 아는 두
    # source_type(doc·chat_message) 다 텍스트 필드가 하나뿐이라는 사실과 짝을 맞춘 것(다른
    # source_field 값 — 예: story description/AC — 는 이 backlinks 엔드포인트의 스코프 밖).
    # ⛔story #2267(C-9, 오르테가군 재지적 2026-07-29·2026-07-30): 이 필터는 「지금은 맞고
    # 곧 틀리는」자리였다 — relation='created_from'(창조-출처) 행은 애초에 텍스트 필드에서
    # 파싱된 게 아니라(source_field='self' sentinel, 아래 write-path 참조) "본문 참조"가 아니다.
    # 그대로 두면 이 필터가 출처 참조를 조용히 걸러낸다("출처를 만들었는데 정작 보여주는
    # 화면에서 안 보이는" 오늘 계속 만난 그 모양). ⇒ relation='created_from'이면 source_field
    # 값과 무관하게 항상 통과시키고, relation='none'(일반 멘션)일 때만 기존 "body" 스코프
    # 제한을 그대로 적용한다.
    # entity_references.source_id는 polymorphic(FK 없음: docs.id 또는 conversation_messages.id) —
    # 두 conditional LEFT JOIN(+ chat-source는 Conversation까지 세 번째 LEFT JOIN)으로 각각의
    # source_type에서만 매치시킨다. Conversation JOIN의 ON절 `Conversation.org_id == org_id`가
    # Blocker 1(org-scope 누락) fix — Doc JOIN의 `Doc.org_id == org_id`와 동형. §8③ 요구대로
    # 인가 predicate(doc: accessible_pids 멤버십, chat: conversation_readable_predicate)를
    # WHERE 절에 직접 embed한다(별도 SELECT로 먼저 집합을 만들지 않음 — TOCTOU-by-construction).
    stmt = (
        select(
            Reference,
            Doc.project_id.label("doc_project_id"),
            Doc.title.label("doc_title"),
            # ⛔story #2299(E-CONNECT, PO 판정 2026-07-29): 여기 있던 `Doc.deleted_at.is_(None)`이
            # JOIN ON절에서 soft-deleted source doc을 "매치 실패"로 만들어 project_id가 NULL이
            # 되고, 그 결과 아래 WHERE의 authz 체크(project_access_valid_correlated)가 NULL
            # project에 대해 무조건 거짓이 되어 행 자체가 결과에서 «조용히» 빠졌다(`test_soft_
            # deleted_source_doc_excluded`가 그걸 "정답"으로 고정하고 있었다 — PO가 그 자체를
            # 버그로 재판정: "목록에서 빼면 그게 바로 조용히 사라지는 것"). deleted_at 조건을
            # JOIN에서 빼 soft-deleted 문서도 매치되게 하고(그래야 project_id가 살아서 authz가
            # 원래 프로젝트 기준으로 정상 평가된다 — 삭제됐다고 접근권 검사가 사라지면 안 된다),
            # 대신 deleted_at 자체를 별도 컬럼으로 select해 still_exists 판정에 쓴다.
            Doc.deleted_at.label("doc_deleted_at"),
            ConversationMessage.conversation_id.label("msg_conversation_id"),
            ConversationMessage.content.label("msg_content"),
            ConversationMessage.sender_id.label("msg_sender_id"),
            # story #2319: chat_message도 이제 soft-delete(tombstone)될 수 있다 — doc/meeting/
            # story와 동형으로 deleted_at을 별도 컬럼으로 select(JOIN ON절엔 안 넣는다 — #2299
            # 교훈 그대로, 넣으면 conversation_id가 NULL이 되어 authz가 깨진다).
            ConversationMessage.deleted_at.label("msg_deleted_at"),
            # story #2267(C-9): meeting·story도 source가 될 수 있다(창조-출처, relation=
            # 'created_from') — Doc과 동형(직접 project_id 보유·soft-delete)이라 같은 패턴.
            # #2299 교훈 그대로: deleted_at은 JOIN ON절에 안 넣는다(soft-delete돼도 project_id는
            # 살아야 authz가 정상 평가된다).
            Meeting.project_id.label("meeting_project_id"),
            Meeting.title.label("meeting_title"),
            Meeting.deleted_at.label("meeting_deleted_at"),
            Story.project_id.label("story_source_project_id"),
            Story.title.label("story_source_title"),
            Story.deleted_at.label("story_source_deleted_at"),
        )
        .select_from(Reference)
        .outerjoin(
            Doc,
            and_(
                Doc.id == Reference.source_id,
                Reference.source_type == "doc",
                Doc.org_id == org_id,
            ),
        )
        .outerjoin(
            ConversationMessage,
            and_(
                ConversationMessage.id == Reference.source_id,
                Reference.source_type == "chat_message",
            ),
        )
        .outerjoin(
            Conversation,
            and_(
                Conversation.id == ConversationMessage.conversation_id,
                Conversation.org_id == org_id,  # ⭐ Blocker 1(4회차): org 경계 명시 검증
            ),
        )
        .outerjoin(
            Meeting,
            and_(
                Meeting.id == Reference.source_id,
                Reference.source_type == "meeting",
                # Meeting엔 org_id 컬럼이 없다(project 경유로만 org 스코프) — project_access_
                # valid_correlated가 project→org 소속을 확認하므로 여기선 project_id로만 매치.
            ),
        )
        .outerjoin(
            Story,
            and_(
                Story.id == Reference.source_id,
                Reference.source_type == "story",
                Story.org_id == org_id,
            ),
        )
        .where(
            Reference.org_id == org_id,
            # story #2679(BE): origin='auto'(caller 의도 확인 없이 서버가 승격한 참조 —
            # story_ref_promoter.py·resolve_bare_number_story_refs)는 backlink 그래프에서
            # 제외한다 — 「명시적으로 링크를 걸었다」는 신호가 아닌데 그래프/카운트를 오염시켰던
            # 것이 이 스토리(#2679)의 원 결함이다. 렌더(채팅 버블 본문 표시)는 이 쿼리를 안
            # 거치므로(promote_bare_story_refs가 이미 content에 토큰을 심어 둠) 영향 없다.
            Reference.origin == "explicit",
            or_(Reference.relation == "created_from", Reference.source_field == "body"),
            Reference.target_type == target_type,
            Reference.target_id == target_id,
            or_(
                and_(
                    Reference.source_type == "doc",
                    # §5회차 Blocker 1 fix: 사전 IN-list가 아니라 correlated EXISTS(같은 statement
                    # ·같은 스냅샷 — 위 chat-source project_access_valid와 동일 SSOT 호출).
                    project_access_valid_correlated(Doc.project_id, caller_id=uid, org_id=org_id),
                ),
                and_(
                    Reference.source_type == "chat_message",
                    # org join이 매치 실패하면(다른 org 소속 conversation) Conversation.id가
                    # NULL — 이 가드가 그 행을 admin-bypass 포함 어떤 경로로도 확실히 탈락시킨다.
                    Conversation.id.isnot(None),
                    chat_predicate,
                ),
                and_(
                    # story #2267(C-9): meeting source — Doc과 동일 패턴(project_id 직접보유).
                    Reference.source_type == "meeting",
                    project_access_valid_correlated(Meeting.project_id, caller_id=uid, org_id=org_id),
                ),
                and_(
                    # story #2267(C-9): story source(㉢분할·복제 출처) — Doc과 동일 패턴.
                    Reference.source_type == "story",
                    project_access_valid_correlated(Story.project_id, caller_id=uid, org_id=org_id),
                ),
            ),
        )
    )
    if cursor_key is not None:
        cursor_created_at, cursor_id = cursor_key
        stmt = stmt.where(tuple_(Reference.created_at, Reference.id) < tuple_(cursor_created_at, cursor_id))

    # story #2266 AC6(정렬은 "최근"이 아니라 "쓸모"): entity_references는 지금 조회수·클릭·
    # 관련도 등 recency 이외의 신호를 전혀 안 쌓는다(row에 그런 컬럼이 없다) — "쓸모" 축으로
    # 정렬하려 해도 지금 계산할 수 있는 신호가 하나도 없다. created_at DESC를 유지하는 이유는
    # "그냥 기본값"이 아니라 "지금 유일하게 존재하는 신호가 이것뿐"이라는 사실이다. 신호가
    # 생기면(예: form!=proof 우선순위, 조회 카운트) 그때 다시 정렬 기준을 판정한다.
    stmt = stmt.order_by(Reference.created_at.desc(), Reference.id.desc()).limit(limit + 1)

    rows = (await db.execute(stmt)).all()
    has_more = len(rows) > limit
    page_rows = rows[:limit]

    # 최종 페이지 행에서만 sender/created_by 배치 해소(N+1 없음 — §ⓝ 기존 관례 유지).
    sender_ids = {
        r.msg_sender_id for r in page_rows
        if r.Reference.source_type == "chat_message" and r.msg_sender_id is not None
    }
    creator_ids = {r.Reference.created_by for r in page_rows if r.Reference.created_by is not None}
    member_map = await lookup_members_by_ids(sender_ids | creator_ids, db)

    data: list[dict] = []
    for r in page_rows:
        m = r.Reference
        creator = member_map.get(m.created_by) if m.created_by is not None else None
        item: dict = {
            "id": str(m.id),
            "source_type": m.source_type,
            "source_id": str(m.source_id),
            "created_by": _member_summary_same_org(creator, org_id),
            "created_at": m.created_at.isoformat(),
            # story #2267(C-9): 'none'(본문 참조)·'created_from'(target이 이 source에서
            # 만들어졌다 — "출처"). ⛔컨테이너(epic/sprint/meeting_id)와 이 값을 화면에서
            # 섞지 않는다(스토리 AC4) — 이 필드가 있어야 FE가 "출처"만 따로 표시할 수 있다.
            "relation": m.relation,
            "doc": None,
            "message": None,
            "meeting": None,
            "story": None,
            # story #2299 AC⑤: 「끊어짐」은 색/경고가 아니라 사실 필드다 — 렌더(색·문구)는 FE
            # 몫. 넷 다 아래서 각 source_type의 실제 판정으로 덮어쓴다(기본값 True는 그 사이
            # 매치 실패한 source_type 없음 방어일 뿐 — 이 함수가 아는 네 타입은 전부 판정됨).
            "still_exists": True,
        }
        if m.source_type == "doc":
            item["doc"] = {"id": str(m.source_id), "title": r.doc_title}
            item["still_exists"] = r.doc_deleted_at is None
        elif m.source_type == "chat_message":
            sender = member_map.get(r.msg_sender_id) if r.msg_sender_id is not None else None
            item["message"] = {
                "id": str(m.source_id),
                "conversation_id": str(r.msg_conversation_id),
                "content_snippet": build_content_snippet(r.msg_content),
                "sender": _member_summary_same_org(sender, org_id),
            }
            # story #2319: tombstone된 메시지도 행은 살아있다(하드삭제 아님) — 그래서 아래는
            # "행이 있는가"가 아니라 "지워졌는가"를 잰다. FE는 still_exists=False를 보면 기존
            # 제네릭 렌더(entity-backlinks-section.tsx, "대상이 없습니다" 무채색 배지)를 그대로
            # 태운다 — content_snippet이 빈 문자열이라도 별도 분기 불필요.
            item["still_exists"] = r.msg_deleted_at is None
        elif m.source_type == "meeting":
            item["meeting"] = {"id": str(m.source_id), "title": r.meeting_title}
            item["still_exists"] = r.meeting_deleted_at is None
        elif m.source_type == "story":
            item["story"] = {"id": str(m.source_id), "title": r.story_source_title}
            item["still_exists"] = r.story_source_deleted_at is None
        data.append(item)

    next_cursor = None
    if has_more and page_rows:
        last_mention = page_rows[-1].Reference
        next_cursor = encode_cursor(last_mention.created_at, last_mention.id)

    # story #2266 AC4(정직성 관문): "0건"을 "출처 없음"으로 읽지 않도록, 이 응답이 실제로
    # 무엇을 셌는지를 구조화된 사실로 함께 낸다(문안 렌더는 FE 몫 — 여기선 FE가 틀리지 않게
    # 근거 사실만 준다). ⛔이 쿼리는 `Reference.form`을 필터링하지 않는다(mention/embed/proof
    # 전부 포함 — 위 stmt에 form 조건이 없다) — 그래서 "mention/embed만"이라고 쓰면 거짓이다.
    # source_type은 이 함수가 아는 네 값(chat_message·doc·meeting·story, story #2267 C-9가
    # meeting·story를 추가)뿐 — PR "[SID:XXX]" 텍스트 관례·evidence 자유텍스트 참조는
    # entity_references에 전혀 안 쌓이므로(구조화 전) 이 카운트에 없다.
    collection_scope = {
        "source_types": ["chat_message", "doc", "meeting", "story"],
        "forms": "all",
        "excludes": ["pr_sid_text_convention", "evidence_free_text_reference"],
    }

    return {
        "data": data,
        "meta": {"next_cursor": next_cursor, "has_more": has_more, "collection_scope": collection_scope},
    }


async def list_doc_backlinks(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    auth: AuthContext,
    limit: int,
    cursor: str | None,
) -> dict:
    """하위호환 wrapper(story #2266) — 기존 호출부(docs.py)·기존 테스트(test_1994_*)가 이
    이름·시그니처 그대로 쓴다. 실제 로직은 `list_entity_backlinks(target_type="doc", ...)`로
    위임한다(둘이 서로 다른 코드가 아니다 — 하나의 SSOT)."""
    return await list_entity_backlinks(
        db, org_id=org_id, target_type="doc", target_id=doc_id, auth=auth, limit=limit, cursor=cursor,
    )
