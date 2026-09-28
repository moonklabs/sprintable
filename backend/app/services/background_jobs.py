"""story #4336 PR2(PO 04:32Z) — 공용 작업 줄(`background_jobs`)의 넣기 · 처리 · 보기.

PO 규칙 (b) «응답 뒤 일 0 · 실행자는 cron 워커뿐»: 요청은 `enqueue_background_job`으로 행만 넣고 답한다. 처리는 `publication-commands` 틱
(1분 · 새 스케줄러 잡 0)이 발행 명령을 돈 뒤 **같은 틱 예산의 남은 몫**으로 `process_due_background_jobs`를 부른다.
틱 예산 = `worker_tick_budget_seconds()`(= min(스케줄러 시한, 요청 시한) − 60s · 4716과 같은 식). 종류마다 최악 소요(`worst_seconds`)가
남은 예산보다 크면 그 틱엔 시작하지 않고 다음 틱으로 넘긴다(발행 명령과 같은 규칙 · 도중에 끊기지 않게).

실패 처리:
- 처리기가 아는 거부(검증 실패 등) → 곧바로 `failed` + `error` = 요청이 그대로 받았을 본문(`{status_code, detail}`) — 화면이 같은 문장.
- 시한 초과 · 모르는 예외 → 일시 실패로 보고 `pending` + `next_attempt_at`(백오프) · `MAX_ATTEMPTS`번째면 `failed`(코드 `BACKGROUND_JOB_FAILED`).
- 워커가 죽어 `in_progress`로 남은 행은 `LEASE_SECONDS` 뒤 다시 집는다.

재실행 멱등(story #4336 PR2 ② · 까디르 codex · PO 08:19Z): 처리기(`run`)는 **커밋하지 않는다**(flush만). 처리기가 쓴 결과와 작업 완료 표시는
워커의 `_finish`가 **한 커밋**으로 싣는다 — 둘 사이에서 인스턴스가 죽으면 둘 다 없고, 리스 회수 뒤 재실행이 처음부터 한 번만 쓴다(예전: 영상
처리기가 새 버전 · 영상 행을 먼저 커밋 → 죽으면 재실행이 같은 object_path로 하나 더). 처리기가 커밋하면 `before_commit` 가드가 막는다
(`HandlerCommittedError` — 새 처리기가 규칙을 어기면 조용히 두 번 쓰지 않고 시끄럽게 실패).
"""
from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, event, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.background_job import BackgroundJob

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
LEASE_SECONDS = 15 * 60
_BACKOFF_BASE_SECONDS = 60
FAILED_CODE = "BACKGROUND_JOB_FAILED"

class HandlerCommittedError(RuntimeError):
    """처리기(`run`)가 커밋하려 했다 — 결과와 작업 완료는 워커가 한 커밋으로 싣는다(모듈 docstring «재실행 멱등»)."""


# 틱 안 경과 시간 — 테스트가 바꿔 끼운다(모듈 속성으로 읽는다).
_monotonic = time.monotonic


@dataclass(frozen=True)
class JobHandler:
    """한 종류의 일. `run`은 결과 참조(dict)를 돌려주거나 예외를 던진다. `error_body`는 아는 거부를 요청 본문으로(모르면 None)."""

    worst_seconds: float
    run: Callable[[AsyncSession, BackgroundJob], Awaitable[dict[str, Any]]]
    error_body: Callable[[Exception, BackgroundJob], dict[str, Any] | None]
    # 끝난 일의 결과를 화면용으로 펼친다(서명 URL처럼 만료되는 값은 여기서 새로 만든다 · 보는 사람 기준 값은 auth로). None이면 result 그대로.
    render_result: Callable[[AsyncSession, BackgroundJob, Any], Awaitable[dict[str, Any] | None]] | None = None


# ─── channel_video_confirm ────────────────────────────────────────────────────

