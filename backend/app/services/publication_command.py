"""story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 발행 명령 원장 서비스.

블루프린트 v3 §3 「발행 명령」·「예약 스케줄러」·「서버 발행 워커」 그대로: 휴먼의
발행/예약 요청이 `publication_commands` 행을 만들고(PO 確定 (B) — 승인 자체는
트리거가 아니다, "승인 없는 명령이 없다"일 뿐), cron 워커가 예약분을 집어 기존
`publish_channel_post_draft()`를 그대로 호출한다(3중 재검증 재구현 금지 — 그
함수가 이미 함).

재사용 패턴 3종(신규 발명 금지):
- SKIP LOCKED 배치 클레임 — `workflow_sla_processor.py::process_sla`와 동형.
- 동시 upsert 경합 방지(SAVEPOINT+IntegrityError constraint명 확인+재조회) —
  story #3395(PR#3757, `channel_posts.py::publish_channel_post_draft`)와 동형
  관용구. 그쪽은 이긴 쪽의 "완료"를 폴링하지만, 여기는 command 자체가 감사
  원장일 뿐이라 진 쪽은 재조회한 기존 행을 그대로 반환하면 된다(완료 대기 불요).
- dead_letter 어휘 — `workflow_line_metrics.py`의 `delivery_status`와 같은 문자열.

`failure_kind`는 유나 design §11-5 정본 3값(`connection`/`needs_check`/
`transient`) — 매핑을 모르는 error_code는 `needs_check`로 fail-closed(임의로
transient=재시도 가능이라 단정하지 않는다)."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.publication_command import PublicationCommand

logger = logging.getLogger(__name__)

# story #3414 — cron 1회 tick이 집는 상한(workflow_sla_processor.py::_SLA_BATCH_SIZE와
# 동형 사상 — 상한 없는 SKIP LOCKED 배치는 그 자체가 위험, story #2461 finding #5).
BATCH_SIZE = 50
MAX_RETRIES = 5
_BACKOFF_BASE_SECONDS = 60  # 1분→2분→4분→8분→16분(마지막 실패면 dead_letter).

# story #3414 PO 정정3 — 유나 design §11-5 정본. 매핑 안 되는 error_code는 반드시
# 'needs_check'로 떨어진다(아래 _UNMAPPED_FAILURE_KIND) — "재시도해도 되는지 모른다"를
# "재시도해도 된다(transient)"로 지어내지 않는다.
FAILURE_KIND_CONNECTION = "connection"
FAILURE_KIND_NEEDS_CHECK = "needs_check"
FAILURE_KIND_TRANSIENT = "transient"

# story #3414 — 어떤 서버 error code가 어느 failure_kind인지의 유일한 매핑 표. 새 코드가
# 추가되면 여기 등재하지 않는 한 자동으로 needs_check(fail-closed)로 떨어진다 — "일단
# transient로"류 추측 금지(story #3405/#3406 "미지 code는 추측 안 함" 원칙과 동일 사상).
_CONNECTION_BLOCKED_CODES = frozenset({"CHANNEL_TOKEN_EXPIRED", "CHANNEL_CONNECTION_NOT_ACTIVE"})
_NEEDS_CHECK_CODES = frozenset({"CHANNEL_PUBLISH_IN_PROGRESS"})
_TRANSIENT_CODES = frozenset({"CHANNEL_PUBLISH_PROVIDER_ERROR", "CHANNEL_RATE_LIMITED"})


def classify_failure_kind(error_code: str | None) -> str:
    """story #3414 — error_code 하나를 유나 design §11-5의 3값 중 하나로 분류한다.
    매핑표 밖의(또는 None) error_code는 전부 needs_check(재시도 가능 여부를 서버가
    모른다는 뜻 — transient로 지어내면 화면이 안전하지 않은 자동 재시도를 약속하게
    된다)."""
    if error_code in _CONNECTION_BLOCKED_CODES:
        return FAILURE_KIND_CONNECTION
    if error_code in _TRANSIENT_CODES:
        return FAILURE_KIND_TRANSIENT
    if error_code in _NEEDS_CHECK_CODES:
        return FAILURE_KIND_NEEDS_CHECK
    return FAILURE_KIND_NEEDS_CHECK


async def create_or_get_publication_command(
    db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID, destination: uuid.UUID,
    approved_version: uuid.UUID, requested_by_member_id: uuid.UUID,
    scheduled_at: datetime | None, operation: str = "publish",
) -> tuple[PublicationCommand, bool]:
    """멱등 upsert(블루프린트 §3 키: org_id+destination+approved_version+operation) —
    기존 행이 있으면 그대로 반환(재생성 0, Threads 이중 POST 방지의 근원 축 하나).
    반환값 둘째 원소는 "새로 만들었는지"(호출부 분기·테스트 편의).

    story #3395(PR#3757)와 동형 동시성 방어 — 진짜 동시 요청 2건이 둘 다 아래 select에서
    None을 보고 각자 INSERT하면 UNIQUE 위반이 난다. SAVEPOINT로 감싸 위반 시 이 INSERT만
    롤백하고(바깥 트랜잭션은 오염 안 됨), constraint 이름을 확인한 뒤(다른 원인까지
    "경합"으로 오판하지 않도록 — approval_delivery.py QA 교훈) 진 쪽은 이긴 쪽이 커밋한
    행을 재조회해 그대로 반환한다(완료 대기 불요 — #3757과 다른 점, 여기 command는
    "완결된 발행 결과"가 아니라 감사 원장이라 어느 상태든 반환해도 무방)."""
    existing = (await db.execute(
        select(PublicationCommand).where(
            PublicationCommand.org_id == org_id,
            PublicationCommand.destination == destination,
            PublicationCommand.approved_version == approved_version,
            PublicationCommand.operation == operation,
        )
    )).scalar_one_or_none()
    if existing is not None:
        return existing, False

    command = PublicationCommand(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=destination,
        approved_version=approved_version, operation=operation, scheduled_at=scheduled_at,
        status="pending", requested_by_member_id=requested_by_member_id,
    )
    try:
        async with db.begin_nested():
            db.add(command)
            await db.flush()
    except IntegrityError as exc:
        _orig = getattr(exc, "orig", None)
        constraint = getattr(_orig, "constraint_name", None) or getattr(
            getattr(_orig, "__cause__", None), "constraint_name", None,
        )
        if constraint != "uq_publication_commands_idempotency":
            raise
        winner = (await db.execute(
            select(PublicationCommand).where(
                PublicationCommand.org_id == org_id,
                PublicationCommand.destination == destination,
                PublicationCommand.approved_version == approved_version,
                PublicationCommand.operation == operation,
            )
        )).scalar_one()
        return winner, False
    return command, True


async def void_pending_commands_for_gate(db: AsyncSession, *, gate_id: uuid.UUID, reason_code: str) -> int:
    """story #3414 추가② — 승인된 게이트가 재편집/재예약으로 pending(reapproval_required)
    으로 되돌아갈 때, 그 게이트에 걸린 **pending 상태의 command만** voided로 전이한다
    (워커 tick을 기다리지 않고 화면이 "이 예약은 더 이상 유효하지 않다"를 즉시 보일 수
    있게). completed·dead_letter·voided 등 이미 종결된 command는 절대 건드리지 않는다
    (그 자체 이력 보존 — "이 게이트의 아무 행이나"가 아니라 "이 게이트의 대기 중인
    행"만, 카디르 QA③ 지적 그대로)."""
    rows = (await db.execute(
        select(PublicationCommand).where(
            PublicationCommand.gate_id == gate_id, PublicationCommand.status == "pending",
        ).with_for_update()
    )).scalars().all()
    for row in rows:
        row.status = "voided"
        row.reason_code = reason_code
    return len(rows)


def compute_next_attempt_at(
    *, attempt_count: int, now: datetime, retry_after_seconds: int | None = None,
) -> datetime:
    """story #3414 — dispatch_router.py::_post_with_retry와 동형 사상의 지수 백오프
    (1분→2분→4분→8분→16분). `Retry-After` 헤더가 있으면 그 값을 그대로 쓴다(기본
    백오프보다 우선 — 카디르 QA④: 헤더를 실제로 읽었는지 증명하려면 기본값과 다른
    값으로 검증해야 한다는 지적 반영, 여기서 헤더값을 무조건 우선)."""
    if retry_after_seconds is not None and retry_after_seconds > 0:
        return now + timedelta(seconds=retry_after_seconds)
    delay = _BACKOFF_BASE_SECONDS * (2 ** attempt_count)
    return now + timedelta(seconds=delay)


async def retry_dead_letter_command(db: AsyncSession, *, org_id: uuid.UUID, command_id: uuid.UUID) -> PublicationCommand | None:
    """story #3414 AC5 — dead_letter 상태인 command를 사람이 다시 큐에 올린다.
    attempt_count는 리셋하지 않는다(이력 보존, PO 권장 그대로) — next_attempt_at을
    now로 되돌려야 cron이 이 행을 다시 집는다(status만 pending으로 바꾸고 next_attempt_at
    이 미래에 멈춰 있으면 WHERE절에서 계속 빠진다 — 카디르 QA⑤ 지적)."""
    command = (await db.execute(
        select(PublicationCommand).where(
            PublicationCommand.id == command_id, PublicationCommand.org_id == org_id,
        ).with_for_update()
    )).scalar_one_or_none()
    if command is None or command.status != "dead_letter":
        return None
    command.status = "pending"
    command.next_attempt_at = None
    command.dead_letter_at = None
    command.last_error = None
    command.failure_kind = None
    return command


async def _process_one_command(db: AsyncSession, command: PublicationCommand, *, now: datetime) -> None:
    """단건 처리 — 알려진 실패는 여기서 전부 잡아 `command`에 결과를 남기고 정상
    반환한다(예외를 밖으로 던지지 않는다). 호출부(`process_due_publication_commands`)가
    그래도 한 번 더 try/except로 감싸는 건 진짜 미분류 버그에 대한 2중 방어(AC4
    격리 — 이 command 하나의 실패가 배치의 나머지를 막으면 안 된다)."""
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_posts import (
        ChannelConnectionNotActiveError,
        ChannelPostDraftNotFoundError,
        ChannelPostReapprovalRequiredError,
        ChannelPostSealMissingError,
        ChannelPublishInProgressError,
        ChannelPublishProviderError,
        ChannelRateLimitedError,
        ChannelTextTooLongError,
        ChannelTokenExpiredError,
        ExternalPublishGateNotApprovedError,
        get_channel_post_draft,
        publish_channel_post_draft,
    )

    command.status = "in_progress"
    await db.flush()

    error_code: str | None = None
    last_error: str | None = None
    retry_after_seconds: int | None = None
    try:
        version_row = (await db.execute(
            select(ChannelPostVersion).where(ChannelPostVersion.id == command.approved_version)
        )).scalar_one_or_none()
        if version_row is None:
            raise ChannelPostDraftNotFoundError(command.approved_version)
        draft = await get_channel_post_draft(db, org_id=command.org_id, draft_id=version_row.draft_id)
        if draft is None:
            raise ChannelPostDraftNotFoundError(version_row.draft_id)

        await publish_channel_post_draft(
            db, org_id=command.org_id, draft_id=draft.id,
            published_by_member_id=command.requested_by_member_id,
        )
        command.status = "completed"
        command.last_error = None
        command.failure_kind = None
        return
    except ChannelPostReapprovalRequiredError as exc:
        # story #3414 추가② 이중 방어 — void_pending_commands_for_gate가 보통 이 상황을
        # 이미 선제 처리하지만(제출 시점 즉시), 놓친 경우를 워커가 마지막으로 잡는다.
        command.status = "voided"
        command.reason_code = "CONTENT_CHANGED"
        command.last_error = str(exc)[:2000]
        return
    except ChannelPostDraftNotFoundError as exc:
        error_code, last_error = "CHANNEL_POST_DRAFT_NOT_FOUND", str(exc)
    except ExternalPublishGateNotApprovedError as exc:
        error_code, last_error = "EXTERNAL_PUBLISH_APPROVAL_REQUIRED", str(exc)
    except ChannelPostSealMissingError as exc:
        error_code, last_error = "SITE_POST_SEAL_MISSING", str(exc)
    except ChannelTextTooLongError as exc:
        error_code, last_error = "CHANNEL_TEXT_TOO_LONG", str(exc)
    except ChannelConnectionNotActiveError as exc:
        error_code, last_error = "CHANNEL_CONNECTION_NOT_ACTIVE", str(exc)
    except ChannelTokenExpiredError as exc:
        error_code, last_error = "CHANNEL_TOKEN_EXPIRED", str(exc)
    except ChannelRateLimitedError as exc:
        error_code, last_error = "CHANNEL_RATE_LIMITED", str(exc)
        retry_after_seconds = max(0, int((exc.reset_at - now).total_seconds()))
    except ChannelPublishProviderError as exc:
        error_code, last_error = "CHANNEL_PUBLISH_PROVIDER_ERROR", str(exc)
    except ChannelPublishInProgressError as exc:
        error_code, last_error = "CHANNEL_PUBLISH_IN_PROGRESS", str(exc)
    except Exception as exc:  # noqa: BLE001 — 미분류 실패도 이 command 하나만 막는다.
        last_error = str(exc)
        logger.exception("publication_command 처리 중 미분류 예외 command_id=%s", command.id)

    await apply_command_failure(
        db, command, error_code=error_code, last_error=last_error, now=now,
        retry_after_seconds=retry_after_seconds,
    )


async def apply_command_failure(
    db: AsyncSession, command: PublicationCommand, *,
    error_code: str | None, last_error: str | None, now: datetime, retry_after_seconds: int | None = None,
) -> None:
    """story #3414 — 실패 한 건을 command(+필요하면 connection) 상태에 반영하는 유일한
    지점. 워커(`_process_one_command`)와 즉시-발행 라우터(`publish_channel_post_draft_
    endpoint`) 둘 다 이 함수를 쓴다 — 실패 분류·백오프·connection 승격 로직을 두 곳에
    각자 짜지 않는다(드리프트 원천 차단, story #3405/#3406과 동일 사상)."""
    command.last_error = last_error[:2000] if last_error else None
    failure_kind = classify_failure_kind(error_code)
    command.failure_kind = failure_kind

    if failure_kind == FAILURE_KIND_CONNECTION:
        # story #3414 PO 정정2 추가② — 재시도 백오프 큐가 아니라 연결 상태를 승격하고
        # 이 command는 "연결 복구 대기"(blocked)로 멈춘다. 연결이 다시 active가 되는
        # 것(owner 재인증 등)은 이 스토리 스코프 밖 — 그 뒤 사람이 수동 재시도(AC5)로
        # 이어간다. apply_refresh_failure()를 직접 부르지 않는 이유 — 그 함수가
        # 내부에서 즉시 commit해 호출부의 커밋 경계와 어긋난다(같은 필드 대입만 여기서
        # 직접 한다, 새 로직 발명 아님).
        from app.models.channel_connection import ChannelConnection

        connection = await db.get(ChannelConnection, command.destination)
        if connection is not None:
            connection.status = "quota_exceeded" if error_code == "CHANNEL_RATE_LIMITED" else "expired"
            connection.last_error = (last_error or "")[:2000]
        command.status = "blocked"
        return

    command.attempt_count += 1
    if command.attempt_count >= MAX_RETRIES:
        command.status = "dead_letter"
        command.dead_letter_at = now
        command.next_attempt_at = None
        return
    command.status = "pending"
    command.next_attempt_at = compute_next_attempt_at(
        attempt_count=command.attempt_count, now=now, retry_after_seconds=retry_after_seconds,
    )


async def process_due_publication_commands(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """story #3414 AC3 — cron 워커의 유일한 진입점. `scheduled_at`(예약 시각, null=즉시라
    이미 동기 경로가 처리했어야 함 — 여기 남아 있다면 그 동기 경로가 중간에 죽은
    것이라 자가치유 대상)이 도래했고, 재시도 대기 중(`next_attempt_at`)이면 그것도
    도래한 `status='pending'` command를 SKIP LOCKED 배치로 클레임한다
    (`workflow_sla_processor.py::process_sla`와 동형 — 상한 있는 배치, cron 겹침 시
    중복 처리 방지).

    각 command는 개별 트랜잭션(커밋 경계)으로 처리 — 한 건의 실패(또는 진짜 미분류
    버그)가 배치의 나머지 org·command를 막지 않는다(AC4 격리)."""
    now = now or datetime.now(timezone.utc)
    rows = (await db.execute(
        select(PublicationCommand).where(
            PublicationCommand.status == "pending",
            (PublicationCommand.scheduled_at.is_(None)) | (PublicationCommand.scheduled_at <= now),
            (PublicationCommand.next_attempt_at.is_(None)) | (PublicationCommand.next_attempt_at <= now),
        ).order_by(PublicationCommand.created_at.asc())
        .limit(BATCH_SIZE)
        .with_for_update(skip_locked=True)
    )).scalars().all()

    counts = {
        "completed": 0, "pending_retry": 0, "dead_letter": 0, "blocked": 0, "voided": 0, "error": 0,
    }
    for command in rows:
        try:
            await _process_one_command(db, command, now=now)
            await db.commit()
            key = command.status if command.status in ("completed", "dead_letter", "blocked", "voided") else "pending_retry"
            counts[key] += 1
        except Exception:  # noqa: BLE001 — 2중 방어(AC4): 진짜 미분류 예외도 이 건만 격리.
            await db.rollback()
            counts["error"] += 1
            logger.exception("publication command batch item 처리 실패 command_id=%s", command.id)
    return counts
