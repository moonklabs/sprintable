"""story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 수집 잡+목록+수동
재수집. 블루프린트 v3 §2 「댓글·반응 대응」 MVP 조각①. `insight_snapshots.py`(story
#3497)의 due_at 스케줄링+SKIP LOCKED 워커 뼈대를 미러(같은 테이블 공유 안 함 — 그라운딩
③, 댓글 수집은 정규화값을 안 담고 시도 성공/실패만 남긴다).

지속 폴링/커서는 이 조각 스코프 밖(PO 決定) — 매 수집 시도는 provider의 "현재 댓글
전체"(첫 페이지)를 받아 upsert하고, 이전엔 있었는데 이번엔 없는 댓글을 소프트 삭제로
리컨실한다(diff 방식 — provider가 실제로 지원하는지와 무관하게 항상 성립하는 일반
로직, sandbox·threads 둘 다 같은 코드를 탄다)."""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_post_comment import ChannelPostComment, CommentCollectionSchedule

BATCH_SIZE = 50
_COLLECTION_OFFSETS = (timedelta(hours=1), timedelta(days=1), timedelta(days=7))
_REFRESH_MIN_INTERVAL = timedelta(minutes=5)


class CommentFetchError(Exception):
    """어댑터 fetch_replies 실패 통로. error_code는 `publication_command.py::
    classify_failure_kind`가 아는 문자열 그대로 재사용(새 매핑표 0, insight_snapshots.py
    ::InsightFetchError와 동형)."""

    def __init__(self, *, error_code: str, message: str):
        self.error_code = error_code
        super().__init__(message)


class CommentRefreshRateLimitedError(Exception):
    """수동 재수집이 5분 내 재요청됨(429). `retry_after_seconds`를 실어 호출부가
    Retry-After류 안내를 만들 수 있게."""

    def __init__(self, *, retry_after_seconds: int):
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"{retry_after_seconds}초 뒤 다시 시도하세요")


class CommentCollectionUnsupportedError(Exception):
    """어댑터가 supports_fetch_replies=False(insight_snapshots.py의 "빈 insight_metrics
    =unsupported"와 동형 사상)."""


async def schedule_comment_collection(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, channel: str,
    external_id: str | None, anchor_at: datetime,
) -> None:
    """발행 성공 직후(같은 트랜잭션, commit은 호출자 몫) +1h·+1d·+7d 세 행을 연다 —
    `insight_snapshots.py::schedule_insight_snapshots`와 동형(멱등 UNIQUE(publication_id,
    due_at), 같은 발행 재처리에도 행 중복 0)."""
    for offset in _COLLECTION_OFFSETS:
        stmt = pg_insert(CommentCollectionSchedule).values(
            id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
            external_id=external_id, due_at=anchor_at + offset, status="pending",
        ).on_conflict_do_nothing(constraint="uq_comment_collection_schedule_publication_due_at")
        await db.execute(stmt)