async def _run_channel_video_confirm(db: AsyncSession, job: BackgroundJob) -> dict[str, Any]:
    from app.services.channel_post_videos import finish_channel_post_video_confirm

    p = job.payload
    version, video_row = await finish_channel_post_video_confirm(
        db, org_id=job.org_id, draft_id=uuid.UUID(p["draft_id"]), object_path=p["object_path"],
        member_id=uuid.UUID(p["member_id"]), member_kind=p["member_kind"], commit=False,
    )
    return {"video_id": str(video_row.id), "version_id": str(version.id)}


def _channel_video_confirm_error_body(exc: Exception, job: BackgroundJob) -> dict[str, Any] | None:
    from app.routers.channel_posts import _video_confirm_http_error
    from app.services.storage.deadline import StorageCallTimeoutError

    if isinstance(exc, StorageCallTimeoutError):
        return None  # 시한 초과는 거부가 아니라 일시 실패 — 다시 시도
    http_error = _video_confirm_http_error(exc, job.payload.get("locale") or "ko")
    if http_error is None:
        return None
    return {"status_code": http_error.status_code, "detail": http_error.detail}


async def _render_channel_video_confirm(db: AsyncSession, job: BackgroundJob, auth: Any = None) -> dict[str, Any] | None:
    from app.models.channel_post_video import ChannelPostVideo
    from app.models.channel_post_version import ChannelPostVersion
    from app.routers.channel_posts import _video_response

    if not job.result:
        return None
    video_row = (await db.execute(
        select(ChannelPostVideo).where(ChannelPostVideo.id == uuid.UUID(job.result["video_id"]), ChannelPostVideo.org_id == job.org_id)
    )).scalar_one_or_none()
    version = (await db.execute(
        select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(job.result["version_id"]))
    )).scalar_one_or_none()
    if video_row is None or version is None:
        return None
    return {"video": _video_response(version, video_row).model_dump(mode="json")}


def _channel_video_worst_seconds() -> float:
    from app.services.channel_post_videos import VIDEO_CONFIRM_WORST_SECONDS

    return VIDEO_CONFIRM_WORST_SECONDS


# ─── attachment_convert (PR2 ②) ───────────────────────────────────────────────

async def _run_attachment_convert(db: AsyncSession, job: BackgroundJob) -> dict[str, Any]:
    from app.models.asset import Asset
    from app.services import office_conversion

    asset = (await db.execute(
        select(Asset).where(Asset.id == uuid.UUID(job.payload["asset_id"]), Asset.org_id == job.org_id, Asset.deleted_at.is_(None))
    )).scalar_one_or_none()
    if asset is None:
        raise _Gone("Asset not found")
    converted = await office_conversion.get_or_convert_pdf(db, source_asset=asset, commit=False)
    return {"asset_id": str(converted.id)}


def _attachment_convert_error_body(exc: Exception, job: BackgroundJob) -> dict[str, Any] | None:
    from app.routers.attachments import convert_http_error

    if isinstance(exc, _Gone):
        return {"status_code": 404, "detail": str(exc)}
    http_error = convert_http_error(exc)
    return None if http_error is None else {"status_code": http_error.status_code, "detail": http_error.detail}


async def _render_attachment_convert(db: AsyncSession, job: BackgroundJob, auth: Any = None) -> dict[str, Any] | None:
    from app.models.asset import Asset
    from app.routers.attachments import converted_asset_view

    converted = (await db.execute(
        select(Asset).where(Asset.id == uuid.UUID(job.result["asset_id"]), Asset.org_id == job.org_id)
    )).scalar_one_or_none() if job.result else None
    return None if converted is None else converted_asset_view(converted)


# ─── loop_context_pack (PR2 ②) ────────────────────────────────────────────────

async def _run_loop_context_pack(db: AsyncSession, job: BackgroundJob) -> dict[str, Any]:
    from app.repositories.loop import LoopRunRepository
    from app.services.context_pack_items import build_loop_context_pack

    loop = await LoopRunRepository(db, job.org_id).get(uuid.UUID(job.payload["loop_id"]))
    if loop is None:
        raise _Gone("Loop not found")
    pack = await build_loop_context_pack(db, job.org_id, loop, generate_on_miss=True)
    return {"pack": pack.model_dump(mode="json")}


