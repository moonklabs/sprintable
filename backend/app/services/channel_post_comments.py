"""story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 수집 잡+목록+수동
재수집. 블루프린트 v3 §2 「댓글·반응 대응」 MVP 조각①. `insight_snapshots.py`(story
#3497)의 due_at 스케줄링+SKIP LOCKED 워커 뼈대를 미러(같은 테이블 공유 안 함 — 그라운딩
③, 댓글 수집은 정규화값을 안 담고 시도 성공/실패만 남긴다).

지속 폴링/커서는 이 조각 스코프 밖(PO 決定) — 매 수집 시도는 provider의 "현재 댓글
전체"(커서 상한 10페이지까지, 그 안에서 다 봤으면 complete=True)를 받아 upsert하고,
complete=True일 때만 이전엔 있었는데 이번엔 없는 댓글을 소프트 삭제로 리컨실한다
(diff 방식 — provider가 실제로 지원하는지와 무관하게 항상 성립하는 일반 로직,
sandbox·threads 둘 다 같은 코드를 탄다. 페드루 PO REQUIRED 2026-09-05 PR#3865
리뷰 — 첫 페이지만 보고 리컨실하면 뒷페이지 댓글이 매 수집마다 오삭제되던 결함)."""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_post_comment import ChannelPostComment, ChannelPostCommentReply, CommentCollectionSchedule

BATCH_SIZE = 50
_COLLECTION_OFFSETS = (timedelta(hours=1), timedelta(days=1), timedelta(days=7))
_REFRESH_MIN_INTERVAL = timedelta(minutes=5)

