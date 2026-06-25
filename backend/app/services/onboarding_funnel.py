"""OB-4: 온보딩 funnel 계측 — 이벤트 카탈로그·PII 가드·record/emit (측정계약 doc SSOT).

측정계약 `ob-4-onboarding-funnel-measurement-contract` §1/§2/§4/§5. FE 4종은 프록시
`POST /onboarding/events`로 들어오고, BE 8종은 OB-1~3 동선 seam에서 `emit_onboarding_event`로 박는다.
**키 평문 미저장**(key_prefix prefix-only·전체키 패턴 reject·AC3).
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.onboarding_event import OnboardingEvent

logger = logging.getLogger(__name__)

# §1 canonical 11종 = FE 4(사용자행동) + BE 7(서버관측) + verify_started(FE).
EVENT_CATALOG = frozenset({
    "onboarding_started", "agent_created", "config_generated", "config_copied",
    "first_auth_seen", "stream_connected", "verify_started", "event_sent",
    "ack_received", "verified", "abandoned",
})
# BE-emit 8종(seam map). FE 4종(onboarding_started/config_copied/verify_started/abandoned_explicit)은
# OB-3 프록시로 들어온다.
BE_EMIT_EVENTS = frozenset({
    "agent_created", "config_generated", "first_auth_seen", "stream_connected",
    "event_sent", "ack_received", "verified", "abandoned",
})
# §4 실패사유 taxonomy(8).
FAILURE_REASONS = frozenset({
    "config_error", "no_copy", "no_auth", "stream_unreachable",
    "no_ack", "verify_timeout", "verify_error", "abandoned_explicit",
})

KEY_PREFIX_MAX = 12
# 전체키 형태(sk_live_/sk_test_ + 20자+) — 어느 필드든 발견 시 저장 거부(AC3).
_SECRET_RE = re.compile(r"sk_(live|test)_[A-Za-z0-9]{20,}")


def contains_secret(value: object) -> bool:
    """문자열/중첩 dict/list 어디든 전체키 패턴이 있으면 True(=저장 금지)."""
    if isinstance(value, str):
        return bool(_SECRET_RE.search(value))
    if isinstance(value, dict):
        return any(contains_secret(k) or contains_secret(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return any(contains_secret(v) for v in value)
    return False


def safe_key_prefix(api_key_plaintext: str | None) -> str | None:
    """api_key → prefix-only(≤12자). 평문키 절대 미저장."""
    if not api_key_plaintext:
        return None
    return api_key_plaintext[:KEY_PREFIX_MAX]


async def record_onboarding_event(
    db: AsyncSession,
    *,
    event: str,
    session_id: uuid.UUID | None = None,
    agent_id: uuid.UUID | None = None,
    org_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    runtime: str | None = None,
    env: str | None = None,
    transport: str | None = None,
    key_prefix: str | None = None,
    failure_reason: str | None = None,
    client_ts: datetime | None = None,
    meta: dict | None = None,
) -> OnboardingEvent:
    """단일 onboarding_event INSERT(저장 SSOT). 호출자가 commit.

    **RC-1 choke-point PII 방어(산티아고)**: 어느 호출자(endpoint·BE emit·future caller)든 이 단일
    저장 경로를 타므로, 여기서 secret-형태(전체키)를 한 번 더 막는다 — meta 등에 평문키가 섞이면
    ValueError raise(endpoint=422로 전환·emit=fail-silent로 미저장). key_prefix 는 ≤12 절삭(2중화).
    """
    if contains_secret({
        "key_prefix": key_prefix, "failure_reason": failure_reason,
        "runtime": runtime, "env": env, "transport": transport, "meta": meta,
    }):
        raise ValueError("onboarding event contains a secret-shaped value — refused")
    row = OnboardingEvent(
        event=event,
        session_id=session_id,
        agent_id=agent_id,
        org_id=org_id,
        project_id=project_id,
        runtime=runtime,
        env=env,
        transport=transport,
        key_prefix=(key_prefix[:KEY_PREFIX_MAX] if key_prefix else None),
        failure_reason=failure_reason,
        client_ts=client_ts,
        meta=meta or {},
    )
    db.add(row)
    await db.flush()
    return row


async def emit_onboarding_event(
    db: AsyncSession,
    event: str,
    *,
    agent_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    org_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    runtime: str | None = None,
    env: str | None = None,
    transport: str | None = None,
    key_prefix: str | None = None,
    failure_reason: str | None = None,
    meta: dict | None = None,
) -> None:
    """BE seam emit — **non-blocking·fail-silent**(측정이 wizard/런타임 UX 절대 안 막음).

    ``begin_nested``(SAVEPOINT)로 격리: emit flush 실패가 호출부 트랜잭션을 poison 하지 않게 한다
    (보조 write 실패→PendingRollbackError 방지). 실패는 삼키고 경고만 — 단일경로 fix·핫패스 무회귀.
    """
    try:
        async with db.begin_nested():
            await record_onboarding_event(
                db, event=event, agent_id=agent_id, session_id=session_id, org_id=org_id,
                project_id=project_id, runtime=runtime, env=env, transport=transport,
                key_prefix=key_prefix, failure_reason=failure_reason, meta=meta,
            )
    except Exception:
        logger.warning("onboarding emit failed event=%s agent=%s", event, agent_id, exc_info=True)


# ─── abandoned 파생(BE SoT·cron) ──────────────────────────────────────────────

ABANDON_THRESHOLD_MINUTES = 30


def _derive_abandon_reason(events: set[str]) -> str:
    """furthest 도달 단계로 실패사유 도출(§4 taxonomy). 단계가 멀수록 후반 사유."""
    if "event_sent" in events or "ack_received" in events:
        return "no_ack"             # verify 디스패치됐으나 ack 미도달
    if "stream_connected" in events:
        return "verify_timeout"     # 연결됐으나 verify 미시작/미완
    if "first_auth_seen" in events:
        return "stream_unreachable"  # 인증했으나 stream 미연결
    if "config_copied" in events:
        return "no_auth"            # 복사했으나 인증 안 함
    return "no_copy"                # config 생성됐으나 복사 안 함


async def sweep_abandoned_onboarding(
    db: AsyncSession, *, older_than_minutes: int = ABANDON_THRESHOLD_MINUTES
) -> int:
    """BE-SoT ``abandoned`` 파생: ``config_generated`` 후 ``older_than`` 경과·미``verified``·미``abandoned``
    인 에이전트마다 ``abandoned`` 1건 emit(furthest 단계로 failure_reason). cron 호출.

    **AC3 이중계상 금지**: terminal(``verified``/``abandoned``·FE ``abandoned_explicit`` 포함)이 이미
    있으면 skip — FE explicit/기존 cron-emit 과 중복 카운트하지 않는다. 호출자(cron)가 commit 됨.
    """
    threshold = datetime.now(timezone.utc) - timedelta(minutes=older_than_minutes)
    candidates = (await db.execute(
        select(OnboardingEvent.agent_id).where(
            OnboardingEvent.event == "config_generated",
            OnboardingEvent.agent_id.isnot(None),
            OnboardingEvent.server_ts < threshold,
        ).distinct()
    )).scalars().all()

    emitted = 0
    for agent_id in candidates:
        terminal = (await db.execute(
            select(OnboardingEvent.id).where(
                OnboardingEvent.agent_id == agent_id,
                OnboardingEvent.event.in_(("verified", "abandoned")),
            ).limit(1)
        )).first()
        if terminal:
            continue  # 이미 verified or abandoned → 이중계상 금지
        events = set((await db.execute(
            select(OnboardingEvent.event).where(OnboardingEvent.agent_id == agent_id)
        )).scalars().all())
        await record_onboarding_event(
            db, event="abandoned", agent_id=agent_id,
            failure_reason=_derive_abandon_reason(events),
        )
        emitted += 1
    await db.commit()
    return emitted