def _loop_context_pack_error_body(exc: Exception, job: BackgroundJob) -> dict[str, Any] | None:
    if isinstance(exc, _Gone):
        return {"status_code": 404, "detail": str(exc)}
    return None  # LLM · 임베드 실패는 build가 이미 부분 결과로 흡수 — 그 밖은 일시 실패로 재시도


# ─── retro_synthesis (PR2 ②) ──────────────────────────────────────────────────

async def _run_retro_synthesis(db: AsyncSession, job: BackgroundJob) -> dict[str, Any]:
    from app.services.retro_synthesis import run_retro_generation

    session_id = uuid.UUID(job.payload["session_id"])
    await run_retro_generation(db, org_id=job.org_id, session_id=session_id, mode=job.payload["mode"])
    return {"session_id": str(session_id)}


def _retro_synthesis_error_body(exc: Exception, job: BackgroundJob) -> dict[str, Any] | None:
    from app.services.retro_synthesis import RetroGenerationError

    if isinstance(exc, RetroGenerationError):
        return {"status_code": exc.status_code, "detail": exc.detail}
    return None


async def _render_retro_synthesis(db: AsyncSession, job: BackgroundJob, auth: Any = None) -> dict[str, Any] | None:
    from app.repositories.retro import RetroSessionRepository
    from app.routers.retros import _build_session_response

    if not job.result or auth is None:
        return None
    session = await RetroSessionRepository(db, job.org_id).get(uuid.UUID(job.result["session_id"]))
    if session is None:
        return None
    return {"session": (await _build_session_response(db, session, auth)).model_dump(mode="json")}


class _Gone(Exception):
    """작업을 넣은 뒤 대상이 사라짐(삭제 등) — 요청이 받았을 404와 같게 끝낸다(재시도 없음)."""


HANDLERS: dict[str, JobHandler] = {
    "channel_video_confirm": JobHandler(
        worst_seconds=0.0,  # 아래에서 모듈 상수로 채운다(순환 import 피함)
        run=_run_channel_video_confirm,
        error_body=_channel_video_confirm_error_body,
        render_result=_render_channel_video_confirm,
    ),
    "attachment_convert": JobHandler(
        worst_seconds=0.0, run=_run_attachment_convert, error_body=_attachment_convert_error_body,
        render_result=_render_attachment_convert,
    ),
    # 임베드 10 + LLM 25 × 2(순차) + DB 여유.
    "loop_context_pack": JobHandler(
        worst_seconds=75.0, run=_run_loop_context_pack, error_body=_loop_context_pack_error_body,
    ),
    # LLM 25 × 2(종합 → 추천) + DB 여유.
    "retro_synthesis": JobHandler(
        worst_seconds=70.0, run=_run_retro_synthesis, error_body=_retro_synthesis_error_body,
        render_result=_render_retro_synthesis,
    ),
}


def _worst_seconds(kind: str) -> float:
    if kind == "channel_video_confirm":
        return _channel_video_worst_seconds()
    if kind == "attachment_convert":
        from app.services.office_conversion import CONVERT_WORST_SECONDS

        return CONVERT_WORST_SECONDS
    return HANDLERS[kind].worst_seconds


# ─── 넣기 · 보기 ──────────────────────────────────────────────────────────────

