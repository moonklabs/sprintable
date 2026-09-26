"""story #4341 — 플랫폼 운영 알림: 돈 · 발행이 멈춘 사건을 **사람이 받는 곳**(설정된 운영 대화)에 한 번 보내고 전달 결과를 돌려준다.

예전엔 결제 늦은 성공 무효 · 확정 환불 실패 · 발행 «예산 밖»이 전부 `logger.error` 한 줄로 끝나 받는 사람이 0이었다.

계약:
- `notify_operator(...)` → `OperatorAlertResult(delivered, reason, alert_id)`. 예외를 던지지 않는다(부르는 쪽은 결제 · 발행 흐름 —
  알림 실패가 그 흐름을 깨면 안 된다). `delivered=True`는 **메시지 행과 delivered 표시가 같은 커밋으로 저장된 뒤에만**.
- 멱등: `operator_alerts.dedupe_key` unique + 그 행 잠금(FOR UPDATE). 같은 사건을 몇 번 불러도(동시여도) 메시지 1.
- 받는 곳 미설정(`ops_alert_conversation_id` 빈 값) → `not_configured` · 행은 pending으로 남아 값이 들어오면 재시도가 보낸다(거짓 성공 0).
- 전달 실패 → pending 그대로 · `attempt_count`+1 · `next_attempt_at`을 뒤로(분 단위 2^n, 60분 상한) · 종결 없음(비종결).
- 재시도는 `process_due_operator_alerts`(`/publication-commands` tick에 독립 try로 얹힘) — 한 틱에 정해진 몫(건수 · 초) 안에서만 돌아
  같은 tick의 발행 처리 예산을 먹지 않는다.
- 거름: `target` · `facts`에는 uuid · 숫자(금액) · 대문자 코드 · 시각만 싣는다. 카드 번호 · 결제 키 · 토큰 · 이메일 원문처럼 보이는 값과
  그런 이름의 키는 버린다(버린 키 이름만 로그). 메시지와 표에 같은 거른 값이 들어간다.
- 자기 세션으로 돈다: `send_message_core`는 호출자 거래에 참여해 flush만 하므로, 부르는 쪽 거래를 먼저 커밋해 버리는 일이 없다.
"""
from __future__ import annotations

import logging
import re
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.operator_alert import OperatorAlert

logger = logging.getLogger(__name__)

# 한 번의 재시도 틱이 쓰는 몫 — 같은 tick의 발행 처리(4336 예산)를 먹지 않게 작게 둔다. 시간 몫은 «새 건을 시작하는» 마감이다
# (시작한 한 건은 끝까지 간다 — 보내기 하나는 DB 쓰기 한 거래).
RETRY_TICK_MAX_ITEMS = 20
RETRY_TICK_TIME_BUDGET_SECONDS = 5.0
_BACKOFF_CAP_MINUTES = 60

_KIND_RE = re.compile(r"^[a-z][a-z0-9_.]{0,63}$")
_DEDUPE_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,199}$")
_FIELD_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
# 값으로 허용하는 글: 대문자 코드(예: PAYMENT_LATE_CHARGE · HTTP_409) · uuid · ISO 시각.
_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9_.:\-]{0,63}$")
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ISO_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$")
# 카드 번호(13~19자리)처럼 보이는 숫자 줄 — 이름이 무엇이든 싣지 않는다. 구분자(공백 · - _ . : /)를 걷은 뒤 센다(까디르 4713:
# `4111-1111-1111-1111`이 «코드» 모양으로 통과했다). uuid · ISO 시각은 이 검사 전에 모양으로 먼저 받는다(걷으면 숫자 줄이 길어진다).
_LONG_DIGIT_RUN_RE = re.compile(r"\d{13,}")
_DIGIT_SEPARATORS_RE = re.compile(r"[\s\-_.:/]")
# 이름에 부분 문자열로 들어 있으면 값과 무관하게 버린다 — 소문자 · 밑줄을 걷은 이름에서 찾는다(까디르 4713: `cardnumber` · `apikey`
# · `emailaddress`가 조각 일치를 빠져나갔다). 넓게 걸려 무해한 이름을 버리는 쪽이 새는 쪽보다 낫다(fail-closed).
_SENSITIVE_NAME_FRAGMENTS = (
    "card", "cvc", "cvv", "key", "token", "secret", "passw", "auth", "mail", "phone", "account", "iban",
)


