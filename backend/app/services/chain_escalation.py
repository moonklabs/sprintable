"""story #2617/#2626: human-less 대화의 무감독 연쇄를 org 밖(owner/admin)으로 관측 승격.

DM 전용 예외(#3009)를 human-presence 예외로 일반화(channel_router.py)하면서, human이
없는 대화는 더 이상 chain-depth 게이트로 전달이 막히지 않는다(속도 우선, #2617 PO 지시) —
대신 "무감독 연쇄가 계속되고 있다"를 아무도 모르는 채로 두면 안 된다(AC4, 조용한 단락 금지).
이 모듈은 대화 참가자가 아니라 **org owner/admin**에게 대화 밖에서 알린다(그 대화엔 알릴
human이 아예 없으므로).

⛔재설계(story #2626, 2026-08-13 선생님 진단·PO 승인): 원 게이트 조건(depth > cap)은
human-less 대화에서 **영구 참인 상시 상태**(휴먼 앵커가 없어 리셋 불가)라, 24h dedup은
스팸의 «주기»만 정할 뿐 소음 자체를 못 없앴다(#3016 핫픽스로 킬스위치·기본 off). 여기서
트리거를 depth 카운트에서 **속도 기반 이상 에피소드**로 완전히 교체한다:
- 짧은 창(기본 5분, org 설정 가능) 안 메시지 수가 임계(기본 15, org 설정 가능)를 초과하면
  «에피소드 시작» — Redis에 활성 마커를 세우고 그때만 발화.
- 마커가 이미 있으면(같은 에피소드 진행 중) 재발화 없음.
- 창 이하로 떨어지면(다음 평가 시점에) 마커를 지운다(해소, 무알림) — 이후 재초과가 «새
  에피소드»로 재발화.
- 마커에 TTL(창×2)을 걸고 활성일 때마다 갱신 — 폭주가 멈추고 대화 자체가 조용해지면(해소를
  평가할 다음 메시지가 영영 안 옴) TTL이 자연 소멸시킨다. TTL 없이는 stale 마커가 다음
  진짜 폭주의 알림을 영구 억제하는 «상태 자가회수 부재» 결함(PO 필수 조건, 2026-08-13)이
  된다.
- 위와 별개로 15분 플래핑 쿨다운(짧은 SET NX)을 한 겹 더 둔다 — 임계 바로 위/아래로
  진동하는 신호가 에피소드를 빠르게 여닫아도 실 알림은 15분당 최대 1건.

정상 fleet 트래픽 실측(pgstat-probe-dev, 무인간 대화 44개·7일·3123메시지): 5분 창 내 최대
메시지수 p50=3·p90=6·p99=8·관측 max=8 — 기본 임계 15는 관측 max의 ~2배 여유(AC1 안전).

⚠️(story #2626 스코프) 이 알림은 «관측»이지 «차단»이 아니었다 — 집행(차단)은 story #2630
(아래 `_open_circuit_breaker`/`_auto_close_circuit_breaker` + `chain_circuit_breaker.py`)이
이 판별자 위에 얹는다. 진짜 A↔B 무한루프가 토큰을 계속 태우는 문제(패턴/콘텐츠 유사도 기반
탐지)는 여전히 이 모듈 스코프 밖(#2617 스토리 본문 «잔여 위험», 후속 축) — #2630이 닫는
것은 "속도축 에피소드가 열려 있는 동안 발신을 멈춘다"는 축 하나뿐이다.

story #2630: 서킷브레이커 open/release는 이 모듈이 owns하는 판별 상태기계(에피소드 시작/
진행/해소)의 **부작용**으로 트리거되지만, 코드는 분리한다(`_open_circuit_breaker`/
`_auto_close_circuit_breaker`는 판별 로직을 전혀 안 건드리고 옆에서 호출만 받는다) — 위
"이건 관측이지 차단이 아니다" 경계를 존중해 원 판별 함수(`_evaluate_episode_marker` 등)는
차단 개념을 모른다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

_FLAP_COOLDOWN_SEC = 15 * 60  # 플래핑 방지 — 실 알림은 15분당 최대 1건(#2626, PO 승인).


async def _get_org_config(db: AsyncSession, org_id: uuid.UUID) -> tuple[bool, int, int, str, str]:
    """(enabled, window_seconds, threshold, circuit_breaker_mode, circuit_breaker_release_mode) —
    org 행 없으면 코드 기본값(DEFAULT_*) 폴백."""
    from app.models.chain_escalation_org_config import (
        DEFAULT_CIRCUIT_BREAKER_MODE,
        DEFAULT_CIRCUIT_BREAKER_RELEASE_MODE,
        DEFAULT_THRESHOLD,
        DEFAULT_WINDOW_SECONDS,
        ChainEscalationOrgConfig,
    )

    row = (await db.execute(
        select(
            ChainEscalationOrgConfig.enabled,
            ChainEscalationOrgConfig.window_seconds,
            ChainEscalationOrgConfig.threshold,
            ChainEscalationOrgConfig.circuit_breaker_mode,
            ChainEscalationOrgConfig.circuit_breaker_release_mode,
        ).where(ChainEscalationOrgConfig.org_id == org_id)
    )).one_or_none()
    if row is None:
        return True, DEFAULT_WINDOW_SECONDS, DEFAULT_THRESHOLD, DEFAULT_CIRCUIT_BREAKER_MODE, DEFAULT_CIRCUIT_BREAKER_RELEASE_MODE
    return bool(row[0]), int(row[1]), int(row[2]), str(row[3]), str(row[4])


async def _open_circuit_breaker(
    db: AsyncSession, *, org_id: uuid.UUID, conversation_id: uuid.UUID, project_id: uuid.UUID | None,
) -> uuid.UUID:
    """story #2630: 서킷 open — 멱등(이미 열려 있으면 그 행을 그대로 반환, 중복 open 없음).

    `chain_circuit_breaker`의 부분 unique index(conversation_id, WHERE released_at IS NULL)가
    "대화당 open 행 최대 1개"를 DB 레벨로 강제한다. 이게 필요한 이유: release_mode='manual'
    org에서 에피소드가 자연 해소(마커 삭제)돼도 breaker 행은 안 닫히므로, 다음 재폭주가
    "started"를 다시 내면 이미 열린(미해제) 행이 있는 상태에서 또 열려는 시도가 된다 —
    ON CONFLICT DO NOTHING으로 그 재시도를 조용히 흡수하고, 이어지는 SELECT로 (새로 만들었든
    이미 있었든) 현재 open 행의 id를 얻는다 — 알림 reference_id로 그 id를 써야 하므로."""
    from app.models.chain_circuit_breaker import ChainCircuitBreaker

    await db.execute(
        pg_insert(ChainCircuitBreaker.__table__)
        .values(
            id=uuid.uuid4(), org_id=org_id, conversation_id=conversation_id, project_id=project_id,
        )
        .on_conflict_do_nothing(
            index_elements=["conversation_id"],
            index_where=ChainCircuitBreaker.released_at.is_(None),
        )
    )
    breaker_id = (await db.execute(
        select(ChainCircuitBreaker.id).where(
            ChainCircuitBreaker.conversation_id == conversation_id,
            ChainCircuitBreaker.released_at.is_(None),
        )
    )).scalar_one()
    return breaker_id


async def _auto_close_circuit_breaker(db: AsyncSession, conversation_id: uuid.UUID) -> None:
    """story #2630: release_mode='auto' org 전용 — 에피소드 자연 해소 시 열린 breaker를 닫는다.
    released_by는 NULL로 남긴다(사람이 안 눌렀다는 사실 자체가 감사 대상)."""
    from app.models.chain_circuit_breaker import ChainCircuitBreaker

    await db.execute(
        update(ChainCircuitBreaker)
        .where(
            ChainCircuitBreaker.conversation_id == conversation_id,
            ChainCircuitBreaker.released_at.is_(None),
        )
        .values(released_at=func.now(), release_reason="auto: episode resolved+cooldown")
    )


async def _recent_message_velocity(
    db: AsyncSession, conversation_id: uuid.UUID, window_seconds: int,
) -> int:
    """최근 window_seconds 안 이 대화의 메시지 수 — 속도축 실축. caller가 이미 human-less
    대화임을 확인했으므로(호출부 관례) 발신자 전부 agent라 별도 type 필터 없이 전량 카운트."""
    from app.models.conversation import ConversationMessage

    since = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)
    return (await db.execute(
        select(func.count()).select_from(ConversationMessage).where(
            ConversationMessage.conversation_id == conversation_id,
            ConversationMessage.created_at >= since,
        )
    )).scalar_one()


async def _evaluate_episode_marker(
    conversation_id: uuid.UUID, *, above_threshold: bool, ttl_seconds: int,
) -> str:
    """에피소드 마커 상태기계(Redis) — 반환값: "started"(새 에피소드)·"continuing"(진행
    중, 마커 TTL 갱신)·"resolved"(방금 해소, 마커 삭제)·"idle"(평상). Redis 불가 시
    "idle"(fail-closed — 미발화가 스팸보다 안전, #2617 PO 조건(a) 계승)."""
    from app.services import redis_shared

    key = redis_shared.key("chain_escalation", "episode", str(conversation_id))

    async def _op(client) -> str:
        if above_threshold:
            created = bool(await client.set(key, "1", nx=True, ex=ttl_seconds))
            if created:
                return "started"
            await client.expire(key, ttl_seconds)  # 진행 중 — TTL 갱신(침묵 시 자연 소멸 보장)
            return "continuing"
        deleted = await client.delete(key)
        return "resolved" if deleted else "idle"

    return await redis_shared.with_fallback(_op, lambda: "idle")


async def _claim_flap_cooldown_slot(conversation_id: uuid.UUID) -> bool:
    """플래핑 방지 — 15분/대화. True = 이번이 쿨다운 창의 첫 발화(알림 진행)."""
    from app.services import redis_shared

    key = redis_shared.key("chain_escalation", "cooldown", str(conversation_id))

    async def _op(client) -> bool:
        return bool(await client.set(key, "1", nx=True, ex=_FLAP_COOLDOWN_SEC))

    return await redis_shared.with_fallback(_op, lambda: False)


async def evaluate_unsupervised_chain_episode(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    conversation_id: uuid.UUID,
    project_id: uuid.UUID | None,
) -> None:
    """human-less 대화의 매 agent 메시지마다 호출 — 속도 기반 이상 에피소드를 평가하고,
    (story #2630) circuit_breaker_mode='block'이면 에피소드 시작/해소에 서킷 open/auto-close를
    걸고, 새 에피소드 시작에서만(+15분 플래핑 쿨다운 통과 시) org owner/admin에게 대화 밖
    알림. best-effort — 실패해도 메시지 발신 트랜잭션을 막지 않는다(caller가 savepoint로
    격리해 호출하는 것을 전제, doc.py의 approval 알림과 동일 관례).

    ⚠️서킷 open/close는 알림 성패와 독립이다 — 아래에서 flap 쿨다운에 막혀 알림이 스킵돼도
    breaker는 이미 열려/닫혀 있다(차단 자체는 스팸 방지 쿨다운의 대상이 아니다, "차단이
    소리 없이 안 걸리는" 사고를 피하려는 순서)."""
    try:
        enabled, window_seconds, threshold, cb_mode, cb_release_mode = await _get_org_config(db, org_id)
        if not enabled:
            return

        velocity = await _recent_message_velocity(db, conversation_id, window_seconds)
        above = velocity > threshold
        marker_state = await _evaluate_episode_marker(
            conversation_id, above_threshold=above, ttl_seconds=window_seconds * 2,
        )

        if marker_state == "resolved":
            if cb_release_mode == "auto":
                await _auto_close_circuit_breaker(db, conversation_id)
            return  # 해소는 (기존과 동일) 무알림 — release_mode='manual'이면 breaker는 열린 채 남는다.

        if marker_state != "started":
            return  # continuing(이미 처리됨)·idle(평상) — 발화도 open도 없음.

        breaker_id: uuid.UUID | None = None
        if cb_mode == "block":
            breaker_id = await _open_circuit_breaker(
                db, org_id=org_id, conversation_id=conversation_id, project_id=project_id,
            )

        if not await _claim_flap_cooldown_slot(conversation_id):
            return  # 새 에피소드지만 플래핑 쿨다운 중 — 알림만 skip(breaker는 위에서 이미 열림)

        from app.models.project import OrgMember
        from app.services.notification_dispatch import dispatch_notification

        approver_ids = (await db.execute(
            select(OrgMember.id).where(
                OrgMember.org_id == org_id,
                OrgMember.role.in_(("owner", "admin")),
                OrgMember.deleted_at.is_(None),
            )
        )).scalars().all()
        if not approver_ids:
            return

        # ⚠️deeplink_manifest_contract 스캐너(tests/deeplink_contract_lib.py)가 event_type=을
        # 정적 분석으로 역추적한다 — 조건부로 만든 지역변수를 kwarg로 넘기면 못 잡는다(리터럴
        # 아니면 "감싸는 함수의 파라미터"만 해석). 그래서 분기별로 event_type이 리터럴로 보이는
        # 별도 호출 2개를 둔다(공유 로직 추출 대신 — 스캐너가 요구하는 형태, PR #3022 CI 적발).
        if breaker_id is not None:
            await dispatch_notification(
                db, org_id=org_id, event_type="conversation.circuit_breaker_opened",
                target_member_ids=list(approver_ids),
                title="무인간 대화 자동 차단(서킷브레이커)",
                body=(
                    f"human 참가자가 없는 대화에서 최근 {window_seconds}초간 메시지 {velocity}건"
                    f"(임계 {threshold})이 발생해 agent 발신이 일시 차단되었습니다. "
                    "이 알림의 «차단 해제»로 즉시 풀 수 있습니다."
                ),
                reference_type="conversation", reference_id=breaker_id,
                source_project_id=project_id,
                via_outbox=True,
            )
        else:
            await dispatch_notification(
                db, org_id=org_id, event_type="conversation.unsupervised_chain_expired",
                target_member_ids=list(approver_ids),
                title="무인간 대화 무감독 연쇄 감지",
                body=(
                    f"human 참가자가 없는 대화에서 최근 {window_seconds}초간 메시지 {velocity}건"
                    f"(임계 {threshold})이 발생했습니다."
                ),
                reference_type="conversation", reference_id=conversation_id,
                source_project_id=project_id,
                via_outbox=True,
            )
    except Exception:  # noqa: BLE001 — best-effort, 메시지 발신을 막지 않는다.
        logger.warning(
            "unsupervised chain escalation failed conversation_id=%s", conversation_id, exc_info=True,
        )


async def get_open_circuit_breaker_id(db: AsyncSession, conversation_id: uuid.UUID) -> uuid.UUID | None:
    """story #2630: conversations.py send_message()의 발신-시점 차단 체크가 쓰는 조회.

    이 대화에 released_at IS NULL인 breaker 행이 있으면 그 id, 없으면 None. 이 행은
    human-less 대화에서만 열리므로(오픈 호출부 위 docstring), 존재 자체가 human-less를
    함의한다 — caller가 별도로 human 유무를 조회할 필요가 없다."""
    from app.models.chain_circuit_breaker import ChainCircuitBreaker

    return (await db.execute(
        select(ChainCircuitBreaker.id).where(
            ChainCircuitBreaker.conversation_id == conversation_id,
            ChainCircuitBreaker.released_at.is_(None),
        )
    )).scalar_one_or_none()


async def release_circuit_breaker(
    db: AsyncSession, *, conversation_id: uuid.UUID, released_by: uuid.UUID, reason: str | None,
) -> bool:
    """story #2630: 수동 해제(알림의 «차단 해제» 액션 → conversations.py release 엔드포인트가
    호출). 반환값: True=닫힌 open 행이 있었음, False=이미 닫혀 있었음(멱등 — 중복 클릭도
    에러 없이 no-op)."""
    from app.models.chain_circuit_breaker import ChainCircuitBreaker

    result = await db.execute(
        update(ChainCircuitBreaker)
        .where(
            ChainCircuitBreaker.conversation_id == conversation_id,
            ChainCircuitBreaker.released_at.is_(None),
        )
        .values(released_at=func.now(), released_by=released_by, release_reason=reason)
    )
    return result.rowcount > 0
