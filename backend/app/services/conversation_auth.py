"""story #1994(E-KNOWLEDGE-LINK S2) 4회차 pass — 산티아고 Blocker 2 근본수정.

3회차까지 `app/services/backlinks.py`의 `_resolve_readable_conversation_ids`는
"conversation을 이 caller가 읽을 수 있는가"를 `app/routers/conversations.py`
`_can_read_conversation`과는 **별개로** 처음부터 다시 짠 Python/SQL 조합이었다. 두 구현이
"같은 판정을 낸다"는 걸 코드 리뷰로만 신뢰했는데, 실제로는 드리프트가 있었다 — 벌크
재구현판은 후보 conversation → project_id 매핑 쿼리에 `Conversation.org_id == org_id` 필터가
없었다(Blocker 1, 4회차). "재구현 자체가 드리프트의 원인"이라는 산티아고의 근본 진단에 따라
이 모듈은 그 판정 논리를 **정확히 한 곳**에 SQLAlchemy Core 불리언 표현식으로 박아, 두
소비자가 그대로 재사용하게 한다:

  1. `conversations.py::_can_read_conversation` — 단건(list_messages/get_message/replies 등
     실 메시지 엔드포인트가 쓰는 hot path). `select(predicate)`로 단건 스칼라 조회.
  2. `backlinks.py::list_doc_backlinks` — 벌크. 이 표현식을 메인 SQL 문의 WHERE 절에 **직접
     correlate**해 심는다 — "먼저 readable conversation id 집합을 SELECT해 Python set으로
     들고 있다가 다음 SELECT의 IN 절에 넣는" 2-phase가 전혀 아니다. 후보 mention 행 하나하나가
     이 표현식으로 평가되며, doc-source join·keyset pagination과 **같은 문·같은 스냅샷**
     안에서 일어난다(TOCTOU-by-construction — 두 SELECT 사이의 revoke 윈도우 자체가 구조적으로
     존재하지 않는다. READ COMMITTED에서도 한 statement는 그 statement 실행 시작 시점의 단일
     스냅샷을 본다).

## 판정 논리(캐노니컬)

  readable(conv) ⟺ (participant(conv) ∧ project_access_valid(conv.project))
                  ∨ (¬has_human_participant(conv) ∧ admin_bypass_eligible(conv.project))

- `participant`: `conversation_participants`에 caller_member_id 행이 있는가(원시 참가 행 —
  참가 당시 스냅샷).
- `project_access_valid`: **참가 당시가 아니라 지금** caller가 그 project에 접근 가능한가
  (project_access 회수 = 참가 행이 남아있어도 더 이상 못 읽음 — 3회차 이전 pass가 확립한
  B1 grant-loss 하드닝. 이 4회차 스펙 문구("participant OR ...")는 이를 축약 표기한 것으로
  해석해 계속 강제한다 — 문구 그대로 "participant 원시 행만 있으면 통과"로 완화하면 기존
  하드닝의 조용한 회귀가 된다).
- `has_human_participant`: 참가자 중 agent로 확정되지 않은 멤버가 하나라도 있으면 True(보수적
  — `_conversation_has_human_participant`와 동형). True면 admin-bypass 자체가 아예 적용 안
  된다(휴먼 참가 = private, 사적 DM/그룹 프라이버시 carve-out).
- `admin_bypass_eligible`: **호출부가 이미 O(1)로 해소해 넘기는 값**(bool 리터럴 또는
  correlated 표현식) — 휴먼은 org owner/admin 여부(요청당 1회), 에이전트는 그 conversation의
  project에 대한 owner/admin grant 여부(요청당 1회 bulk 집합, 후보 개수 무관). "누가 admin인가"
  는 caller-level 사실이라 O(1) 사전 계산이 가능하다 — 산티아고 Blocker 2가 근절한 건
  "conversation마다 admin 여부를 재확인/재조회하는 루프"이지, "요청 시작 시 caller의
  org-admin 여부·admin-project 집합을 정확히 1회 해소하는 것" 자체가 아니다(이건 이미
  `accessible_project_ids_in_org` 1회 호출과 동일 원칙 — doc-source 인가에도 그대로 쓰인다).

`project_access_valid`/`admin_bypass_eligible`을 이 함수 내부에서 계산하지 않고 파라미터로
받는 이유: 두 소비자가 이 값을 얻는 방식이 다르다(단건은 `has_project_access` 스칼라 호출,
벌크는 `accessible_project_ids_in_org` bulk 집합의 `.in_()` 멤버십) — "판정 로직의 불리언
구조"(participant∧valid ∨ ¬human∧admin)만 SSOT면 되고, 그 안의 원자 조건을 어떻게
싸게/정확하게 구하느냐는 호출 컨텍스트의 재량이다(산티아고 요구사항 2의 명시적 escape
hatch: "핵심 불리언 로직을 이 공유 빌더가 담당하면 됨, project_id/human-participant
pre-fetch까지 통일할 필요는 없음").
"""
from __future__ import annotations

