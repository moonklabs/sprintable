"""story #2604 P2(delivery-contract-blueprint-v0-1): approval-request 챗 카드 배달 — BE 절반
(이벤트 템플릿·Gate 연결까지). 카드 *렌더*는 미르코 FE(#2614) 몫. 카드 액션(승인/반려)은 새 API
없이 기존 POST /api/v2/gates/{id}/transition 을 그대로 쓴다(AC③) — 여기는 그 gate로 이어지는
길(승인자별 DM + message_kind="request" + approval_target 페이로드)만 만든다.

⚠️AC3 정책(코드가 아니라 문서로 명문화 — PR 본문 + #2604 스토리 설명): 챗에서 "승인"이라고
텍스트로만 답하는 건 게이트를 해소하지 않는다 — 오직 카드 액션(버튼, gates.py 기존 human-only
SoD 인가 경유)만 유효하다. 이 모듈은 그 규칙을 코드로 강제하지 않는다(강제할 지점이 없다 —
게이트 해소 자체가 이미 독립적으로 인가돼 있다). 여기서 하는 일은 그 카드가 승인자 눈앞에
"보이게" 배달하는 것까지.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import event as sa_event
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.doc import Doc
from app.models.event import Event

logger = logging.getLogger(__name__)


async def _get_or_create_approval_dm(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    requester_id: uuid.UUID,
    approver_id: uuid.UUID,
) -> Conversation:
    """requester↔approver 기존 dm 재사용(참가자 집합 기준, 가장 최근 활성 1개), 없으면 생성.

    일반 create_conversation 엔드포인트의 "매 호출 신규" 정책(EF-S2, db75ecd0)과 의도적으로
    다르다 — 승인자당 안정적 단일 스레드(카드 상태 갱신 대상)가 필요한 시스템 배달 경로라서,
    여기 한정으로 get-or-create를 쓴다(엔드포인트 자체는 무변경).

    ⛔story #2628(2026-08-13, 선생님 실사용 지적): dm_pair_key **단독** 매치는 안 쓴다 — 그
    컬럼이 없는(백필 갭·프로덕트 초기 생성 등) 기존 방을 "기존 페어 DM 없음"으로 오판해 새
    DM을 만들어 대화가 쪼개지는 사고가 났다(선생님↔PO 실 사례: 방 97ee5509는 type=dm이나
    dm_pair_key가 비어 카드가 새 방 59cda904로 흘러감). 표식(키)과 실물(참가자 집합)이
    갈리면 실물이 정본이라, 조회를 "이 conversation의 참가자가 정확히 {requester_id,
    approver_id} 2인"(ConversationParticipant 실물 조회 — 인원수 정확히 2·둘 다 매치)으로
    바꾼다. dm_pair_key는 이제 조회에 전혀 안 쓴다(신설 시 태깅만 유지 — `_create_conversation_
    record`가 이미 하는 일, 향후 최적화 여지로 남겨둠). 최근 활성 우선은 `updated_at DESC`
    (메시지가 올 때마다 갱신되는 값 — `created_at`보다 "활성" 의미에 더 맞는다).

    _enforce_agent_creator_policy 미적용: 사용자가 여는 방이 아니라, 게이트가 이미 독립적으로
    인가한(요청자=문서 상신자, 대상=org owner/admin) 시스템 발신 알림 배달이다.
    """
    target_ids = (requester_id, approver_id)
    matched_conv_ids = (
        select(ConversationParticipant.conversation_id)
        .where(ConversationParticipant.member_id.in_(target_ids))
        .group_by(ConversationParticipant.conversation_id)
        .having(func.count(ConversationParticipant.member_id.distinct()) == 2)
    ).scalar_subquery()
    exactly_two_participants = (
        select(ConversationParticipant.conversation_id)
        .where(ConversationParticipant.conversation_id.in_(matched_conv_ids))
        .group_by(ConversationParticipant.conversation_id)
        .having(func.count() == 2)
    ).scalar_subquery()

    existing = (
        await db.execute(
            select(Conversation)
            .where(
                Conversation.org_id == org_id,
                Conversation.type == "dm",
                Conversation.id.in_(exactly_two_participants),
            )
            .order_by(Conversation.updated_at.desc())
            .limit(1)
        )
    ).scalars().first()
    if existing is not None:
        return existing

    from app.routers.conversations import _create_conversation_record

    return await _create_conversation_record(
        db,
        org_id=org_id,
        project_id=project_id,
        member_ids={requester_id, approver_id},
        conv_type="dm",
        title=None,
        created_by=requester_id,
    )


async def dispatch_approval_request_cards(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_type: str,
    work_item_id: uuid.UUID,
    project_id: uuid.UUID | None,
    title: str,
    gate_id: uuid.UUID,
    requester_id: uuid.UUID,
    approver_ids: list[uuid.UUID],
    designated_approver_id: uuid.UUID | None = None,
) -> None:
    """승인자별 DM에 message_kind="request" 카드 메시지 게시 + SSE 이벤트(AC1/AC2).

    designated_approver_id: story #3001(선생님 정책 확定 2026-08-24, PR#3426 조건부→
    #3001로 정정) — 지정하면 그 1인에게만 카드가 간다(kind="request"). 나머지 approver_ids
    는 **카드 자체를 안 받는다** — "결재라인을 지정하면 그 사람에게만 도달해야" 원문,
    챗은 감사 공간이 아니라는 판정. #2985가 처음 만들었던 kind="request_info"(정보성 접힘)
    분기는 이 스토리로 걷어냈다(감사 가시성은 결재함·감사 로그가 담당). None(미지정)이면
    approver_ids 전원이 종전처럼 "request"(④ 미확定 — 현행 유지, 회귀 0).

    story #2118(E-DG-REAL ②, 2026-08-16) 이전엔 ``doc: Doc``을 직접 받는 doc 전용 함수였다 —
    호출부(merge_verdict_gate.py 등 다른 gate_type)가 doc 객체를 갖고 있지 않아 그대로 확장할
    수 없었다. work_item_type/work_item_id/project_id/title로 일반화(함수 로직 자체는 무변경 —
    doc 전용 필드 참조 4곳을 파라미터로 치환한 것뿐). FE(approval-request-card.tsx, #3149)는
    이미 work_item_type 제네릭으로 렌더하고, 카드 title 자체는 GET /api/gates/{id}의
    work_item_summary(gates.py _resolve_work_item_summary — doc/story/task 지원)에서 오므로
    이 함수의 ``title``은 메시지 본문(chat bubble text)에만 쓰인다(카드 렌더 값 아님).

    승인자별 SAVEPOINT 격리 — 한 승인자 배달 실패(예: DM insert 레이스)가 나머지 승인자
    배달이나, 이 함수를 부르는 caller의 게이트 생성 트랜잭션 자체를 poison 하지 않는다
    ([[feedback_savepoint_failopen_session_poison]] — bare flush 실패 후 세션 오염이 후속
    write를 통째로 삼키는 클래스).

    project_id 없는 work_item(비정상 상태 또는 project-무관 work_item_type)은 배달 스킵
    (무대상, 조용히 반환) — project 없이는 `_get_or_create_approval_dm`의 DM project_id를
    채울 수 없다.
    """
    if not project_id or not approver_ids:
        return

    # story #2985 — designated_approver_id는 반드시 approver_ids(해소 권한 실보유자) 안에
    # 있어야 유효하다. 벗어난 값(오탈자·이미 org를 떠난 member 등)을 그대로 믿으면 지정자가
    # 카드 자체를 못 받거나(루프가 approver_ids만 돎), 권한 없는 사람에게 액션 카드를 주는
    # 두 실패 중 하나가 조용히 난다 — fail-safe로 미지정(현행 전원-액션) 취급.
    if designated_approver_id is not None and designated_approver_id not in approver_ids:
        logger.warning(
            "approval-request designated_approver_id가 approver_ids 밖 — 미지정 취급 %s=%s designated=%s",
            work_item_type, work_item_id, designated_approver_id,
        )
        designated_approver_id = None

    from app.routers.conversations import _dispatch_conversation_event
    from app.services.member_resolver import lookup_members_by_ids

    requester = (await lookup_members_by_ids({requester_id}, db)).get(requester_id)
    if requester is None:
        logger.warning(
            "approval-request 카드 배달 스킵 — requester 미확인 %s=%s", work_item_type, work_item_id,
        )
        return

    # story #2985 잔존 — designated_approver_name은 이제 정보성 카드가 아니라 "위임됨" 표기
    # (story #3001)에서도 쓰인다(원 지정자 카드가 "{새 지정자 이름}에게 위임됨"을 보여줄 때).
    # 없으면(지정자 미확인) FE가 "지정 결재자"로 폴백 — 지어내지 않는다.
    designated_approver_name: str | None = None
    if designated_approver_id is not None:
        designated_member = (await lookup_members_by_ids({designated_approver_id}, db)).get(designated_approver_id)
        designated_approver_name = designated_member.name if designated_member is not None else None

    # story #3001 — 지정이 있으면 그 1인에게만(나머지는 카드 자체를 안 받음). 미지정이면
    # 현행대로 approver_ids 전원(④ 미확定, 회귀 0). 이 루프에 도달하는 수신자는 두 경우
    # 다 "이 카드의 액션 주체"라 kind="request"·expects_response=True·designated=True가
    # 항상 성립한다(정보성 kind="request_info" 분기는 이 스토리로 완전히 걷어냈다 — 카드가
    # 안 갈 사람은 애초에 이 루프 자체에 안 들어온다).
    recipients = [designated_approver_id] if designated_approver_id is not None else approver_ids

    # story #3084 층2(2026-08-25) — designated 케이스의 primary 카드가 실제로 심긴
    # conversation.id를 기억해 둔다(아래 자동 심기 best-effort가 같은 방을 "또 다른 방"으로
    # 오판해 무의미한 재삽입을 시도하지 않도록 — dispatch_approval_card_toss 자체는 멱등이라
    # 안전하지만, 방금 만든 신규 DM이 "최근 활성 1위"로 잡혀 매번 같은 방만 고르는 흔한
    # 케이스를 배제해야 층2가 실제로 의미가 있다).
    _primary_conv_id_for_designated: uuid.UUID | None = None

    # story #d9c09f4b(2026-08-27, customer-zero 실사고) — best-effort try/except가 "개별
    # 실패"와 "전멸"을 같은 무음으로 취급했다(실사고 자체는 배달이 아니라 잘못된
    # approver_member_id로 인한 오배달이었지만, 이 카운터는 그것과 별개로 유효한 방어층 —
    # DM insert 레이스 등 실제 예외가 recipients 전원에서 나는 케이스는 지금 로그 0줄로
    # 새 나간다). recipients가 이미 비지 않았음을 위에서 확인했으므로, 끝까지 돌고도
    # delivered_count==0이면 "성공과 전멸이 같은 무음"인 그 갭 그대로다.
    delivered_count = 0

    for approver_id in recipients:
        try:
            async with db.begin_nested():
                conv = await _get_or_create_approval_dm(
                    db,
                    org_id=org_id,
                    project_id=project_id,
                    requester_id=requester_id,
                    approver_id=approver_id,
                )
                if approver_id == designated_approver_id:
                    _primary_conv_id_for_designated = conv.id
                msg = ConversationMessage(
                    conversation_id=conv.id,
                    sender_id=requester_id,
                    content=f"'{title}' 결재 요청",
                    mentioned_ids=[approver_id],
                    msg_metadata={
                        "activation": {
                            "audience": [str(approver_id)],
                            "kind": "request",
                            "expects_response": True,
                        },
                        "approval_target": {
                            "work_item_type": work_item_type,
                            "work_item_id": str(work_item_id),
                            "gate_id": str(gate_id),
                            "actions": ["approve", "reject"],
                            "designated": True,
                            "designated_approver_name": designated_approver_name,
                        },
                    },
                )
                db.add(msg)
                await db.flush()
                await _dispatch_conversation_event(db, conv, msg, org_id, requester)
            delivered_count += 1
        except Exception:  # noqa: BLE001 — best-effort, 개별 승인자 실패가 상신을 막지 않음.
            logger.warning(
                "approval-request 카드 배달 실패 %s=%s approver=%s",
                work_item_type, work_item_id, approver_id, exc_info=True,
            )

    if delivered_count == 0:
        # ⚠️AC③ — 성공(delivered_count>0)과 전멸(모든 approver가 예외로 빠짐)이 지금까지
        # 같은 무음이었다(개별 실패는 WARNING이 나지만, "그래서 결국 몇 건 착지했나"는 어디도
        # 안 남았다). recipients가 이미 비지 않은 상태로 여기 도달했으므로, 이 WARNING은
        # "받을 사람이 원래 없었다"(위의 project_id/approver_ids 가드)와 확실히 구분된다.
        logger.warning(
            "approval-request 카드 배달 0건(전멸) %s=%s recipients=%s",
            work_item_type, work_item_id, recipients,
        )

    # story #3044(2026-08-25) — 카드가 실제로 간 recipients와 정확히 같은 대상에게
    # conversation.gate_created(순수 SSE, 새 챗버블 없음)도 심는다 — 결재함 목록이
    # "새 게이트가 생겼다"를 아예 못 듣던 갭(notify_gate_created_to_recipients 문서 참고).
    # after_commit 훅으로 자체 예약하므로(caller 협조 불요) 반환값을 스레딩할 필요가 없다.
    # best-effort — 실패해도 카드 배달(위 루프, 이미 끝남)은 막지 않는다.
    try:
        await notify_gate_created_to_recipients(
            db, org_id=org_id, project_id=project_id, gate_id=gate_id, recipient_ids=recipients,
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "gate_created 목록 실시간 반영 배선 실패 %s=%s", work_item_type, work_item_id, exc_info=True,
        )

    # story #3084 층2(2026-08-25, 정렬 v1 후순위·best-effort) — designated의 "최근 활성"
    # conversation(방금 심은 페어와이즈 DM과 다른 곳)에 카드 사본을 한 곳 더 심어본다.
    # 층1(GNB 뱃지)이 이미 도달을 보장하므로 이 규칙은 정교할 필요가 없다(정렬 결론) — 엉뚱한
    # 방을 고르거나 실패해도 사고가 아니다, 그래서 실패는 그냥 삼킨다(로그만·상신 자체는 이미
    # 위에서 끝났다).
    if designated_approver_id is not None and _primary_conv_id_for_designated is not None:
        try:
            await _maybe_auto_seed_designated_secondary_conversation(
                db, org_id=org_id, project_id=project_id, work_item_type=work_item_type,
                work_item_id=work_item_id, title=title, gate_id=gate_id,
                designated_approver_id=designated_approver_id, requester_id=requester_id,
                exclude_conversation_id=_primary_conv_id_for_designated,
            )
        except Exception:  # noqa: BLE001 — 정의상 best-effort.
            logger.warning(
                "gate 자동 심기(층2) 실패(비차단) %s=%s designated=%s",
                work_item_type, work_item_id, designated_approver_id, exc_info=True,
            )


async def _maybe_auto_seed_designated_secondary_conversation(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    work_item_type: str,
    work_item_id: uuid.UUID,
    title: str,
    gate_id: uuid.UUID,
    designated_approver_id: uuid.UUID,
    requester_id: uuid.UUID,
    exclude_conversation_id: uuid.UUID,
) -> None:
    """story #3084 층2 — designated가 참여 중이고 방금 심은 페어와이즈 DM(exclude_
    conversation_id)이 아닌 conversation 중 가장 최근 활성(Conversation.updated_at desc)
    1곳에 한해 카드 사본을 추가 삽입. `dispatch_approval_card_toss`를 그대로 재사용(신규
    삽입/멱등 로직 발명 0) — "시스템이 상신자를 대신해 미리 토스해 두는 것"과 동형이라
    `tossed_by_id=requester_id`.

    "최근 활성" 판정 오류(엉뚱한 방을 고름)는 사고가 아니다 — 층1(GNB 뱃지)이 이미 도달을
    보장하므로 이 규칙은 최선 추정이면 충분하다(정렬 결론, 정교한 «주 대화 결정 규칙» 설계는
    하지 않는다). 후보가 없으면(designated가 이 프로젝트에 다른 conversation이 없음) 조용히
    반환 — 층1이 여전히 도달을 보장하므로 실패로 취급하지 않는다."""
    candidate = (await db.execute(
        select(Conversation.id)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == Conversation.id)
        .where(
            Conversation.org_id == org_id,
            Conversation.project_id == project_id,
            Conversation.id != exclude_conversation_id,
            ConversationParticipant.member_id == designated_approver_id,
        )
        .order_by(Conversation.updated_at.desc())
        .limit(1)
    )).first()
    if candidate is None:
        return

    await dispatch_approval_card_toss(
        db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id, title=title,
        gate_id=gate_id, designated_approver_id=designated_approver_id,
        target_conversation_id=candidate[0], tossed_by_id=requester_id,
    )


_GATE_CREATED_PENDING_KEY = "s3044_pending_gate_created_pushes"
_GATE_CREATED_HOOKED_KEY = "s3044_gate_created_hook_installed"


async def notify_gate_created_to_recipients(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    gate_id: uuid.UUID,
    recipient_ids: list[uuid.UUID],
) -> None:
    """story #3044(PO 실사고 표본②, 2026-08-25 그라운딩) — 결재함(approvals-queue.tsx)이
    마운트 1회만 fetch하고 이후는 conversation.gate_resolved/gate_delegated 2종 SSE로만
    갱신되는 구조라 — 둘 다 **기존 항목의 상태 변화**만 다뤄, "새 게이트가 생겼다"를 알리는
    신호 자체가 없었다(전수 grep 확認). 이미 열어둔 탭에 새 게이트가 생기면 하드 리로드
    전까진 영원히 안 뜬다 — 챗 카드 직링크로만 도달 가능했던 실사고(gate 2a14c177)가 이 갭.

    notify_gate_card_recipients_resolved(위, 이 파일)와 동형 — 새 ConversationMessage는
    만들지 않는다(순수 SSE 신호, 카드는 dispatch_approval_request_cards가 이미 별도로
    맡는다 — 이중 배달 아님). recipient_ids는 호출부가 이미 계산해 넘긴다(dispatch_
    approval_request_cards의 `recipients` 산출과 동일 소스 — designated_approver_id가
    있으면 그 1인, 없으면 approver_ids 전원, 카드가 실제로 간 대상과 정확히 일치).

    ⚠️PO 정면 돌파 지시(2026-08-25, "우회/스킵 금지") — 이전 판은 caller가 반환값을 받아
    caller 자신의 commit 직후 push하는 계약이었다(notify_gate_card_recipients_resolved와
    동형). 그런데 dispatch_approval_request_cards의 실 호출부 4곳 중 gates.py(decision
    request)·gate_service.py(delegation) 2곳만 안전한 commit 지점을 쉽게 찾을 수 있었고,
    merge_verdict_gate.py(evaluate_merge_gate — 원 표본 2a14c177이 정확히 이 경로)·doc.py는
    호출 지점 이후에도 같은 트랜잭션에서 더 쓰기가 이어져(evaluate_merge_gate는 이 함수
    호출 뒤에도 gate.requires_human/decision_basis 등을 계속 쓰고 자기 자신은 commit을
    한 번도 안 한다 — 커밋은 8개나 되는 자기 호출부 각각이 각자 시점에 한다) 안전한 commit
    지점을 이 함수 안에서 특정할 수 없었다. **caller마다 반환값을 스레딩하는 대신**,
    event_seq.py의 _schedule_wake_after_commit(story #2381, 이미 검증된 동일 클래스
    문제의 기존 해법)과 완전히 동형으로 SQLAlchemy `after_commit` 세션 이벤트에 push를
    예약한다 — 이 세션이 **실제로 commit에 성공한 후에만**(rollback 시엔 안 불림) 자동
    발화되므로, 몇 개의 호출부가 있든·그 호출부가 어디서 commit하든 이 함수 자신은 몰라도
    된다(caller 협조 불요 — 새 호출부가 미래에 생겨도 이 함수를 거치기만 하면 구조적으로
    커버된다, "우회 없이" 8개 caller 전부를 실제로 돌파).

    ⚠️id 공간 매핑 경계(페드루 PO 요청, 2026-08-25 — 카디르 QA #3467 REQUEST_CHANGES①로 정정) —
    이 자리의 이전 판(커밋 e3bdb5e33)은 "team_members는 오늘 진짜 base table"이라 적었으나
    **오判이었다**(로컬 psql 확認이 이 뷰가 도입되기 전 상태의 스테일한 스크래치 DB를 겨눔 —
    카디르 CI 재현·본 세션에서 완전히 새로 만든 스크래치 DB 재확認으로 둘 다 반증). 정본:
    `team_members`는 0088에서 도입된 프로젝션 **뷰**(members ⋈ project_access, UNION ALL
    agent 분기)가 지금도 그대로다(`backend/alembic/baseline/schema.sql:2036`). `Event.
    recipient_id`도 재확認 결과 DB 레벨 FK 제약 자체가 없다(NOT NULL만) — 그럼에도 아래 필터는
    "team_members 뷰에 잡히지 않는 recipient는 메시징 신원이 없어 실제로 못 찾는다"는 응용
    계층 규율이라 필터 자체는 유효(제거하지 않는다).

    핵심은 여전히 유효 — `org_members`(role 권위 축, `get_project_role`의 "org owner/admin
    floor"가 사는 곳)와 `team_members`(메시징 신원 축, 이 뷰에 투영될 members+project_access
    명시 행이 있어야만 존재)는 **독립된 두 id 공간**이다(OrgMember.id는 uuid4 자체 발급 —
    members.id와 무관). "org admin이지만 이 프로젝트엔 team_members 행이 없는" recipient_id는
    authz(rule B floor)로는 승인 자격이 있어도 team_members 뷰엔 안 잡힌다(실사고 재현:
    test_2891 fixture가 이 정확한 케이스 — org admin을 OrgMember만으로 seed, members/
    project_access 없음). 여기서 그 서브셋을 사전에 걸러 스킵한다(로그만, 예외 전파 안 함) —
    dispatch_approval_request_cards의 챗 카드 배달(다른 신원 경로, Conversation 참가자 자격)은
    이 필터와 무관하게 그대로 간다."""
    if not recipient_ids:
        return

    from app.models.team import TeamMember
    from app.services.member_resolver import lookup_members_by_ids

    valid_ids = set((await db.execute(
        select(TeamMember.id).where(TeamMember.id.in_(recipient_ids), TeamMember.project_id == project_id)
    )).scalars().all())
    skipped = set(recipient_ids) - valid_ids
    if skipped:
        logger.warning(
            "gate_created SSE 스킵 — team_members(project_access) 신원 없음 gate=%s project=%s recipients=%s",
            gate_id, project_id, skipped,
        )
    if not valid_ids:
        return

    members = await lookup_members_by_ids(valid_ids, db)

    payload_base = {"gate_id": str(gate_id)}

    events: list[Event] = []
    for recipient_id in valid_ids:
        member = members.get(recipient_id)
        m_type = member.type if member is not None else "human"
        event = Event(
            project_id=project_id, org_id=org_id, event_type="conversation.gate_created",
            source_entity_type="gate", source_entity_id=gate_id,
            sender_id=None, recipient_id=recipient_id, recipient_type=m_type,
            payload=payload_base, status="pending",
        )
        db.add(event)
        events.append(event)

    await db.flush()
    for event in events:
        _schedule_gate_created_push_after_commit(
            db, str(event.recipient_id),
            {"event_id": str(event.id), "event_type": "conversation.gate_created", **payload_base,
             "recipient_id": str(event.recipient_id)},
        )


def _schedule_gate_created_push_after_commit(db: AsyncSession, pid_str: str, payload: dict) -> None:
    """event_seq.py의 _schedule_wake_after_commit과 완전히 동형(주석도 그쪽이 정본 — 여기선
    요지만) — commit 성공 後에만(rollback 시 미발화) _push_to_agent가 정확히 한 번 불리도록
    세션에 예약. MVCC 가시성 레이스 방지(commit 前 push하면 recipient가 GET해도 아직 안 보임)."""
    sync_session = db.sync_session
    if not isinstance(sync_session, Session):
        logger.debug("gate_created push scheduling skipped — sync_session is not a real Session (test double?)")
        return
    pending: list[tuple[str, dict]] = sync_session.info.setdefault(_GATE_CREATED_PENDING_KEY, [])
    pending.append((pid_str, payload))
    if not sync_session.info.get(_GATE_CREATED_HOOKED_KEY):
        sync_session.info[_GATE_CREATED_HOOKED_KEY] = True
        sa_event.listen(sync_session, "after_commit", _fire_pending_gate_created_pushes)
        sa_event.listen(sync_session, "after_rollback", _clear_pending_gate_created_pushes_on_rollback)


def _fire_pending_gate_created_pushes(sync_session: Session) -> None:
    """⚠️SAVEPOINT 유령 push(카디르 QA #3467 REQUEST_CHANGES②, 2026-08-25) — `after_commit`은
    SQLAlchemy가 outer 최종 commit뿐 아니라 `begin_nested()` SAVEPOINT를
    release(`nested.commit()`)할 때도 발화한다(실측: 콜백 안에서
    `in_nested_transaction()`이 그 순간엔 True). outer 트랜잭션이 이후 rollback돼도 이미
    push가 나가버려 "실은 durable하지 않은 이벤트"가 라이브로 새는 결함이었다.
    `in_nested_transaction()`이 True인 발화(=SAVEPOINT release)는 pending을 비우지 않고
    그대로 둔다 — 언젠가 진짜 outer commit의 after_commit이 다시 발화할 때(그때는
    in_nested_transaction()=False) 최종 발사된다. outer가 끝내 rollback되면
    after_rollback 훅(_clear_pending_gate_created_pushes_on_rollback)이 비운다."""
    if sync_session.in_nested_transaction():
        return
    pending = sync_session.info.pop(_GATE_CREATED_PENDING_KEY, None) or []
    if not pending:
        return
    from app.routers.events import _push_to_agent

    for pid_str, payload in pending:
        try:
            _push_to_agent(pid_str, payload)
        except Exception:  # noqa: BLE001
            logger.warning("post-commit gate_created push failed recipient=%s", pid_str, exc_info=True)


def _clear_pending_gate_created_pushes_on_rollback(sync_session: Session) -> None:
    sync_session.info.pop(_GATE_CREATED_PENDING_KEY, None)


async def dispatch_approval_result_reply(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_type: str,
    work_item_id: uuid.UUID,
    project_id: uuid.UUID,
    title: str,
    gate_id: uuid.UUID,
    requester_id: uuid.UUID,
    resolver_id: uuid.UUID,
    decision: str,
    resolution_note: str | None,
    event_type: str = "doc_approval_resolved",
) -> None:
    """story #2624: 게이트 해소(승인/반려) 결과를 상신자에게 회신 — dispatch_approval_
    request_cards의 반대 방향(승인자→상신자). P2(#3007)는 상신→승인자 카드 전방 경로만
    만들었고 해소→상신자 회신 후방 경로가 없어, 상신자가 게이트를 폴링해야만 결과를 알 수
    있었다(선생님 직접 지적, 실사례 2026-08-13 07:20 반려·상신자 무통지).

    story #2709(2026-08-17) — doc 전용(`doc: Doc` 객체)이던 시그니처를 일반화했다(새 함수
    발명 0, 파라미터화). `agent_decision_request`처럼 work_item이 Doc이 아니거나(또는
    work_item이 gate 자기참조뿐인 standalone) 호출부는 자기가 가진 값을 그대로 넘긴다.

    상신자↔해소자 기존 DM(같은 dm_pair_key — get_or_create가 인자 순서 무관하게 같은 방을
    찾는다)에 message_kind="result" 카드 게시 + 기존 _dispatch_conversation_event 재사용
    으로 메인 dispatch — 상신자가 agent면 **이 경로로** 도달한다(오늘 PO가 못 받았던 그
    자리, AC1). human 상신자는 추가로 벨 알림까지(dispatch_notification, agent는 기존
    관례대로 대상에서 제외 — approval_delivery.py의 dispatch_approval_request_cards와
    동일 비대칭).

    해소자 본인이 상신자인 경우(SoD가 정상적으로 막지만 방어심층) 자기-알림 스킵(AC3).
    """
    if not project_id or resolver_id == requester_id:
        return

    from app.routers.conversations import _dispatch_conversation_event
    from app.services.member_resolver import lookup_members_by_ids

    resolver = (await lookup_members_by_ids({resolver_id}, db)).get(resolver_id)
    if resolver is None:
        logger.warning("approval-result 회신 스킵 — resolver 미확인 work_item=%s", work_item_id)
        return

    # story #2789(2026-08-24) — 이 이진 매핑(approved 아니면 전부 "반려")은 "withdrawn"
    # (요청자 자기-철회, 이 함수의 새 호출자)이 들어오면 승인 거부인 것처럼 잘못 라벨링한다
    # — decision 값마다 명시로 라벨을 정한다(미지 값은 문자열 그대로, 지어내지 않는다).
    _DECISION_LABELS = {"approved": "승인", "rejected": "반려", "withdrawn": "철회"}
    decision_label = _DECISION_LABELS.get(decision, decision)
    content = f"'{title}' 결재 결과: {decision_label}"
    if resolution_note:
        content += f"\n사유: {resolution_note}"

    try:
        async with db.begin_nested():
            conv = await _get_or_create_approval_dm(
                db, org_id=org_id, project_id=project_id,
                requester_id=requester_id, approver_id=resolver_id,
            )
            msg = ConversationMessage(
                conversation_id=conv.id,
                sender_id=resolver_id,
                content=content,
                mentioned_ids=[requester_id],
                msg_metadata={
                    "activation": {
                        "audience": [str(requester_id)],
                        "kind": "result",
                        "expects_response": False,
                    },
                    "approval_target": {
                        "work_item_type": work_item_type,
                        "work_item_id": str(work_item_id),
                        "gate_id": str(gate_id),
                        "decision": decision,
                        "resolution_note": resolution_note,
                    },
                },
            )
            db.add(msg)
            await db.flush()
            await _dispatch_conversation_event(db, conv, msg, org_id, resolver)
    except Exception:  # noqa: BLE001 — best-effort, 회신 실패가 해소를 막지 않음.
        logger.warning(
            "approval-result 회신 배달 실패 work_item=%s requester=%s",
            work_item_id, requester_id, exc_info=True,
        )
        # ⛔카디르 QA(#3015): 여기 `return`이 있으면 DM 실패가 아래 벨 알림까지 같이
        # 죽인다 — "별개 SAVEPOINT·독립"이라는 이 함수의 약속과 정반대(단방향 의존).
        # 이 PR이 막으려던 "폴링 없인 결과 모름"이 정확히 이 실패모드에서 재발한다 —
        # DM 실패해도 벨은 별도로 시도해야 하므로 return하지 않고 다음 블록으로 진행.

    # human 상신자에겐 벨 알림도(AC1). 위 DM dispatch와 완전히 독립된 형제 try/except —
    # 하나 실패해도 다른 하나는 그대로 시도된다(doc.py의 벨-알림/카드-배달 독립 채널 관례와
    # 진짜 동형 — DM 블록의 실패가 여기로 전파되지 않는다).
    try:
        requester = (await lookup_members_by_ids({requester_id}, db)).get(requester_id)
        if requester is not None and requester.type == "human":
            async with db.begin_nested():
                from app.services.notification_dispatch import dispatch_notification
                await dispatch_notification(
                    db, org_id=org_id, event_type=event_type,
                    target_member_ids=[requester_id],
                    title=f"결재 결과: {decision_label}",
                    body=resolution_note or f"'{title}'가 {decision_label}됐습니다.",
                    reference_type="gate", reference_id=gate_id,
                    source_project_id=project_id,
                    # story #2696: outbox 이관(동일 결함 클래스 예방).
                    via_outbox=True,
                )
    except Exception:  # noqa: BLE001 — 벨 알림 실패는 카드 배달과 독립.
        logger.warning(
            "approval-result 벨 알림 실패 work_item=%s requester=%s",
            work_item_id, requester_id, exc_info=True,
        )


async def dispatch_approval_discussion_reply(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    doc: Doc,
    gate_id: uuid.UUID,
    requester_id: uuid.UUID,
    resolver_id: uuid.UUID,
    reason: str,
) -> None:
    """story #2631 — `dispatch_approval_result_reply`의 자매 함수. 승인/반려 둘 중 하나로
    강제되지 않고 "보류(논의 필요)"를 표현하고 싶다는 게 원 실사용 요구(선생님 08-13
    19:49) — 이 함수가 그 세 번째 회신 형태. 게이트는 pending 그대로라 gate.status를
    참조하지 않는다(호출부 request_gate_discussion이 이미 pending 확인 완료).

    구조는 dispatch_approval_result_reply와 동형(같은 DM·독립 SAVEPOINT 둘·human만 벨) —
    `decision`/`message_kind`/알림 문구만 논의-요청 전용으로 갈린다."""
    if not doc.project_id or resolver_id == requester_id:
        return

    from app.routers.conversations import _dispatch_conversation_event
    from app.services.member_resolver import lookup_members_by_ids

    resolver = (await lookup_members_by_ids({resolver_id}, db)).get(resolver_id)
    if resolver is None:
        logger.warning("approval-discussion 회신 스킵 — resolver 미확인 doc=%s", doc.id)
        return

    content = f"'{doc.title}' 문서 결재 — 논의 요청\n사유: {reason}"

    try:
        async with db.begin_nested():
            conv = await _get_or_create_approval_dm(
                db, org_id=org_id, project_id=doc.project_id,
                requester_id=requester_id, approver_id=resolver_id,
            )
            msg = ConversationMessage(
                conversation_id=conv.id,
                sender_id=resolver_id,
                content=content,
                mentioned_ids=[requester_id],
                msg_metadata={
                    "activation": {
                        "audience": [str(requester_id)],
                        "kind": "discuss",
                        "expects_response": True,
                    },
                    "approval_target": {
                        "work_item_type": "doc",
                        "work_item_id": str(doc.id),
                        "gate_id": str(gate_id),
                        "decision": "discuss",
                        "resolution_note": reason,
                    },
                },
            )
            db.add(msg)
            await db.flush()
            await _dispatch_conversation_event(db, conv, msg, org_id, resolver)
    except Exception:  # noqa: BLE001 — best-effort, 회신 실패가 논의 요청 자체를 막지 않음.
        logger.warning(
            "approval-discussion 회신 배달 실패 doc=%s requester=%s",
            doc.id, requester_id, exc_info=True,
        )
        # dispatch_approval_result_reply와 동일 원칙 — DM 실패가 벨 알림까지 죽이지 않게
        # return하지 않고 다음 블록으로 진행.

    try:
        requester = (await lookup_members_by_ids({requester_id}, db)).get(requester_id)
        if requester is not None and requester.type == "human":
            async with db.begin_nested():
                from app.services.notification_dispatch import dispatch_notification
                await dispatch_notification(
                    db, org_id=org_id, event_type="doc_approval_discussion_requested",
                    target_member_ids=[requester_id],
                    title="문서 결재 — 논의 요청",
                    body=reason or f"'{doc.title}' 문서 결재에 대해 논의를 요청받았습니다.",
                    reference_type="gate", reference_id=gate_id,
                    source_project_id=doc.project_id,
                    # story #2696: outbox 이관(동일 결함 클래스 예방).
                    via_outbox=True,
                )
    except Exception:  # noqa: BLE001 — 벨 알림 실패는 카드 배달과 독립.
        logger.warning(
            "approval-discussion 벨 알림 실패 doc=%s requester=%s",
            doc.id, requester_id, exc_info=True,
        )


async def notify_gate_card_recipients_resolved(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    status: str,
    resolver_id: uuid.UUID | None,
    resolved_at,
) -> list[tuple[str, dict]]:
    """story #2985 AC2(PO 계약 확定 2026-08-24) — 해소 시 원 카드(액션 kind="request"·정보성
    kind="request_info" 무관)를 받았던 모든 승인자의 열린 화면이 새로고침 없이 "처리됨"으로
    갱신되도록, `conversation.gate_resolved` 이벤트를 심는다.

    새 ConversationMessage는 만들지 않는다(정보성 카드까지 해소마다 챗버블 스팸이 되는 것을
    피한다 — 순수 SSE 신호, 챗 히스토리에 안 남음).

    "실제 카드가 심어진 곳" 역조회 — approver_ids를 다시 계산하지 않고,
    dispatch_approval_request_cards가 그때 실제로 ConversationMessage.mentioned_ids에 태운
    값을 msg_metadata.approval_target.gate_id로 찾는다(conversations.py::
    _batch_resolve_linked_proof와 동일 축의 조회, 이 스토리에서 새로 발명한 메커니즘 아님) —
    그 사이 조직 멤버십이 바뀌어도(탈퇴 등) "그때 실제로 카드를 봤던 사람" 기준이라 안전.
    Event.project_id도 이 조회로 찾은 conversation의 실 project_id를 그대로 쓴다(호출자가
    gate_type별 project_id 해소 로직을 또 만들 필요 없음 — 카드가 이미 project-scope된 DM에
    심어져 있으므로).

    `_dispatch_conversation_event`(conversations.py)와 동일 계약 — Event를 DB에 남기고
    [(pid_str, payload)]를 반환할 뿐, 실 SSE push(`_push_to_agent`)는 호출자가 commit 後에
    한다(레이스 방지 원칙 동일 — Event가 커밋된 상태에서 push해야 클라가 재조회해도 일관된
    값을 본다)."""
    rows = (await db.execute(
        select(ConversationMessage.conversation_id, ConversationMessage.mentioned_ids).where(
            ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate_id),
        )
    )).all()
    if not rows:
        return []

    conv_ids = {row.conversation_id for row in rows}
    conv_project_ids = dict((await db.execute(
        select(Conversation.id, Conversation.project_id).where(Conversation.id.in_(conv_ids))
    )).all())

    recipient_project_ids: dict[uuid.UUID, uuid.UUID] = {}
    for row in rows:
        proj_id = conv_project_ids.get(row.conversation_id)
        if proj_id is None:
            continue  # project 없는 conversation은 스킵(Event.project_id NOT NULL) — 조용히 건너뜀.
        for mid in (row.mentioned_ids or []):
            try:
                recipient_project_ids[uuid.UUID(str(mid))] = proj_id
            except (ValueError, TypeError, AttributeError):
                continue  # 손상된/구형 payload — 지어내지 않고 건너뜀(_batch_resolve_linked_proof 동일 관례).
    if not recipient_project_ids:
        return []

    from app.services.member_resolver import lookup_members_by_ids
    members = await lookup_members_by_ids(set(recipient_project_ids), db)

    payload_base = {
        "gate_id": str(gate_id), "status": status,
        "resolver_id": str(resolver_id) if resolver_id else None,
        "resolved_at": resolved_at.isoformat() if resolved_at else None,
    }

    events: list[Event] = []
    for member_id, proj_id in recipient_project_ids.items():
        member = members.get(member_id)
        m_type = member.type if member is not None else "human"
        event = Event(
            project_id=proj_id, org_id=org_id, event_type="conversation.gate_resolved",
            source_entity_type="gate", source_entity_id=gate_id,
            sender_id=resolver_id, recipient_id=member_id, recipient_type=m_type,
            payload=payload_base, status="pending",
        )
        db.add(event)
        events.append(event)

    await db.flush()
    pushes: list[tuple[str, dict]] = []
    for event in events:
        pushes.append((
            str(event.recipient_id),
            {"event_id": str(event.id), "event_type": "conversation.gate_resolved", **payload_base,
             "recipient_id": str(event.recipient_id)},
        ))
    return pushes


async def notify_gate_delegated_to_old_approver(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    old_approver_id: uuid.UUID,
    new_approver_id: uuid.UUID,
) -> list[tuple[str, dict]]:
    """story #3001(선생님 정책 확定 2026-08-24) — 위임 시 원 지정자(호출자)의 열린 카드가
    새로고침 없이 "위임됨"으로 갱신되도록 conversation.gate_delegated 이벤트를 심는다.
    notify_gate_card_recipients_resolved와 동일 계약 — 새 ConversationMessage는 안 만들고
    (챗버블 스팸 방지), Event를 DB에 남기고 [(pid_str, payload)]를 반환할 뿐. 실 SSE push
    (`_push_to_agent`)는 호출자가 commit 後에 한다.

    old_approver_id의 project_id는 그 사람이 실제로 카드를 받았던 conversation(원 요청
    카드가 심어진 DM)에서 그대로 가져온다 — notify_gate_card_recipients_resolved의 "실제
    카드 심어진 곳" 역조회와 동일 원칙(gate_type별 project_id 재해소 로직 불필요)."""
    row = (await db.execute(
        select(ConversationMessage.conversation_id).where(
            ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate_id),
            ConversationMessage.mentioned_ids.contains([old_approver_id]),
        ).limit(1)
    )).first()
    if row is None:
        return []
    conversation_id = row[0]
    proj_id = (await db.execute(
        select(Conversation.project_id).where(Conversation.id == conversation_id)
    )).scalar_one_or_none()
    if proj_id is None:
        return []

    from app.services.member_resolver import lookup_members_by_ids
    members = await lookup_members_by_ids({old_approver_id, new_approver_id}, db)
    old_member = members.get(old_approver_id)
    new_member = members.get(new_approver_id)

    payload_base = {
        "gate_id": str(gate_id),
        "new_approver_id": str(new_approver_id),
        "new_approver_name": new_member.name if new_member is not None else None,
    }

    event = Event(
        project_id=proj_id, org_id=org_id, event_type="conversation.gate_delegated",
        source_entity_type="gate", source_entity_id=gate_id,
        sender_id=new_approver_id, recipient_id=old_approver_id,
        recipient_type=old_member.type if old_member is not None else "human",
        payload=payload_base, status="pending",
    )
    db.add(event)
    await db.flush()

    return [(
        str(old_approver_id),
        {"event_id": str(event.id), "event_type": "conversation.gate_delegated", **payload_base,
         "recipient_id": str(old_approver_id)},
    )]