def _text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def _fetch_replies_raw(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, channel: str, external_id: str | None,
) -> list[dict]:
    """channel별 dispatch(insight_snapshots.py::_fetch_for_snapshot과 동형) — 어댑터가
    supports_fetch_replies를 선언 안 했으면 여기 도달 前에 호출자가 이미 unsupported로
    끝낸다(중복 판정 안 둠)."""
    if channel == "sandbox":
        from app.services import sandbox_publish

        if external_id is None:
            raise CommentFetchError(error_code="COMMENT_EXTERNAL_ID_MISSING", message="external_id가 없습니다")
        import httpx
        async with httpx.AsyncClient() as client:
            return await sandbox_publish.fetch_replies(client, access_token="sandbox", media_id=external_id)

    if channel == "threads":
        from app.models.channel_connection import ChannelConnection
        from app.models.channel_publication import ChannelPublication
        from app.services.channel_connection import decrypt_for_use
        from app.services.threads_publish import fetch_replies as threads_fetch_replies

        pub = (await db.execute(
            select(ChannelPublication).where(ChannelPublication.id == publication_id)
        )).scalar_one_or_none()
        if pub is None or pub.external_id is None:
            raise CommentFetchError(
                error_code="CHANNEL_CONNECTION_NOT_ACTIVE",
                message=f"channel_publication을 찾을 수 없습니다: {publication_id}",
            )
        connection = await db.get(ChannelConnection, pub.connection_id)
        if connection is None or connection.status != "active":
            raise CommentFetchError(
                error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message=f"연결이 활성 상태가 아닙니다: {pub.connection_id}",
            )
        access_token = decrypt_for_use(connection)
        if access_token is None:
            raise CommentFetchError(error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message="연결에 자격이 없습니다")

        import httpx
        try:
            async with httpx.AsyncClient() as client:
                return await threads_fetch_replies(client, access_token=access_token, media_id=pub.external_id)
        except Exception as exc:  # noqa: BLE001 — ThreadsPublishError는 상태코드로 분류
            from app.services.threads_publish import ThreadsPublishError
            if isinstance(exc, ThreadsPublishError):
                if exc.status_code in (401, 403):
                    raise CommentFetchError(error_code="CHANNEL_TOKEN_EXPIRED", message=str(exc)) from exc
                if exc.status_code == 429:
                    raise CommentFetchError(error_code="CHANNEL_RATE_LIMITED", message=str(exc)) from exc
                raise CommentFetchError(error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", message=str(exc)) from exc
            raise

    raise CommentFetchError(
        error_code="COMMENT_CHANNEL_NOT_IMPLEMENTED", message=f"fetch_replies dispatch가 없습니다: {channel}",
    )


async def collect_comments_for_publication(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, channel: str, external_id: str | None,
) -> dict[str, Any]:
    """실제 upsert+리컨실(soft-delete) 본체 — 워커(스케줄 행 처리)와 수동 재수집
    (`refresh_comments_now`) 둘 다 이 함수를 그대로 쓴다(두 번째 구현 경로 0)."""
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    adapter = CHANNEL_ADAPTERS.get(channel)
    if adapter is None or not adapter.supports_fetch_replies:
        raise CommentCollectionUnsupportedError()

    raw_comments = await _fetch_replies_raw(
        db, org_id=org_id, publication_id=publication_id, channel=channel, external_id=external_id,
    )

    now = datetime.now(timezone.utc)
    fetched_external_ids: set[str] = set()
    for raw in raw_comments:
        external_comment_id = str(raw.get("id"))
        if not external_comment_id or external_comment_id == "None":
            continue
        fetched_external_ids.add(external_comment_id)
        text = str(raw.get("text") or "")
        # sandbox_publish·threads_publish 둘 다 raw.timestamp를 ISO 문자열로 준다
        # (provider 원시 응답 그대로) — asyncpg는 문자열 바인딩을 거부하니(TIMESTAMPTZ
        # 컬럼) 여기서 한 번 파싱한다. 파싱 실패(예상 밖 포맷)는 null로 떨어뜨리고
        # raw 원문엔 그대로 남아 원인 추적 가능.
        raw_timestamp = raw.get("timestamp")
        external_created_at = None
        if raw_timestamp:
            try:
                external_created_at = datetime.fromisoformat(str(raw_timestamp))
            except ValueError:
                external_created_at = None
        stmt = pg_insert(ChannelPostComment).values(
            id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
            external_comment_id=external_comment_id, author_display_name=raw.get("username"),
            text=text, text_sha256=_text_sha256(text),
            external_created_at=external_created_at, captured_at=now, raw=raw, deleted_at=None,
        )
        stmt = stmt.on_conflict_do_update(
            constraint="uq_channel_post_comments_publication_external",
            set_={
                "text": stmt.excluded.text, "text_sha256": stmt.excluded.text_sha256,
                "author_display_name": stmt.excluded.author_display_name,
                "raw": stmt.excluded.raw, "captured_at": now,
                # story #3516 — 재수집으로 다시 보이면 "부활"(un-delete). 삭제 판정은
                # 이 리컨실 루프의 유일한 근거(provider가 안 준다=없다)라, 다시 주면
                # 다시 살아있는 게 맞다(지어내지 않는다).
                "deleted_at": None, "updated_at": now,
            },
        )
        await db.execute(stmt)

    # 리컨실 — 이전엔 살아있다고 기록됐는데 이번 fetch엔 없는 댓글은 소프트 삭제.
    existing_rows = (await db.execute(
        select(ChannelPostComment).where(
            ChannelPostComment.publication_id == publication_id, ChannelPostComment.deleted_at.is_(None),
        )
    )).scalars().all()
    deleted_count = 0
    for row in existing_rows:
        if row.external_comment_id not in fetched_external_ids:
            row.deleted_at = now
            deleted_count += 1

    return {"fetched": len(fetched_external_ids), "deleted": deleted_count, "captured_at": now}


async def process_due_comment_collections(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """`insight_snapshots.py::process_due_insight_snapshots`와 동형 SKIP LOCKED 2단계
    커밋(클레임 commit → 개별 처리 commit/rollback 격리)."""
    from app.services.publication_command import classify_failure_kind, FAILURE_KIND_CONNECTION, FAILURE_KIND_TRANSIENT

    now = now or datetime.now(timezone.utc)
    rows = (await db.execute(
        select(CommentCollectionSchedule).where(
            CommentCollectionSchedule.status == "pending", CommentCollectionSchedule.due_at <= now,
        ).order_by(CommentCollectionSchedule.due_at.asc())
        .limit(BATCH_SIZE)
        .with_for_update(skip_locked=True)
    )).scalars().all()

    for row in rows:
        row.status = "in_progress"
    await db.commit()

    counts = {"captured": 0, "unsupported": 0, "failed": 0, "pending_retry": 0}
    for row in rows:
        try:
            try:
                result = await collect_comments_for_publication(
                    db, org_id=row.org_id, publication_id=row.publication_id, channel=row.channel,
                    external_id=row.external_id,
                )
            except CommentCollectionUnsupportedError:
                row.status = "unsupported"
                row.captured_at = now
                await db.commit()
                counts["unsupported"] += 1
                continue
            except CommentFetchError as exc:
                failure_kind = classify_failure_kind(exc.error_code)
                if failure_kind == FAILURE_KIND_CONNECTION:
                    await _promote_connection_status(db, publication_id=row.publication_id, channel=row.channel)
                    row.status = "failed"
                    row.error_code = exc.error_code
                    await db.commit()
                    counts["failed"] += 1
                elif failure_kind == FAILURE_KIND_TRANSIENT:
                    row.attempt_count += 1
                    row.error_code = exc.error_code
                    if row.attempt_count >= 5:
                        row.status = "failed"
                        await db.commit()
                        counts["failed"] += 1
                    else:
                        row.status = "pending"
                        await db.commit()
                        counts["pending_retry"] += 1
                else:
                    row.status = "failed"
                    row.error_code = exc.error_code
                    await db.commit()
                    counts["failed"] += 1
                continue

            row.status = "captured"
            row.captured_at = result["captured_at"]
            await db.commit()
            counts["captured"] += 1
        except Exception:  # noqa: BLE001 — 이 행 하나만 막는다(전체 배치 안 죽음).
            await db.rollback()
            row.status = "failed"
            row.error_code = "COMMENT_COLLECTION_UNCLASSIFIED_ERROR"
            await db.commit()
            counts["failed"] += 1

    return counts


async def _promote_connection_status(db: AsyncSession, *, publication_id: uuid.UUID, channel: str) -> None:
    """insight_snapshots.py::_promote_connection_status_for_snapshot과 동형 — sandbox는
    connection 자체가 없어 no-op."""
    if channel != "threads":
        return
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == publication_id)
    )).scalar_one_or_none()
    if pub is None:
        return
    connection = await db.get(ChannelConnection, pub.connection_id)
    if connection is not None and connection.status not in ("revoked", "error"):
        connection.status = "expired"