@dataclass(frozen=True)
class OperatorAlertResult:
    delivered: bool
    # delivered · already_delivered · not_configured · send_failed · busy(다른 틱이 같은 건을 보내는 중) · error(표에도 못 적음)
    reason: str
    alert_id: uuid.UUID | None


def _looks_like_card_number(text: str) -> bool:
    return bool(_LONG_DIGIT_RUN_RE.search(_DIGIT_SEPARATORS_RE.sub("", text)))


def _is_sensitive_name(name: str) -> bool:
    folded = name.lower().replace("_", "")
    return any(fragment in folded for fragment in _SENSITIVE_NAME_FRAGMENTS)


def _safe_value(value: Any) -> Any:
    """싣기 허용 값이면 JSON 값으로, 아니면 None(버림)."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, int):
        return value if not _LONG_DIGIT_RUN_RE.search(str(abs(value))) else None
    if isinstance(value, Decimal):
        return str(value) if not _looks_like_card_number(str(value)) else None
    if isinstance(value, float):
        return value if not _looks_like_card_number(repr(value)) else None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        if _UUID_RE.match(value) or _ISO_TIME_RE.match(value):
            return value
        if _looks_like_card_number(value):
            return None
        if _CODE_RE.match(value):
            return value
    return None


def sanitize_alert_fields(fields: dict[str, Any] | None) -> tuple[dict[str, Any], list[str]]:
    """(거른 값, 버린 키 이름). 이름이 민감해 보이거나 값이 허용 모양이 아니면 버린다 — 표 · 메시지 둘 다 이 결과만 쓴다."""
    kept: dict[str, Any] = {}
    dropped: list[str] = []
    for name, value in (fields or {}).items():
        name_s = str(name)
        if not _FIELD_NAME_RE.match(name_s) or _is_sensitive_name(name_s):
            dropped.append(name_s[:64])
            continue
        safe = _safe_value(value)
        if safe is None and value is not None:
            dropped.append(name_s)
            continue
        kept[name_s] = safe
    return kept, dropped


def _backoff(attempt_count: int) -> timedelta:
    return timedelta(minutes=min(2 ** max(attempt_count - 1, 0), _BACKOFF_CAP_MINUTES))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _configured_conversation_id() -> uuid.UUID | None:
    from app.core.config import settings

    raw = (settings.ops_alert_conversation_id or "").strip()
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        # 값이 망가졌으면 미설정과 같게 — 틀린 곳으로 보낸 척하지 않는다.
        logger.error("ops_alert_conversation_id is not a uuid — operator alerts stay pending")
        return None


def _render(alert: OperatorAlert) -> str:
    def line(values: dict[str, Any]) -> str:
        return ", ".join(f"{k}={v}" for k, v in values.items()) or "-"

    # 고정 모양의 코드성 표기(종류 · id · 코드 · 금액)라 로케일 문장을 만들지 않는다 — 운영 대화에서 그대로 검색 · 대조한다(story #3779 규율).
    return "\n".join([
        f"[ops alert] {alert.kind}",
        f"- org: {alert.target_org_id or '-'}",
        f"- target: {line(alert.target)}",
        f"- facts: {line(alert.facts)}",
        f"- event key: {alert.dedupe_key}",
    ])


def _failure_code(exc: BaseException) -> str:
    from fastapi import HTTPException

    if isinstance(exc, HTTPException):
        return f"http_{exc.status_code}"
    return type(exc).__name__[:64]


async def _send(db: AsyncSession, alert: OperatorAlert, conversation_id: uuid.UUID) -> uuid.UUID:
    """운영 대화에 메시지 한 건(flush만 — 커밋은 부르는 쪽). 새 메시지 id."""
    from fastapi import BackgroundTasks, HTTPException

    from app.dependencies.auth import AuthContext
    from app.models.conversation import Conversation, ConversationParticipant
    from app.routers.conversations import SendMessageRequest, send_message_core
    from app.routers.events import _get_or_create_system_publisher
    from app.services.after_commit import schedule_after_commit

    conv = (await db.execute(select(Conversation).where(Conversation.id == conversation_id))).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="ops alert conversation not found")
    publisher = await _get_or_create_system_publisher(db, conv.org_id)
    # 운영 대화에 보내려면 참가자여야 한다(send_message_core 참여자 검증). 설정으로 지정된 대화라 여기서 한 번 넣는다.
    await db.execute(
        pg_insert(ConversationParticipant)
        .values(id=uuid.uuid4(), conversation_id=conv.id, member_id=publisher.id)
        .on_conflict_do_nothing(constraint="uq_conversation_participant")
    )
    auth = AuthContext(
        user_id=str(publisher.id), email=None,
        claims={"app_metadata": {"api_key_id": "system-publisher"}}, org_id=str(conv.org_id),
    )
    background_tasks = BackgroundTasks()
    deliveries: list = []
    response = await send_message_core(
        conv.id,
        SendMessageRequest(
            content=_render(alert),
            event_context={"ops_alert": {"kind": alert.kind, "dedupe_key": alert.dedupe_key, "alert_id": str(alert.id)}},
        ),
        background_tasks, db=db, auth=auth, org_id=conv.org_id, after_commit=deliveries,
    )
    deliveries.append(background_tasks)
    # SSE · ws · background task는 이 세션이 커밋된 뒤에만 나간다(롤백되면 버려짐).
    schedule_after_commit(db, deliveries)
    return uuid.UUID(str(response["data"]["id"]))


async def _deliver(Session: async_sessionmaker, alert_id: uuid.UUID, *, skip_locked: bool) -> OperatorAlertResult:
    """행 하나를 잠그고 보낸다. 성공이면 메시지와 delivered 표시가 한 커밋."""
    conversation_id = _configured_conversation_id()
    async with Session() as db:
        try:
            alert = (await db.execute(
                select(OperatorAlert).where(OperatorAlert.id == alert_id).with_for_update(skip_locked=skip_locked)
            )).scalar_one_or_none()
            if alert is None:
                await db.rollback()
                return OperatorAlertResult(False, "busy", alert_id)
            if alert.status == "delivered":
                await db.rollback()
                return OperatorAlertResult(True, "already_delivered", alert_id)
            if conversation_id is None:
                alert.last_error = "not_configured"
                alert.next_attempt_at = _now()
                await db.commit()
                return OperatorAlertResult(False, "not_configured", alert_id)
            async with db.begin_nested():
                message_id = await _send(db, alert, conversation_id)
            alert.status = "delivered"
            alert.message_id = message_id
            alert.delivered_at = _now()
            alert.last_error = None
            await db.commit()
            return OperatorAlertResult(True, "delivered", alert_id)
        except Exception as exc:
            code = _failure_code(exc)
            logger.warning("operator alert delivery failed alert_id=%s code=%s", alert_id, code)
            await db.rollback()
        # 실패 기록은 새 거래로 — 메시지(SAVEPOINT)와 앞의 변경은 위 롤백으로 버려졌다.
        try:
            alert = (await db.execute(
                select(OperatorAlert).where(OperatorAlert.id == alert_id).with_for_update()
            )).scalar_one_or_none()
            if alert is not None and alert.status != "delivered":
                alert.attempt_count += 1
                alert.next_attempt_at = _now() + _backoff(alert.attempt_count)
                alert.last_error = code
                await db.commit()
        except Exception:
            logger.exception("operator alert failure bookkeeping failed alert_id=%s", alert_id)
            await db.rollback()
        return OperatorAlertResult(False, "send_failed", alert_id)


def _default_session_factory() -> async_sessionmaker:
    from app.core.database import async_session_factory

    return async_session_factory


async def notify_operator(
    *,
    kind: str,
    dedupe_key: str,
    target_org_id: uuid.UUID | None = None,
    target: dict[str, Any] | None = None,
    facts: dict[str, Any] | None = None,
    session_factory: async_sessionmaker | None = None,
) -> OperatorAlertResult:
    """운영 알림 한 건(같은 `dedupe_key`면 한 번만). 예외를 던지지 않는다 — 결과만 돌려준다.

    `kind` · `dedupe_key`가 형식 밖이면 부르는 쪽 코드 결함이라 ValueError(조용히 삼키면 결함을 못 본다)."""
    if not _KIND_RE.match(kind):
        raise ValueError(f"operator alert kind out of format: {kind!r}")
    if not _DEDUPE_KEY_RE.match(dedupe_key):
        raise ValueError(f"operator alert dedupe_key out of format: {dedupe_key!r}")
    safe_target, dropped_target = sanitize_alert_fields(target)
    safe_facts, dropped_facts = sanitize_alert_fields(facts)
    if dropped_target or dropped_facts:
        logger.warning(
            "operator alert fields dropped kind=%s target=%s facts=%s", kind, sorted(dropped_target), sorted(dropped_facts),
        )
    Session = session_factory or _default_session_factory()
    try:
        async with Session() as db:
            await db.execute(
                pg_insert(OperatorAlert)
                .values(
                    id=uuid.uuid4(), dedupe_key=dedupe_key, kind=kind, target_org_id=target_org_id,
                    target=safe_target, facts=safe_facts, status="pending", attempt_count=0, next_attempt_at=_now(),
                )
                .on_conflict_do_nothing(index_elements=["dedupe_key"])
            )
            alert_id = (await db.execute(
                select(OperatorAlert.id).where(OperatorAlert.dedupe_key == dedupe_key)
            )).scalar_one()
            await db.commit()
    except Exception:
        logger.exception("operator alert could not be recorded kind=%s dedupe_key=%s", kind, dedupe_key)
        return OperatorAlertResult(False, "error", None)
    # 같은 사건의 동시 호출은 행 잠금에서 줄을 서고, 뒤 호출은 delivered를 보고 새 메시지 없이 돌아간다.
    return await _deliver(Session, alert_id, skip_locked=False)


async def process_due_operator_alerts(
    *,
    max_items: int = RETRY_TICK_MAX_ITEMS,
    time_budget_seconds: float = RETRY_TICK_TIME_BUDGET_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    session_factory: async_sessionmaker | None = None,
) -> dict[str, Any]:
    """재시도 틱: pending 중 때가 된 것을 오래된 차례로, `max_items`건 · `time_budget_seconds`초 몫 안에서만."""
    counts: dict[str, Any] = {"attempted": 0, "delivered": 0, "failed": 0, "stopped_by_budget": False}
    if _configured_conversation_id() is None:
        counts["skipped"] = "not_configured"
        return counts
    Session = session_factory or _default_session_factory()
    deadline = clock() + time_budget_seconds
    async with Session() as db:
        due_ids = list((await db.execute(
            select(OperatorAlert.id)
            .where(OperatorAlert.status == "pending", OperatorAlert.next_attempt_at <= _now())
            .order_by(OperatorAlert.next_attempt_at.asc())
            .limit(max_items)
        )).scalars())
    for alert_id in due_ids:
        if clock() >= deadline:
            counts["stopped_by_budget"] = True
            break
        result = await _deliver(Session, alert_id, skip_locked=True)
        if result.reason == "busy":
            continue
        counts["attempted"] += 1
        if result.delivered:
            counts["delivered"] += 1
        else:
            counts["failed"] += 1
    return counts