# story #3528(PO 確定 2026-09-06) — 「지속 폴링」. due 3창(위) 뒤에도 "활성" 게시물은
# 이 주기로 자기재생성한다(due 3창을 대체하지 않음 — additive, 둘이 겹쳐도 upsert라
# 무해). 값은 채널 무관 서비스 상수(ChannelAdapterConfig가 아니라 여기).
_CONTINUOUS_POLL_INTERVAL = timedelta(minutes=30)
# "활성 게시물" = published_at 이후 이 기간 이내 AND (댓글 0건이거나 마지막 댓글
# external_created_at으로부터 _ACTIVE_LAST_COMMENT_WITHIN 이내). 둘 다 벗어나면
# due 3창만(재생성 0, 자연 소멸).
_ACTIVE_PUBLISHED_WITHIN = timedelta(days=14)
_ACTIVE_LAST_COMMENT_WITHIN = timedelta(days=7)
# org당 지속 폴링(30분 주기) 대상 상한 — 초과분(published_at 기준 201번째부터)은
# due 3창만 유지(재생성 0). Threads/IG rate limit 대비 계산(PR 본문): 상한 200 ×
# (24h/30분=48회) = org당 하루 최대 9,600회 fetch_replies 호출 — Threads 유기
# 게시물 API의 일반적인 앱 레벨 한도(수만~수십만/일, 앱 사용량 등급별) 대비 여유.
_ACTIVE_PUBLICATIONS_ORG_CAP = 200
# transient(429/5xx) 백오프 — next_attempt_at = now + min(2^attempt_count분, 60분).
_TRANSIENT_BACKOFF_CAP_MINUTES = 60


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
) -> tuple[list[dict], bool]:
    """channel별 dispatch(insight_snapshots.py::_fetch_for_snapshot과 동형) — 어댑터가
    supports_fetch_replies를 선언 안 했으면 여기 도달 前에 호출자가 이미 unsupported로
    끝낸다(중복 판정 안 둠). 반환의 두 번째 값(complete)은 페드루 PO REQUIRED
    (2026-09-05, PR#3865 리뷰) — 이번 fetch가 그 publication의 댓글 전체를 봤는지.
    False면 collect_comments_for_publication이 삭제 리컨실을 건너뛴다(첫 페이지만
    보고 "없다=삭제됐다"로 오판하면 다음 페이지 댓글이 매 수집마다 소프트 삭제되는
    결함이 있었다 — sandbox=항상 2건 고정이라 테스트가 못 잡던 자리).

    story #3571(Phase2·BE, 페드루 PO 確定 2026-09-06④) — 채널별 if/elif(threads/
    instagram이 연결 조회·토큰 복호화·에러 매핑을 그대로 중복 구현하던 것)를
    해체하고, `publication_command.py:577`의 답변 발송 duck-typing과 같은 형으로
    통일한다: `get_publish_client_module(channel)`이 돌려주는 모듈의 `fetch_replies`
    를 그대로 호출 — 새 채널(facebook)은 그 모듈에 `fetch_replies`만 추가하면
    되고, 이 함수 자체는 더는 안 늘어난다(Threads/Instagram 동작 불변, 회귀 0
    은 테스트로 고정). sandbox/instagram_sandbox는 여전히 별도 분기 — 실 연결이
    없는(access_token="sandbox" 고정) 별개 계약이라 아래 공용 블록(ChannelPublication/
    ChannelConnection 조회)과 억지로 합치지 않는다(그 자체가 새 결합, PO 원칙 위반)."""
    from app.services.channel_adapters import get_publish_client_module

    if channel in ("sandbox", "instagram_sandbox"):
        if external_id is None:
            raise CommentFetchError(error_code="COMMENT_EXTERNAL_ID_MISSING", message="external_id가 없습니다")
        _publish_client = get_publish_client_module(channel)
        import httpx
        async with httpx.AsyncClient() as client:
            return await _publish_client.fetch_replies(client, access_token="sandbox", media_id=external_id)

    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_adapters import ChannelPublishDispatchNotImplementedError
    from app.services.channel_connection import decrypt_for_use
    from app.services.threads_publish import ThreadsPublishError

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

    try:
        _publish_client = get_publish_client_module(channel)
    except ChannelPublishDispatchNotImplementedError as exc:
        # supports_fetch_replies=True인데 발행 클라이언트 모듈이 등록 안 된 설정
        # 오류 방어(정상 경로면 collect_comments_for_publication의 어댑터 게이트가
        # 이미 걸렀을 조합) — 옛 폴백 에러코드 그대로 유지(회귀 0).
        raise CommentFetchError(
            error_code="COMMENT_CHANNEL_NOT_IMPLEMENTED", message=f"fetch_replies dispatch가 없습니다: {channel}",
        ) from exc

    import httpx
    try:
        async with httpx.AsyncClient() as client:
            return await _publish_client.fetch_replies(client, access_token=access_token, media_id=pub.external_id)
    except Exception as exc:  # noqa: BLE001 — ThreadsPublishError는 상태코드로 분류(threads/instagram/facebook 공용)
        if isinstance(exc, ThreadsPublishError):
            if exc.status_code in (401, 403):
                raise CommentFetchError(error_code="CHANNEL_TOKEN_EXPIRED", message=str(exc)) from exc
            if exc.status_code == 429:
                raise CommentFetchError(error_code="CHANNEL_RATE_LIMITED", message=str(exc)) from exc
            raise CommentFetchError(error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", message=str(exc)) from exc
        raise


async def collect_comments_for_publication(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, channel: str, external_id: str | None,
) -> dict[str, Any]:
    """실제 upsert+리컨실(soft-delete) 본체 — 워커(스케줄 행 처리)와 수동 재수집
    (`refresh_comments_now`) 둘 다 이 함수를 그대로 쓴다(두 번째 구현 경로 0)."""
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    adapter = CHANNEL_ADAPTERS.get(channel)
    if adapter is None or not adapter.supports_fetch_replies:
        raise CommentCollectionUnsupportedError()

    raw_comments, complete = await _fetch_replies_raw(
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
    # 페드루 PO REQUIRED(2026-09-05, PR#3865 리뷰) — complete=False(커서 상한에
    # 걸려 이번 수집이 전체를 못 봄)면 리컨실 자체를 건너뛴다. "이번엔 안 보였다"가
    # "삭제됐다"를 증명하지 못하는 경우(뒷페이지 미도달)까지 삭제로 단정하면 안
    # 된다 — upsert(이번에 본 것 갱신)만 하고, 다음 due 창이 마저 본다.
    deleted_count = 0
    if complete:
        existing_rows = (await db.execute(
            select(ChannelPostComment).where(
                ChannelPostComment.publication_id == publication_id, ChannelPostComment.deleted_at.is_(None),
            )
        )).scalars().all()
        for row in existing_rows:
            if row.external_comment_id not in fetched_external_ids:
                row.deleted_at = now
                deleted_count += 1

    return {
        "fetched": len(fetched_external_ids), "deleted": deleted_count, "captured_at": now, "complete": complete,
    }


async def _is_publication_active(db: AsyncSession, *, publication_id: uuid.UUID, now: datetime) -> bool:
    """story #3528 PO 確定 — published_at 이후 14일 이내 AND (댓글 0건이거나 마지막
    댓글 external_created_at으로부터 7일 이내). publication을 못 찾거나 published_at
    자체가 없으면(발행 전 상태를 이 경로가 볼 리 없지만 방어) 비활성으로 fail-closed."""
    from app.models.channel_publication import ChannelPublication

    pub = await db.get(ChannelPublication, publication_id)
    if pub is None or pub.published_at is None:
        return False
    if now - pub.published_at > _ACTIVE_PUBLISHED_WITHIN:
        return False
    last_comment_at = (await db.execute(
        select(func.max(ChannelPostComment.external_created_at)).where(
            ChannelPostComment.publication_id == publication_id, ChannelPostComment.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if last_comment_at is None:
        return True
    return now - last_comment_at <= _ACTIVE_LAST_COMMENT_WITHIN


async def _within_org_continuous_poll_cap(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, now: datetime,
) -> bool:
    """story #3528 PO 確定 — org당 상한 200, "최신 발행 순"으로 자른다. 이 publication
    보다 더 최근에 발행됐고(published_at 내림차순) 아직 14일 활성 창 안인 publication
    개수를 세어 200개 미만이면(=이 publication의 순위가 200 이내) 통과. 정확한
    "활성"(마지막 댓글 7일 축까지) 순위가 아니라 published_at만으로 근사 — PO 문구
    "최신 발행 순"과 일치하고, 매 재생성마다 org 전체의 댓글 최신성까지 다시 계산하는
    비용을 피한다.

    페드루 PO 비차단①(2026-09-06, #3882 리뷰) — 순위 카운트를 댓글 수집 자체를
    지원하는 채널(어댑터 `supports_fetch_replies=True`)로 제한한다. 원래 구현은
    org의 모든 channel_publications(예: hosted_site처럼 댓글 수집이 아예 없는
    채널)까지 셌는데, 그런 발행물은 이 폴링 자원을 절대 안 쓰니 순위를 부풀려
    실제로 폴링 대상인 publication이 상한 밖으로 밀리는 왜곡이 있었다."""
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    pub = await db.get(ChannelPublication, publication_id)
    if pub is None or pub.published_at is None:
        return False
    comment_capable_channels = [
        channel for channel, adapter in CHANNEL_ADAPTERS.items() if adapter.supports_fetch_replies
    ]
    more_recent_count = (await db.execute(
        select(func.count()).select_from(ChannelPublication).where(
            ChannelPublication.org_id == org_id,
            ChannelPublication.channel.in_(comment_capable_channels),
            ChannelPublication.published_at.is_not(None),
            ChannelPublication.published_at > pub.published_at,
            ChannelPublication.published_at >= now - _ACTIVE_PUBLISHED_WITHIN,
        )
    )).scalar_one()
    return more_recent_count < _ACTIVE_PUBLICATIONS_ORG_CAP


async def _schedule_next_continuous_poll_if_active(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, channel: str,
    external_id: str | None, now: datetime,
) -> None:
    """story #3528 — due 행이 captured/failed로 끝난 뒤(호출부가 그 경우에만 부른다)
    이 publication이 아직 활성이고 org 상한 안이면 30분 뒤 다음 due 행을 자기재생성
    한다. 비활성으로 떨어지거나 상한 밖이면 재생성 0(자연 소멸 — due 3창은 이미
    끝났으니 더는 아무 행도 안 남는다)."""
    if not await _is_publication_active(db, publication_id=publication_id, now=now):
        return
    if not await _within_org_continuous_poll_cap(db, org_id=org_id, publication_id=publication_id, now=now):
        return
    stmt = pg_insert(CommentCollectionSchedule).values(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_id=external_id, due_at=now + _CONTINUOUS_POLL_INTERVAL, status="pending",
    ).on_conflict_do_nothing(constraint="uq_comment_collection_schedule_publication_due_at")
    await db.execute(stmt)


# story #3528 라이브 결함(2026-09-06, 카디르 QA 22:15Z·PO 코드 실측 確定) — 자가회수
# 스윕 한 틱의 SQL LIMIT(=삽입 상한과 동일, BATCH_SIZE와 동형 사상). orphan 후보
# SQL이 이미 NOT EXISTS+freshness로 걸러내므로 정상 상태에선 이 LIMIT에 안 걸린다.
_SELF_RECOVERY_SWEEP_SEED_LIMIT = 50


async def _sweep_orphaned_active_publications_for_self_recovery(db: AsyncSession, *, now: datetime) -> int:
    """story #3528 라이브 FAIL(2026-09-06, 카디르 QA·PO 코드 실측 確定) — 「상태
    자가회수 부재」 클래스. `_schedule_next_continuous_poll_if_active`는 due 행이
    captured/failed로 끝난 뒤(아래 루프 안)에만 불린다 — 배포 前에 이미 due 3창
    (+1h/+1d/+7d)을 전부 소진해 pending/in_progress 행이 0으로 남아 있던 publication
    은 씨앗(트리거할 행) 자체가 없어 재생성 체인이 영영 시작되지 않는다(같은 이유로
    체인이 한 번 끊기면 — 크래시로 in_progress 잔류 등 — 그 publication은 영구
    탈락하나, 그 회수는 별건 후보로 관찰만 하고 여기선 다루지 않는다 — 「행 0」만).

    매 틱마다 활성(`_is_publication_active`)·댓글 지원 채널(`supports_fetch_replies`)
    ·org 상한 안(`_within_org_continuous_poll_cap`)이면서 **30분 안에 도래하는 열린
    (pending/in_progress) 행이 0인** publication에 due_at=now 씨앗 행을 심는다
    (UNIQUE 멱등 — 동시 틱 경합 방어, 한 틱 삽입 상한 `_SELF_RECOVERY_SWEEP_SEED_LIMIT`
    건 — 남는 orphan은 다음 틱이 이어서 잡는다, 이미 씨앗 심긴 건 pending 행이 생겨
    다음 스캔에서 자동 제외).

    페드루 PO REQUIRED(2026-09-06, dev DB oneoff 실측·publication 7291bad8) —
    orphan 판정을 "열린 행이 0"에서 "**30분 안에 도래하는** 열린 행이 0"으로 넓힌다.
    좁은 판정은 실측 갭을 놓쳤다 — #3882 배포 前 마지막 due 3창(+1h) 캡처가 끝난
    publication은 +1d/+7d 창이 아직 pending으로 남아 있어 "열린 행 0"을 절대
    만족 못 하는데, 그 pending 행들은 며칠 뒤에나 도래해 그 사이 30분 지속폴링
    체인은 영영 시작 안 된다(마지막 캡처가 #3882 前이라 재생성 콜 자체가 없었던
    탓). "30분 안에 도래" 기준이면 이런 publication도 정확히 걸린다.

    페드루 PO REQUIRED(2026-09-06, PR#3900 리뷰) — orphan 후보 판정을 SQL 한
    쿼리로 민다(NOT EXISTS + 상관 서브쿼리 MAX 집계 + LIMIT). orphan이 0인 정상
    상태(대부분의 틱)에서 이 함수의 비용이 「쿼리 1·0행」이 되게 하는 게 목적 —
    이전 구현은 활성 창(14일) 안 publication을 전부 파이썬으로 받아 행마다 count+
    max 쿼리를 따로 던져, orphan이 하나도 없어도 org×상한 200 규모면 틱마다
    수천 쿼리가 영원히 돌았다."""
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    comment_capable_channels = [
        channel for channel, adapter in CHANNEL_ADAPTERS.items() if adapter.supports_fetch_replies
    ]
    if not comment_capable_channels:
        return 0

    freshness_cutoff = now - _CONTINUOUS_POLL_INTERVAL
    due_soon_cutoff = now + _CONTINUOUS_POLL_INTERVAL
    has_open_row_due_soon = (
        select(func.count()).select_from(CommentCollectionSchedule).where(
            CommentCollectionSchedule.publication_id == ChannelPublication.id,
            CommentCollectionSchedule.status.in_(("pending", "in_progress")),
            CommentCollectionSchedule.due_at <= due_soon_cutoff,
        ).correlate(ChannelPublication).scalar_subquery()
    )
    # 신선도 가드(회귀 방지, 변경 없음) — "방금 이 틱에서 정상 처리된" publication을
    # orphan으로 오판해 중복 씨앗을 심지 않게 한다. MAX(due_at)를 전체 행이 아니라
    # "이미 도래한"(due_at<=now) 행으로만 좁힌다 — 아니면 +1d/+7d처럼 먼 미래
    # pending 행의 due_at이 MAX를 차지해 "최근 활동 없음"을 절대 못 보게 된다(위
    # 7291bad8 갭과 같은 함정 — 이 필터가 그걸 피한다).
    last_actionable_activity_at = (
        select(func.max(CommentCollectionSchedule.due_at)).where(
            CommentCollectionSchedule.publication_id == ChannelPublication.id,
            CommentCollectionSchedule.due_at <= now,
        ).correlate(ChannelPublication).scalar_subquery()
    )

    candidates = (await db.execute(
        select(ChannelPublication).where(
            ChannelPublication.channel.in_(comment_capable_channels),
            ChannelPublication.published_at.is_not(None),
            ChannelPublication.published_at >= now - _ACTIVE_PUBLISHED_WITHIN,
            has_open_row_due_soon == 0,
            or_(last_actionable_activity_at.is_(None), last_actionable_activity_at < freshness_cutoff),
        ).order_by(ChannelPublication.published_at.desc())
        .limit(_SELF_RECOVERY_SWEEP_SEED_LIMIT)
    )).scalars().all()

    seeded = 0
    for pub in candidates:
        if not await _is_publication_active(db, publication_id=pub.id, now=now):
            continue
        if not await _within_org_continuous_poll_cap(db, org_id=pub.org_id, publication_id=pub.id, now=now):
            continue
        stmt = pg_insert(CommentCollectionSchedule).values(
            id=uuid.uuid4(), org_id=pub.org_id, publication_id=pub.id, channel=pub.channel,
            external_id=pub.external_id, due_at=now, status="pending",
        ).on_conflict_do_nothing(constraint="uq_comment_collection_schedule_publication_due_at")
        await db.execute(stmt)
        seeded += 1
    if seeded:
        await db.commit()
    return seeded


async def process_due_comment_collections(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """`insight_snapshots.py::process_due_insight_snapshots`와 동형 SKIP LOCKED 2단계
    커밋(클레임 commit → 개별 처리 commit/rollback 격리)."""
    from app.services.publication_command import classify_failure_kind, FAILURE_KIND_CONNECTION, FAILURE_KIND_TRANSIENT

    now = now or datetime.now(timezone.utc)
    rows = (await db.execute(
        select(CommentCollectionSchedule).where(
            CommentCollectionSchedule.status == "pending", CommentCollectionSchedule.due_at <= now,
            # story #3528 — transient 백오프 지연 존중(next_attempt_at IS NULL=기존
            # 행·최초 시도라 그대로 즉시 집힘, 회귀 0).
            or_(
                CommentCollectionSchedule.next_attempt_at.is_(None),
                CommentCollectionSchedule.next_attempt_at <= now,
            ),
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
                    await _schedule_next_continuous_poll_if_active(
                        db, org_id=row.org_id, publication_id=row.publication_id, channel=row.channel,
                        external_id=row.external_id, now=now,
                    )
                    await db.commit()
                    counts["failed"] += 1
                elif failure_kind == FAILURE_KIND_TRANSIENT:
                    row.attempt_count += 1
                    row.error_code = exc.error_code
                    if row.attempt_count >= 5:
                        row.status = "failed"
                        await _schedule_next_continuous_poll_if_active(
                            db, org_id=row.org_id, publication_id=row.publication_id, channel=row.channel,
                            external_id=row.external_id, now=now,
                        )
                        await db.commit()
                        counts["failed"] += 1
                    else:
                        # story #3528 — 지수 백오프(2^attempt_count분, 60분 상한).
                        # pending_retry는 이 행 자체가 아직 안 끝났으니(재생성 대상
                        # 아님) 여기선 _schedule_next_continuous_poll_if_active를
                        # 안 부른다 — 이 행이 나중에 captured/failed로 끝나야 부른다.
                        row.status = "pending"
                        delay_minutes = min(2 ** row.attempt_count, _TRANSIENT_BACKOFF_CAP_MINUTES)
                        row.next_attempt_at = now + timedelta(minutes=delay_minutes)
                        await db.commit()
                        counts["pending_retry"] += 1
                else:
                    row.status = "failed"
                    row.error_code = exc.error_code
                    await _schedule_next_continuous_poll_if_active(
                        db, org_id=row.org_id, publication_id=row.publication_id, channel=row.channel,
                        external_id=row.external_id, now=now,
                    )
                    await db.commit()
                    counts["failed"] += 1
                continue

            row.status = "captured"
            row.captured_at = result["captured_at"]
            # 페드루 PO REQUIRED(2026-09-05, PR#3865 리뷰) — 커서 상한에 걸려 이번
            # 수집이 전체를 못 봤으면(complete=False) 삭제 리컨실은 건너뛰었지만
            # upsert 자체는 성공했다 — status는 "captured" 그대로 두고 error_code로만
            # "다 못 봤다"를 남긴다(다음 due 창이 이어서 본다, 실패로 재시도 대상 X).
            row.error_code = None if result["complete"] else "COMMENT_COLLECTION_INCOMPLETE_PAGE"
            await _schedule_next_continuous_poll_if_active(
                db, org_id=row.org_id, publication_id=row.publication_id, channel=row.channel,
                external_id=row.external_id, now=now,
            )
            await db.commit()
            counts["captured"] += 1
        except Exception:  # noqa: BLE001 — 이 행 하나만 막는다(전체 배치 안 죽음).
            await db.rollback()
            row.status = "failed"
            row.error_code = "COMMENT_COLLECTION_UNCLASSIFIED_ERROR"
            await _schedule_next_continuous_poll_if_active(
                db, org_id=row.org_id, publication_id=row.publication_id, channel=row.channel,
                external_id=row.external_id, now=now,
            )
            await db.commit()
            counts["failed"] += 1

    # story #3528 라이브 FAIL(2026-09-06) — 이번 틱이 방금 claim한 rows(위에서 이미
    # 스냅샷됨)와는 별개로, 이번 틱 끝에 자가회수 씨앗을 심는다. due_at=now로 심어도
    # 이번 틱의 claim은 이미 지나갔으므로 다음 틱이 그 씨앗을 집는다(관찰 가능한
    # 2단계: 이번 틱=씨앗 생성, 다음 틱=수집·재생성 이어짐).
    counts["self_recovery_seeded"] = await _sweep_orphaned_active_publications_for_self_recovery(db, now=now)

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
    # process_due_comment_collections와 동형 — 다 못 봤으면(complete=False) error_code에
    # 만 남긴다(captured 자체는 성공이었다).
    schedule_row.error_code = None if result["complete"] else "COMMENT_COLLECTION_INCOMPLETE_PAGE"
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

    # 페드루 PO REQUIRED(2026-09-05, PR#3865 리뷰, 유나 §22-9 「지워진 댓글은 숨기지
    # 않고 대응 대상에서 뺀다」) — 페이지 무관 서버 전체 수. active_count는
    # count_comments_by_publication_ids와 정확히 같은 정의(deleted_at IS NULL)를
    # 재사용해 보드 comments_count와 항상 같은 값이 나오게 한다(두 번째 구현 0).
    # 소프트 삭제 행의 text는 그대로 보존(하드 삭제·마스킹 안 함, 현 구현 그대로).
    active_counts = await count_comments_by_publication_ids(db, publication_ids=[publication_id])
    active_count = active_counts.get(publication_id, 0)
    deleted_count = (await db.execute(
        select(func.count()).select_from(ChannelPostComment).where(
            ChannelPostComment.org_id == org_id, ChannelPostComment.publication_id == publication_id,
            ChannelPostComment.deleted_at.is_not(None),
        )
    )).scalar_one()

    # story #3516 조각②-b(additive, 미르코 3517② 그라운딩 갭 2026-09-06) —
    # 댓글당 최신 답변 1건, 배치 조인 1회(N+1 X). ROW_NUMBER 윈도우로 comment_id별
    # created_at 내림차순 1위만 남긴다(같은 댓글에 재상신 이력이 있어도 최신만).
    latest_reply_by_comment_id = await _latest_reply_by_comment_ids(
        db, comment_ids=[c.id for c in rows],
    )

    # story #3593(Phase2·BE, 페드루 PO 確定 2026-09-06) — 유나 실측: 답변이 2건
    # 이상이면(재상신 이력) 화면의 배지 하나(=최신 답변 status)가 「이 발행됨이
    # 어느 답변의 상태인가」를 말 못 한다. 최신 답변 요약(위)과 별개로 댓글당
    # 전체 답변 개수를 배치 조회(N+1 X) — FE가 "답변 N · 최신 {상태}" 형을
    # 조립할 수 있게. count_comments_by_publication_ids와 동형 GROUP BY 패턴.
    reply_counts_by_comment_id = await _reply_counts_by_comment_ids(
        db, comment_ids=[c.id for c in rows],
    )
    # story #3596 — 안 보낸 초안(있으면 «이어서 답변» 버튼)·보낸 답변 수(배지 N).
    open_reply_draft_by_comment_id = await _open_reply_draft_by_comment_ids(
        db, comment_ids=[c.id for c in rows],
    )
    sent_reply_counts_by_comment_id = await _sent_reply_counts_by_comment_ids(
        db, comment_ids=[c.id for c in rows],
    )

    # story #3529(additive, 유나 §22-15 채택) — 댓글 목록 reply{} 요약에 발송 명령
    # 상태 4필드(command_status·failure_kind·next_attempt_at·reason_code)를 얹기
    # 위한 배치 조회(N+1 X) — PublicationCommand 그대로, 새 컬럼/새 이름 0.
    command_by_id = await _commands_by_ids(
        db, command_ids=[r.command_id for r in latest_reply_by_comment_id.values() if r.command_id is not None],
    )

    # 조각②-b 추가(유나 16회차) — comments_last_collected_at과 같은 계산 자리
    # (바로 위 `last_captured_at`, refresh_comments_now의 rate-limit 판정과는
    # 별개 축 — "지금 화면에 보여줄 마지막 수집 시각"을 그대로 재사용). null=지금
    # 바로 재수집 가능, 값=그 시각까지 429.
    comments_next_allowed_at: datetime | None = None
    if last_captured_at is not None:
        elapsed = datetime.now(timezone.utc) - last_captured_at
        if elapsed < _REFRESH_MIN_INTERVAL:
            comments_next_allowed_at = last_captured_at + _REFRESH_MIN_INTERVAL

    return {
        "last_collected_at": last_captured_at, "comments": rows,
        "active_count": active_count, "deleted_count": deleted_count,
        "reply_by_comment_id": latest_reply_by_comment_id,
        "comments_next_allowed_at": comments_next_allowed_at,
        "command_by_id": command_by_id,
        "reply_counts_by_comment_id": reply_counts_by_comment_id,
        "open_reply_draft_by_comment_id": open_reply_draft_by_comment_id,
        "sent_reply_counts_by_comment_id": sent_reply_counts_by_comment_id,
    }


async def _commands_by_ids(db: AsyncSession, *, command_ids: list[uuid.UUID]) -> dict[uuid.UUID, "PublicationCommand"]:  # noqa: F821
    """story #3529 — publication_command_id 배치 조회(N+1 X). command_ids 없으면
    빈 dict(호출부가 `.get(command_id)` → None="이 답변엔 명령이 없다")."""
    if not command_ids:
        return {}
    from app.models.publication_command import PublicationCommand

    rows = (await db.execute(
        select(PublicationCommand).where(PublicationCommand.id.in_(command_ids))
    )).scalars().all()
    return {row.id: row for row in rows}


async def _latest_reply_by_comment_ids(
    db: AsyncSession, *, comment_ids: list[uuid.UUID],
) -> dict[uuid.UUID, ChannelPostCommentReply]:
    """댓글당 최신 답변 1건 배치 조회 — ROW_NUMBER 윈도우(파티션=comment_id, 정렬=
    created_at 내림차순)로 1위만 남긴다. comment_ids 없으면 빈 dict(호출부가
    `.get(comment_id)` → None="무응답")."""
    if not comment_ids:
        return {}
    from sqlalchemy.orm import aliased

    rn = func.row_number().over(
        partition_by=ChannelPostCommentReply.comment_id, order_by=ChannelPostCommentReply.created_at.desc(),
    ).label("rn")
    subq = (
        select(ChannelPostCommentReply, rn)
        .where(ChannelPostCommentReply.comment_id.in_(comment_ids))
        .subquery()
    )
    reply_alias = aliased(ChannelPostCommentReply, subq)
    rows = (await db.execute(select(reply_alias).where(subq.c.rn == 1))).scalars().all()
    return {reply.comment_id: reply for reply in rows}


async def _open_reply_draft_by_comment_ids(
    db: AsyncSession, *, comment_ids: list[uuid.UUID],
) -> dict[uuid.UUID, ChannelPostCommentReply]:
    """story #3596(Phase2·BE, 페드루 PO 確定 2026-09-06) — 댓글당 «안 보낸» 최신
    답변(status draft/pending) 1건. `_latest_reply_by_comment_ids`와 동형 ROW_NUMBER
    윈도우, WHERE절만 status 필터 추가(sent/failed는 여기 안 잡힌다 — 이미 나갔거나
    이미 실패 흐름이 따로 있다)."""
    if not comment_ids:
        return {}
    from sqlalchemy.orm import aliased

    rn = func.row_number().over(
        partition_by=ChannelPostCommentReply.comment_id, order_by=ChannelPostCommentReply.created_at.desc(),
    ).label("rn")
    subq = (
        select(ChannelPostCommentReply, rn)
        .where(
            ChannelPostCommentReply.comment_id.in_(comment_ids),
            ChannelPostCommentReply.status.in_(("draft", "pending")),
        )
        .subquery()
    )
    reply_alias = aliased(ChannelPostCommentReply, subq)
    rows = (await db.execute(select(reply_alias).where(subq.c.rn == 1))).scalars().all()
    return {reply.comment_id: reply for reply in rows}


async def _sent_reply_counts_by_comment_ids(
    db: AsyncSession, *, comment_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    """story #3596 — 댓글당 «실제로 나간» 답변 개수(status=sent만). 배지 「답변 N」
    의 N은 이제 이 값(초안은 배지가 아니라 버튼 낱말로만 드러난다, 유나 §확定8)."""
    if not comment_ids:
        return {}
    rows = (await db.execute(
        select(ChannelPostCommentReply.comment_id, func.count())
        .where(
            ChannelPostCommentReply.comment_id.in_(comment_ids),
            ChannelPostCommentReply.status == "sent",
        )
        .group_by(ChannelPostCommentReply.comment_id)
    )).all()
    return {comment_id: count for comment_id, count in rows}


async def _reply_counts_by_comment_ids(
    db: AsyncSession, *, comment_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    """story #3593 — 댓글당 전체 답변 개수(초안 포함 모든 status) 배치 조회
    (N+1 X). count_comments_by_publication_ids와 동형 GROUP BY 패턴.
    comment_ids 없으면 빈 dict(호출부가 `.get(comment_id, 0)`)."""
    if not comment_ids:
        return {}
    rows = (await db.execute(
        select(ChannelPostCommentReply.comment_id, func.count())
        .where(ChannelPostCommentReply.comment_id.in_(comment_ids))
        .group_by(ChannelPostCommentReply.comment_id)
    )).all()
    return {comment_id: count for comment_id, count in rows}


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


async def get_last_collected_at_by_publication_ids(
    db: AsyncSession, *, publication_ids: list[uuid.UUID],
) -> dict[uuid.UUID, datetime]:
    """페드루 PO REQUIRED(2026-09-05, 유나양·민 레군 그라운딩) — 3502 성과 보드의
    `comments_last_collected_at` 배치 조회. `list_comments_for_publication`의
    `last_captured_at`과 정확히 같은 정의(CommentCollectionSchedule.status="captured"
    MAX(captured_at))를 재사용한다(두 번째 구현 0). publication_id 없으면 dict에서
    빠짐(호출부가 `.get(pid)` → None="미수집")."""
    if not publication_ids:
        return {}
    rows = (await db.execute(
        select(CommentCollectionSchedule.publication_id, func.max(CommentCollectionSchedule.captured_at))
        .where(
            CommentCollectionSchedule.publication_id.in_(publication_ids),
            CommentCollectionSchedule.status == "captured",
        )
        .group_by(CommentCollectionSchedule.publication_id)
    )).all()
    return {pid: captured_at for pid, captured_at in rows}