import uuid

from sqlalchemy import and_, false, or_, select, true
from sqlalchemy.sql.elements import ColumnElement

from app.models.conversation import ConversationParticipant
from app.models.team import TeamMember

BoolExpr = ColumnElement  # bool 스칼라를 내는 SQLAlchemy Core 표현식(가독용 별칭)


def _as_bool_expr(value: "BoolExpr | bool") -> BoolExpr:
    if isinstance(value, ColumnElement):
        return value
    return true() if value else false()


def conversation_readable_predicate(
    conv_id_col: ColumnElement,
    *,
    caller_member_id: uuid.UUID,
    project_access_valid: "BoolExpr | bool",
    admin_bypass_eligible: "BoolExpr | bool",
) -> BoolExpr:
    """canonical read predicate — 모듈 docstring 참조. 이 함수가 SSOT, 나머지는 전부 소비자.

    `conv_id_col`: 이미 **호출부가 org로 스코프한** conversation id 컬럼/리터럴(예: 단건 호출은
    `literal(conversation_id)`, 벌크 호출은 `Conversation.id` — 단 후자는 반드시 caller의
    JOIN이 `Conversation.org_id == org_id`를 ON절에 명시한 뒤여야 한다). 이 함수 자체는 org
    경계를 검증하지 않는다 — 그건 산티아고 Blocker 1의 fix이자 호출부의 책임이고, 현재 두
    소비자 모두 이미 그렇게 한다.

    `caller_member_id`: `conversation_participants.member_id`/`project_access.member_id`가
    실제로 참조하는 값(휴먼=team_member 뷰 투영 id=members.id, 에이전트=members.id 직접).

    `project_access_valid`/`admin_bypass_eligible`: bool 리터럴 또는 correlated
    `ColumnElement[bool]` 둘 다 허용(단건은 보통 전자, 벌크는 후자).
    """
    is_participant = (
        select(1)
        .where(
            ConversationParticipant.conversation_id == conv_id_col,
            ConversationParticipant.member_id == caller_member_id,
        )
        .exists()
    )
    # 보수적: agent로 확정되지 않은 참가자는 human 취급(`_conversation_has_human_participant`/
    # `_conversations_with_human_participant`와 동형 — grant-only/미앵커 휴먼도 human으로 간주).
    has_human_participant = (
        select(1)
        .where(
            ConversationParticipant.conversation_id == conv_id_col,
            ~(
                select(1)
                .where(
                    TeamMember.id == ConversationParticipant.member_id,
                    TeamMember.type == "agent",
                )
                .exists()
            ),
        )
        .exists()
    )

    pav = _as_bool_expr(project_access_valid)
    abe = _as_bool_expr(admin_bypass_eligible)

    return or_(
        and_(is_participant, pav),
        and_(~has_human_participant, abe),
    )