async def refresh_comments_now(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID,
) -> dict[str, Any]:
    """휴먼 수동 재수집(`POST .../comments/refresh`) — publication당 5분에 1회
    (429 CommentRefreshRateLimitedError). 워커 스케줄 테이블에 due_at=now() 행을
    직접 넣고 그 자리에서 바로 처리한다(별도 rate-limit 상태 테이블 0 — "가장 최근
    captured_at"으로 판정)."""
    from app.models.channel_publication import ChannelPublication

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == publication_id, ChannelPublication.org_id == org_id)
    )).scalar_one_or_none()
    if pub is None:
        raise CommentFetchError(error_code="COMMENT_PUBLICATION_NOT_FOUND", message=f"발행 기록을 찾을 수 없습니다: {publication_id}")

    now = datetime.now(timezone.utc)
    last_captured_at = (await db.execute(
        select(CommentCollectionSchedule.captured_at)
        .where(
            CommentCollectionSchedule.org_id == org_id,
            CommentCollectionSchedule.publication_id == publication_id,
            CommentCollectionSchedule.captured_at.is_not(None),
        )
        .order_by(CommentCollectionSchedule.captured_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if last_captured_at is not None and now - last_captured_at < _REFRESH_MIN_INTERVAL:
        retry_after = int((_REFRESH_MIN_INTERVAL - (now - last_captured_at)).total_seconds())
        raise CommentRefreshRateLimitedError(retry_after_seconds=max(retry_after, 1))

    schedule_row = CommentCollectionSchedule(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=pub.channel,
        external_id=pub.external_id, due_at=now, status="in_progress",
    )
    db.add(schedule_row)
    await db.flush()

    try:
        result = await collect_comments_for_publication(
            db, org_id=org_id, publication_id=publication_id, channel=pub.channel, external_id=pub.external_id,
        )
    except CommentCollectionUnsupportedError:
        schedule_row.status = "unsupported"
        schedule_row.captured_at = now
        await db.commit()
        raise
    except CommentFetchError as exc:
        schedule_row.status = "failed"
        schedule_row.error_code = exc.error_code
        await db.commit()
        raise

    schedule_row.status = "captured"
    schedule_row.captured_at = result["captured_at"]
    await db.commit()
    return result


class CommentPublicationNotFoundError(Exception):
    """publication_id가 이 org 소속 channel_publication이 아님(404, 존재 비노출 관례)."""


async def list_comments_for_publication(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, limit: int = 50, offset: int = 0,
) -> dict[str, Any]:
    """목록 API 본체 — "미수집"(아직 한 번도 captured 없음, null)과 "0건"(수집은
    됐는데 댓글이 실제로 0개)을 구분한다(insight_snapshots.py의 null≠0 척추와 동형
    사상, 이 스토리에도 그대로 적용).

    story #3516(IDOR 방어, feedback_idor_two_layers 관례) — publication_id가 이 org
    소속인지 먼저 검증한다(row-keying만으론 부족 — 외부 id가 요청자 소유인지 별도
    확인, refresh_comments_now와 동형)."""
    from app.models.channel_publication import ChannelPublication

    owned = (await db.execute(
        select(ChannelPublication.id).where(
            ChannelPublication.id == publication_id, ChannelPublication.org_id == org_id,
        )
    )).scalar_one_or_none()
    if owned is None:
        raise CommentPublicationNotFoundError(publication_id)

    last_captured_at = (await db.execute(
        select(CommentCollectionSchedule.captured_at)
        .where(
            CommentCollectionSchedule.org_id == org_id,
            CommentCollectionSchedule.publication_id == publication_id,
            CommentCollectionSchedule.status == "captured",
        )
        .order_by(CommentCollectionSchedule.captured_at.desc())
        .limit(1)
    )).scalar_one_or_none()

    rows = (await db.execute(
        select(ChannelPostComment)
        .where(ChannelPostComment.org_id == org_id, ChannelPostComment.publication_id == publication_id)
        .order_by(ChannelPostComment.external_created_at.desc().nulls_last(), ChannelPostComment.id.desc())
        .limit(limit).offset(offset)
    )).scalars().all()

    return {"last_collected_at": last_captured_at, "comments": rows}


async def count_comments_by_publication_ids(
    db: AsyncSession, *, publication_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    """3502 성과 보드(insights_board.py)의 comments_count 배치 조회 — 삭제 안 된 댓글만
    센다(deleted_at IS NULL, "지금 보이는 댓글 수"). publication_id 없으면 0(dict에서
    빠짐, 호출부가 `.get(pid, 0)`)."""
    if not publication_ids:
        return {}
    from sqlalchemy import func

    rows = (await db.execute(
        select(ChannelPostComment.publication_id, func.count())
        .where(
            ChannelPostComment.publication_id.in_(publication_ids), ChannelPostComment.deleted_at.is_(None),
        )
        .group_by(ChannelPostComment.publication_id)
    )).all()
    return {pid: count for pid, count in rows}