async def enqueue_background_job(
    db: AsyncSession, *, org_id: uuid.UUID, kind: str, requested_by_member_id: uuid.UUID, payload: dict[str, Any],
    dedup_key: str | None = None,
) -> BackgroundJob:
    """행만 넣는다(flush) — 커밋은 호출부(요청 트랜잭션과 같이).

    story #4336 PR2 ②(PO 10:39Z) — `dedup_key`를 주면 같은 사람 · 같은 종류 · 같은 대상의 **열린**(대기 · 실행 중) 작업이 있을 때 새로 만들지
    않고 그 작업을 돌려준다(MCP가 30초 뒤 «다시 부르라»고 안내 → 다시 불러도 작업 하나 · LLM 한 번). DB 부분 유일 인덱스
    `uq_background_jobs_open_dedup`가 판정 — 동시 두 요청도 하나(뒤 요청은 앞 트랜잭션 커밋까지 기다렸다가 그 작업을 받는다)."""
    if kind not in HANDLERS:
        raise ValueError(f"unknown background job kind: {kind}")
    if dedup_key is None:
        job = BackgroundJob(
            id=uuid.uuid4(), org_id=org_id, kind=kind, payload=payload, status="pending",
            requested_by_member_id=requested_by_member_id,
        )
        db.add(job)
        await db.flush()
        return job

    from sqlalchemy import text as sa_text
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.background_job import OPEN_DEDUP_WHERE

    for _ in range(2):  # 기존 작업이 방금 끝나 조회가 비면 한 번 더 넣는다
        inserted = (await db.execute(
            pg_insert(BackgroundJob)
            .values(
                id=uuid.uuid4(), org_id=org_id, kind=kind, payload=payload, status="pending", attempt_count=0,
                requested_by_member_id=requested_by_member_id, dedup_key=dedup_key,
            )
            .on_conflict_do_nothing(
                index_elements=[BackgroundJob.org_id, BackgroundJob.kind, BackgroundJob.requested_by_member_id, BackgroundJob.dedup_key],
                index_where=sa_text(OPEN_DEDUP_WHERE),
            )
            .returning(BackgroundJob.id)
        )).scalar_one_or_none()
        job_id = inserted or (await db.execute(
            select(BackgroundJob.id).where(
                BackgroundJob.org_id == org_id, BackgroundJob.kind == kind,
                BackgroundJob.requested_by_member_id == requested_by_member_id, BackgroundJob.dedup_key == dedup_key,
                BackgroundJob.status.in_(("pending", "in_progress")),
            )
        )).scalar_one_or_none()
        if job_id is not None:
            return (await db.execute(select(BackgroundJob).where(BackgroundJob.id == job_id))).scalar_one()
    raise RuntimeError("background job dedup: could not insert or find the open job")