async def dispatch_approval_card_toss(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_type: str,
    work_item_id: uuid.UUID,
    title: str,
    gate_id: uuid.UUID,
    designated_approver_id: uuid.UUID,
    target_conversation_id: uuid.UUID,
    tossed_by_id: uuid.UUID,
) -> bool:
    """story #3084(2026-08-25, 선생님 정렬 v1 층3) — designated 결재자 본인 또는 상신자가
    카드를 다른(designated 본인이 참여한) conversation에 **복제** 심는다. #3001 delegate
    ("사람" 축 — 정체성 재지정, 카드 1개 유지)와 다른 "방" 축 — 같은 designated에게로
    가는 도달 경로를 하나 더 여는 것뿐이라, 과거 기각된 "여러 사람으로의 카드 확산" 정책과
    상충하지 않는다(페드루 PO 정렬 확定 2026-08-25).

    카드 스키마 신설 없음(미르코 FE 그라운딩) — dispatch_approval_request_cards와 동일
    모양의 ConversationMessage를 대상 conversation에 한 번 더 심을 뿐, gate_id 역참조
    (msg_metadata.approval_target.gate_id) 하나로 여러 conversation의 카드가 전부 같은
    게이트를 가리키는 기존 다중-approver 배달 구조를 그대로 재사용한다 — 신규 잠금/멱등
    메커니즘도 불요(Gate.status FOR UPDATE가 이미 SSOT, notify_gate_card_recipients_
    resolved가 이미 gate_id 기준 전체 conversation을 커버).

    멱등: 대상 conversation에 이미 이 gate_id를 가리키는 카드가 있으면 새로 심지 않고
    False를 반환(호출부가 "이미 토스됨"으로 조용히 취급 — 에러 아님). 신규 삽입 시 True.

    ⚠️페드루 PO 비차단 관찰(PR#3488 리뷰, 2026-08-25) — False가 «멱등»과 «lookup 실패»
    둘을 겸용하면 안 된다: 이 함수는 비-best-effort(카드 삽입=토스 "됐다"는 응답 그 자체,
    #2142 "조용히 넘어가는 게 제일 나쁜 것" 원칙)라, tossed_by/target_conversation을 못
    찾는 건 "이미 있다"와 의미가 완전히 다르다(전자는 예상 밖 실패, 후자는 정상 상태).
    False는 **오직 멱등 no-op**만 의미하도록 좁히고, lookup 실패는 예외로 올려 caller가
    (현재는 라우터의 사전 검증으로 도달 불가하지만) 침묵 200으로 착시되지 않게 한다.

    인가(호출자가 requester/designated 본인인지)·대상 검증(designated가 target_
    conversation 참여자인지, 카드=지정 라인 전용 정책 유지)은 라우터(gates.py::
    toss_gate_endpoint)가 이 함수 호출 **전에** 이미 강제한다 — 이 함수 자신은 인가를
    다시 하지 않는다(SoD 판정은 단일 지점, #3001 delegate와 동일 분업)."""
    existing = (await db.execute(
        select(ConversationMessage.id).where(
            ConversationMessage.conversation_id == target_conversation_id,
            ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate_id),
        ).limit(1)
    )).first()
    if existing is not None:
        return False

    from app.routers.conversations import _dispatch_conversation_event
    from app.services.member_resolver import lookup_members_by_ids

    members = await lookup_members_by_ids({designated_approver_id, tossed_by_id}, db)
    tossed_by = members.get(tossed_by_id)
    designated_member = members.get(designated_approver_id)
    if tossed_by is None:
        raise RuntimeError(f"gate toss 카드 삽입 실패 — tossed_by 미확인 gate={gate_id} tossed_by_id={tossed_by_id}")

    conv = (await db.execute(
        select(Conversation).where(Conversation.id == target_conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise RuntimeError(
            f"gate toss 카드 삽입 실패 — 대상 conversation 미확인 gate={gate_id} conv={target_conversation_id}",
        )

    async with db.begin_nested():
        msg = ConversationMessage(
            conversation_id=conv.id,
            sender_id=tossed_by_id,
            content=f"'{title}' 결재 요청 (토스됨)",
            mentioned_ids=[designated_approver_id],
            msg_metadata={
                "activation": {
                    "audience": [str(designated_approver_id)],
                    "kind": "request",
                    "expects_response": True,
                },
                "approval_target": {
                    "work_item_type": work_item_type,
                    "work_item_id": str(work_item_id),
                    "gate_id": str(gate_id),
                    "actions": ["approve", "reject"],
                    "designated": True,
                    "designated_approver_name": designated_member.name if designated_member is not None else None,
                    "tossed": True,
                    "tossed_by_id": str(tossed_by_id),
                },
            },
        )
        db.add(msg)
        await db.flush()
        await _dispatch_conversation_event(db, conv, msg, org_id, tossed_by)
    return True


async def notify_gate_tossed(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    target_conversation_id: uuid.UUID,
    tossed_by_id: uuid.UUID,
) -> list[tuple[str, dict]]:
    """story #3084 층3 — notify_gate_card_recipients_resolved/notify_gate_delegated_to_
    old_approver와 동형(gate_id 기준 reverse-lookup, 새 ConversationMessage는 안 만듦,
    순수 SSE) — 새 사본이 하나 더 생겼음을 **기존에 이미 카드를 갖고 있던 모든 conversation
    의 수신자**에게 알린다. 미르코 FE 요건② — mux 구독(gate_resolved/gate_delegated와
    동일 패턴)이 conversation_id 무관 gate_id 매칭이라, 이 이벤트 하나로 다방 동기 전이가
    끝난다(이미 열린 화면 전부에 닿는다)."""
    rows = (await db.execute(
        select(ConversationMessage.conversation_id, ConversationMessage.mentioned_ids).where(
            ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate_id),
        )
    )).all()
    if not rows:
        return []

    conv_ids = {row.conversation_id for row in rows}
    conv_project_ids = dict((await db.execute(
        select(Conversation.id, Conversation.project_id).where(Conversation.id.in_(conv_ids))
    )).all())

    recipient_project_ids: dict[uuid.UUID, uuid.UUID] = {}
    for row in rows:
        proj_id = conv_project_ids.get(row.conversation_id)
        if proj_id is None:
            continue  # project 없는 conversation은 스킵(Event.project_id NOT NULL) — 조용히 건너뜀.
        for mid in (row.mentioned_ids or []):
            try:
                recipient_project_ids[uuid.UUID(str(mid))] = proj_id
            except (ValueError, TypeError, AttributeError):
                continue  # 손상된/구형 payload — 지어내지 않고 건너뜀.
    if not recipient_project_ids:
        return []

    from app.services.member_resolver import lookup_members_by_ids
    members = await lookup_members_by_ids(set(recipient_project_ids), db)

    payload_base = {
        "gate_id": str(gate_id),
        "target_conversation_id": str(target_conversation_id),
        "tossed_by_id": str(tossed_by_id),
    }

    events: list[Event] = []
    for member_id, proj_id in recipient_project_ids.items():
        member = members.get(member_id)
        m_type = member.type if member is not None else "human"
        event = Event(
            project_id=proj_id, org_id=org_id, event_type="conversation.gate_tossed",
            source_entity_type="gate", source_entity_id=gate_id,
            sender_id=tossed_by_id, recipient_id=member_id, recipient_type=m_type,
            payload=payload_base, status="pending",
        )
        db.add(event)
        events.append(event)

    await db.flush()
    pushes: list[tuple[str, dict]] = []
    for event in events:
        pushes.append((
            str(event.recipient_id),
            {"event_id": str(event.id), "event_type": "conversation.gate_tossed", **payload_base,
             "recipient_id": str(event.recipient_id)},
        ))
    return pushes


async def _has_open_external_publish_gate_for_doc(
    db: AsyncSession, *, org_id: uuid.UUID, doc_id: uuid.UUID,
) -> bool:
    """story d1f4afcb AC2 — 이 doc이 이미 열린(pending/rejected) `external_publish` 게이트의
    대상 산출물인지. Gate는 doc을 직접 work_item으로 갖지 않는다(work_item_type/id는 그
    게이트를 만든 레시피의 work item — 보통 story — 이고, doc은 `neutral_facts.
    draft_doc_reference_token`에 참조 토큰으로만 실린다, `recipe_gate_hooks.py::
    _build_approval_neutral_facts` 참조 — payload.previous_output_doc_id 우선·entity_
    references 폴백 두 경로 모두 이 필드로 수렴하므로 여기서도 이 필드 하나만 보면
    충분하다, 새 경로 발명 0). 토큰 포맷은 `reference_token.py::build_reference_token`이
    고정한 `[title](entity:doc:<uuid>)` — 그 안의 `entity:doc:<uuid>` 부분 문자열로 매치
    (UUID는 LIKE 메타문자를 포함하지 않아 이스케이프 불요)."""
    from app.models.gate import Gate

    marker = f"entity:doc:{doc_id}"
    row = (await db.execute(
        select(Gate.id).where(
            Gate.org_id == org_id,
            Gate.gate_type == "external_publish",
            Gate.status.in_(("pending", "rejected")),
            Gate.neutral_facts["draft_doc_reference_token"].astext.like(f"%{marker}%"),
        ).limit(1)
    )).first()
    return row is not None


async def maybe_nudge_draft_doc_shared_in_chat(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    doc_id: uuid.UUID,
    doc_title: str,
    doc_status: str,
    doc_author_id: uuid.UUID | None,
    sender_id: uuid.UUID,
) -> None:
    """story #2747(2026-08-25, PO 판정) — draft 상태 문서가 채팅에서 mention(=논의)되는
    순간, 작성자에게 「결재 상신 여부」를 묻는 1회성 넛지. 제품이 그 갈림 자체를 안
    묻던 갭(선생님 실증 2건, 2026-08-18)의 처방 — 후보 a(설계 스케치)의 「묻기」 절반만
    이번 사이클 스코프(FE 뱃지·N회 카운트 nudge·에이전트 리마인더 격상은 각각 별도 스토리,
    PO 확定 2026-08-25).

    ⛔PO AC — ①**1회성이 실제로 1회**여야 한다: 같은 doc은 **발신자·대화 무관 작성자당
    전역 1회**(서로 다른 두 사람이 각자 딴 시점·딴 DM에서 같은 draft doc을 mention해도
    통산 1건만) ②수신자는 **doc 작성자만**(대화 참여자 전체 노이즈 금지).

    카디르 QA(#3465, 2026-08-25) — 최초 구현은 (발신자,작성자) DM의 메시지 로그를
    SSOT로 삼았는데, 키 축이 틀렸다(작성자당 전역이어야 할 게 DM당이 됨 — 서로 다른
    발신자가 각자 새 DM에서 mention하면 각각 새 넛지가 나갔다, 실PG 2경로 재현:
    동시 asyncio.gather·순차 2인 상이 대화) + SELECT→INSERT가 SAVEPOINT일 뿐이라
    동시 호출 둘 다 SELECT를 통과할 수 있었다(격리 보장 아님). `DocChatNudgeDispatch`
    uq(org_id, doc_id) UNIQUE 제약으로 "이 doc에 넛지를 보내겠다"를 **원자적 reservation
    row INSERT**로 바꾼다 — 실패(IntegrityError=이미 있음)하면 DB가 직렬화해 준
    사실 그대로 조용히 skip(app 레벨 락/텍스트비교 아닌 실 제약, PO 지시 그대로 새
    테이블 도입).

    story d1f4afcb(2026-09-02, 담롱 그라운딩·PO 판정) — ③이 doc에 이미 **열린 external_
    publish 게이트**(pending·rejected)가 있으면 넛지를 내지 않는다(`_has_open_external_
    publish_gate_for_doc`) — 그 게이트가 이미 이 doc의 발행/반려를 관장 중인데 별도 문서
    결재를 권하면 실행자를 다른 경로로 오도한다. ④이 함수를 트리거하는 채팅 메시지가
    **시스템/이벤트 발신**(`msg_metadata['event']` 보유)이면 애초에 호출부(conversations.py
    ::send_message)가 이 함수를 부르지 않는다(사람의 대화 맥락에서만 넛지가 뜬다는
    전제 — 호출부 주석 참조).
    """
    if doc_status != "draft" or not doc_author_id or not project_id:
        return
    if doc_author_id == sender_id:
        return  # 본인이 스스로 공유한 것 — 자기-알림 스킵(기존 관례 동형).

    if await _has_open_external_publish_gate_for_doc(db, org_id=org_id, doc_id=doc_id):
        return  # story d1f4afcb AC2 — 이 doc은 이미 external_publish 게이트가 발행/반려를
        # 관장 중이다. 별도 문서 결재(submit_for_approval) 상신을 권하면 그 게이트와
        # 모순되는 두 번째 경로를 만들어 실행자를 오도한다(레시피 발행/재발행이 정답 경로 —
        # #3330 preset.gate.verdict 통지가 그 길을 이미 안내한다, 새 경로 발명 0).

    from sqlalchemy.exc import IntegrityError

    from app.models.doc_chat_nudge_dispatch import DocChatNudgeDispatch
    from app.services.member_resolver import lookup_members_by_ids

    author = (await lookup_members_by_ids({doc_author_id}, db)).get(doc_author_id)
    if author is None:
        return

    # 카디르 QA 2R(#3465, 2026-08-25) — reservation INSERT와 실 배달(DM/메시지)을 **분리한
    # 두 SAVEPOINT**로 짜면 반대편 구멍이 열린다: reservation이 먼저 release된 뒤 배달이
    # 실패(예: 일시적 DB 오류)하면 그 예외는 흡수되고 reservation만 외부 트랜잭션에 남아
    # 그 doc 넛지가 **영구 0건**(모든 미래 재시도가 "이미 있음"으로 오판)이 된다 — 중복
    # (무해)보다 침묵 영구화(기능 무력화)가 더 나쁜 실패 모드였다(카디르 probe 실증).
    # 반드시 **같은 SAVEPOINT 원자 단위**로 묶는다 — 배달이 실패하면 reservation도 함께
    # 롤백돼 재시도 가능한 상태로 남는다. UNIQUE 위반(IntegrityError)은 이 단위 진입
    # 직후(reservation INSERT 시점)에 발생하므로 중복 방어는 그대로 유지된다.
    try:
        async with db.begin_nested():
            db.add(DocChatNudgeDispatch(
                id=uuid.uuid4(), org_id=org_id, doc_id=doc_id, author_id=doc_author_id,
            ))
            await db.flush()  # UNIQUE(org_id, doc_id) 위반이면 여기서 IntegrityError.

            conv = await _get_or_create_approval_dm(
                db, org_id=org_id, project_id=project_id,
                requester_id=sender_id, approver_id=doc_author_id,
            )
            msg = ConversationMessage(
                conversation_id=conv.id,
                sender_id=sender_id,
                content=f"'{doc_title}' 문서가 채팅에서 논의됐는데 아직 draft — 결재 상신하시겠습니까?",
                mentioned_ids=[doc_author_id],
                msg_metadata={
                    "activation": {
                        "audience": [str(doc_author_id)], "kind": "request", "expects_response": False,
                    },
                    "nudge_target": {"doc_id": str(doc_id), "kind": "draft_doc_chat_share"},
                },
            )
            db.add(msg)
            await db.flush()
            from app.routers.conversations import _dispatch_conversation_event
            await _dispatch_conversation_event(db, conv, msg, org_id, author)
            if author.type == "human":
                from app.services.notification_dispatch import dispatch_notification
                await dispatch_notification(
                    db, org_id=org_id, event_type="doc_draft_discussed_in_chat",
                    target_member_ids=[doc_author_id],
                    title="draft 문서가 채팅에서 논의됐습니다",
                    body=f"'{doc_title}' — 결재 상신 여부를 확인해 주세요.",
                    reference_type="doc", reference_id=doc_id,
                    source_project_id=project_id, via_outbox=True,
                )
    except IntegrityError as e:
        # 카디르 QA 4R(#3465, 2026-08-25) — `except IntegrityError: return`이 uq 위반이라는
        # 의도된 케이스보다 넓었다: 같은 SAVEPOINT 안 배달 단계에서 나는 다른 IntegrityError
        # (예: FK 위반)까지 "이미 예약됐다"로 오판해 무로그로 삼켰다 — 진단성 갭. 실 제약
        # 이름으로 분기: uq_doc_chat_nudge_dispatch_org_doc**만** 의도된 중복(조용히 skip),
        # 그 외는 예상 밖 실패로 로그(SAVEPOINT가 이미 reservation까지 롤백했으므로 이 doc은
        # "미예약" 상태로 남아 다음 mention 시 정상 재시도된다 — 영구 침묵 아님).
        #
        # 카디르 QA 5R — 4R의 `e.orig.constraint_name`이 asyncpg에선 항상 None이었다(4R 자체
        # 테스트가 "경고가 존재하나"만 봐서 no-op을 통과시킨 회귀). SQLAlchemy가 asyncpg
        # 예외를 어댑터 래퍼(AsyncAdapt_asyncpg_dbapi.Error)로 한 번 더 감싸고(`raise ... from
        # error` — `raise` 문 자체가 원본을 `__cause__`에 심는다) 실제 `constraint_name`은
        # 그 원본(asyncpg.exceptions.*) 쪽에만 있다 — `e.orig`가 아니라 `e.orig.__cause__`.
        # 드라이버별 차이를 흡수하려 `e.orig`도 먼저 보되(직접 노출하는 드라이버 대비),
        # 없으면 `__cause__`로 폴백한다.
        _orig = getattr(e, "orig", None)
        constraint = getattr(_orig, "constraint_name", None) or getattr(
            getattr(_orig, "__cause__", None), "constraint_name", None,
        )
        if constraint == "uq_doc_chat_nudge_dispatch_org_doc":
            return  # 이미 다른 호출이 성공적으로 예약+배달까지 마쳤다(같은 원자 단위였으므로).
        logger.warning(
            "draft doc 채팅공유 넛지 실패(비차단, 예상 밖 IntegrityError) doc=%s author=%s constraint=%s",
            doc_id, doc_author_id, constraint, exc_info=True,
        )
    except Exception:  # noqa: BLE001 — 넛지 실패는 메시지 전송 자체를 막지 않는다(best-effort).
        # SAVEPOINT가 reservation INSERT까지 함께 롤백했으므로 이 doc은 "미예약" 상태로
        # 남는다 — 다음 mention 시 정상 재시도된다(영구 침묵 아님).
        logger.warning("draft doc 채팅공유 넛지 실패(비차단) doc=%s author=%s", doc_id, doc_author_id, exc_info=True)