def background_job_view(job: BackgroundJob, *, rendered: dict[str, Any] | None = None) -> dict[str, Any]:
    """화면이 읽는 모양. 결과(`result`)는 종류별로 펼친 값(`rendered`)이 있으면 그것을 싣는다."""
    return {
        "id": str(job.id),
        "kind": job.kind,
        "status": job.status,
        "result": rendered if rendered is not None else job.result,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


async def render_background_job(db: AsyncSession, job: BackgroundJob, auth: Any = None) -> dict[str, Any]:
    handler = HANDLERS.get(job.kind)
    rendered = None
    if job.status == "completed" and handler is not None and handler.render_result is not None:
        rendered = await handler.render_result(db, job, auth)
    return background_job_view(job, rendered=rendered)


# ─── 처리(워커) ───────────────────────────────────────────────────────────────

def _due_filter(now: datetime):
    return or_(
        and_(BackgroundJob.status == "pending", or_(BackgroundJob.next_attempt_at.is_(None), BackgroundJob.next_attempt_at <= now)),
        and_(BackgroundJob.status == "in_progress", BackgroundJob.claimed_at < now - timedelta(seconds=LEASE_SECONDS)),
    )


async def _claim_next(session: AsyncSession, *, remaining_seconds: float, skipped: set[uuid.UUID]) -> BackgroundJob | None:
    """다음 due 작업 하나를 잠가 `in_progress`로(커밋) — 남은 예산이 그 종류의 최악 소요보다 작으면 집지 않는다."""
    now = datetime.now(timezone.utc)
    query = (
        select(BackgroundJob).where(_due_filter(now))
        .order_by(BackgroundJob.created_at, BackgroundJob.id)
        .with_for_update(skip_locked=True).limit(1)
    )
    if skipped:
        query = query.where(BackgroundJob.id.notin_(skipped))
    job = (await session.execute(query)).scalar_one_or_none()
    if job is None:
        return None
    job_id, kind = job.id, job.kind  # 롤백하면 행이 만료된다 — 먼저 읽어 둔다
    if kind not in HANDLERS or _worst_seconds(kind) > remaining_seconds:
        skipped.add(job_id)
        await session.rollback()
        # 모르는 종류는 건너뛰고 다음을 본다 · 예산이 모자라면 이 틱은 여기까지(가장 오래된 일이 먼저 — 새치기 0).
        return None if kind in HANDLERS else await _claim_next(session, remaining_seconds=remaining_seconds, skipped=skipped)
    job.status = "in_progress"
    job.claimed_at = now
    job.attempt_count += 1
    await session.commit()
    return job


async def _finish(session: AsyncSession, job_id: uuid.UUID, **values: Any) -> None:
    job = (await session.execute(select(BackgroundJob).where(BackgroundJob.id == job_id))).scalar_one()
    for key, value in values.items():
        setattr(job, key, value)
    await session.commit()


async def process_due_background_jobs(session: AsyncSession, *, deadline_monotonic: float) -> dict[str, int]:
    """틱의 남은 예산 안에서 due 작업을 하나씩 처리한다. `deadline_monotonic` = 틱 시작 + 틱 예산."""
    counts = {"completed": 0, "failed": 0, "retry": 0, "deferred": 0}
    skipped: set[uuid.UUID] = set()
    in_handler = {"on": False}

    def _refuse_commit_in_handler(_session) -> None:
        if in_handler["on"]:
            raise HandlerCommittedError("background job handler must not commit — the worker commits result and completion together")

    event.listen(session.sync_session, "before_commit", _refuse_commit_in_handler)
    try:
        return await _process_loop(session, deadline_monotonic, counts, skipped, in_handler)
    finally:
        event.remove(session.sync_session, "before_commit", _refuse_commit_in_handler)


async def _process_loop(
    session: AsyncSession, deadline_monotonic: float, counts: dict[str, int], skipped: set[uuid.UUID], in_handler: dict[str, bool],
) -> dict[str, int]:
    while True:
        remaining = deadline_monotonic - _monotonic()
        if remaining <= 0:
            break
        job = await _claim_next(session, remaining_seconds=remaining, skipped=skipped)
        if job is None:
            counts["deferred"] = len(skipped)
            break
        job_id, attempt = job.id, job.attempt_count
        handler = HANDLERS[job.kind]
        try:
            in_handler["on"] = True
            try:
                result = await handler.run(session, job)
            finally:
                in_handler["on"] = False
        except Exception as exc:  # noqa: BLE001 — 한 작업의 실패가 틱 전체를 죽이지 않게
            await session.rollback()
            job = (await session.execute(select(BackgroundJob).where(BackgroundJob.id == job_id))).scalar_one()
            body = handler.error_body(exc, job)
            now = datetime.now(timezone.utc)
            if body is not None:
                await _finish(session, job_id, status="failed", error=body, finished_at=now)
                counts["failed"] += 1
            elif attempt >= MAX_ATTEMPTS:
                logger.exception("background job %s(%s) failed after %s attempts", job_id, job.kind, attempt)
                await _finish(
                    session, job_id, status="failed", finished_at=now,
                    error={"status_code": 503, "detail": {"code": FAILED_CODE, "message": type(exc).__name__}},
                )
                counts["failed"] += 1
            else:
                logger.warning("background job %s(%s) attempt %s failed — retry later", job_id, job.kind, attempt, exc_info=True)
                await _finish(
                    session, job_id, status="pending", claimed_at=None,
                    next_attempt_at=now + timedelta(seconds=_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))),
                )
                counts["retry"] += 1
            continue
        await _finish(session, job_id, status="completed", result=result, error=None, finished_at=datetime.now(timezone.utc))
        counts["completed"] += 1
    return counts
