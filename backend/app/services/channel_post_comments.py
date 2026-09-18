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

from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import decode_metric_cursor, encode_metric_cursor
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

# story #3612 — _fetch_replies_raw의 선검사 실패 코드 전부(연결 비활성/연결 없음
# ·발행 기록 없음/자격 없음). 전부 "provider가 알려준 새 사실"이 아니라 우리 쪽
# 사전 조회가 막은 것이라 승격(_promote_connection_status)·기록 대상이 아니고,
# 스케줄 루프는 이 코드들을 만나면 그 행을 "connection_inactive"로 쉬운다(AC1·AC2).
_COMMENT_PRECHECK_CODES = frozenset({"CHANNEL_CONNECTION_NOT_ACTIVE", "COMMENT_PUBLICATION_NOT_FOUND"})


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


async def wake_resting_comment_schedules(db: AsyncSession, *, connection_id: uuid.UUID) -> int:
    """story #3612(라이브 결함, 배포 47) — `process_due_comment_collections`가
    CHANNEL_CONNECTION_NOT_ACTIVE 선검사에 막히면 그 스케줄 행을 `status=
    "connection_inactive"`로 쉬게 한다(AC2, 매 틱 재시도 0 — 승격/기록도 안 함).
    쉬게만 하고 깨우는 손이 없으면 연결이 나중에 복귀해도 그 발행은 영영 재수집이
    안 되는 반쪽 처방이 된다 — 연결이 non-active→active로 돌아오는 «모든» 경로
    (재연결 upsert·자격 교체·자동 갱신 성공, `channel_connection.py`의 세 자리)가
    공유하는 단일 깨우는 손이 이 함수다(호출부마다 각자 깨우는 로직을 새로 짜지
    않는다).

    story #3663(라이브 결함, 배포 51) — 한 publication에는 `_COLLECTION_OFFSETS`별
    행이 여러 개 있고, 연결이 오래 쉬면 그 행들이 전부 connection_inactive가 된다.
    예전엔 그 «전부»에 같은 `func.now()`(트랜잭션 타임스탬프 하나)를 줘서, 쉬는
    행이 2개 이상인 publication에서 (publication_id, due_at) 유니크가 결정적으로
    깨졌다(재연결 콜백 500). 지금은 행마다 마이크로초씩 벌려 서로 다른 due_at을
    준다 — 이미 지난(due_at<=now) 행만 그렇게 "지금 이후"로 되돌리고, 아직 미래인
    행은 원래 due_at을 그대로 둔다(앞당기지 않는다).

    CHANGES(카디르 QA real PG 재현, PO 페드루 처방 2026-09-08, 2·3차) — 마이크로초
    오프셋이 "새로 배정하는 값들끼리만"·"이번에 깨우는 배치의 보존 미래 행만"과는
    안 겹치게 했지만, `uq_comment_collection_schedule_publication_due_at`는
    **status 무관 테이블 전체**에 걸린 제약이다 — 같은 publication의 다른 상태
    (pending·in_progress·captured 등) 행이 이미 쥔 due_at은 이 함수 시야 밖이라
    새로 배정한 값이 그것과도 충돌할 수 있었다(부분집합 3형: 새-새·새-보존미래·
    새-타상태). 근본 처방 — 새 due_at을 정할 때 회피집합을 그 publication의
    «상태 무관 기존 due_at 전체»로 넓힌다."""
    from app.models.channel_publication import ChannelPublication

    now = datetime.now(timezone.utc)
    resting = (await db.execute(
        select(
            CommentCollectionSchedule.id, CommentCollectionSchedule.publication_id,
            CommentCollectionSchedule.due_at,
        )
        .where(
            CommentCollectionSchedule.status == "connection_inactive",
            CommentCollectionSchedule.publication_id.in_(
                select(ChannelPublication.id).where(ChannelPublication.connection_id == connection_id)
            ),
        )
        .order_by(CommentCollectionSchedule.publication_id, CommentCollectionSchedule.due_at)
        .with_for_update()
    )).all()
    if not resting:
        return 0

    publication_ids = {publication_id for _row_id, publication_id, _due_at in resting}
    occupied_by_pub: dict[uuid.UUID, set[datetime]] = {}
    for publication_id, due_at in (await db.execute(
        select(CommentCollectionSchedule.publication_id, CommentCollectionSchedule.due_at)
        .where(CommentCollectionSchedule.publication_id.in_(publication_ids))
    )).all():
        occupied_by_pub.setdefault(publication_id, set()).add(due_at)

    wake_offset_by_pub: dict[uuid.UUID, int] = {}
    for row_id, publication_id, due_at in resting:
        if due_at is not None and due_at > now:
            new_due_at = due_at
        else:
            occupied = occupied_by_pub.get(publication_id, set())
            offset = wake_offset_by_pub.get(publication_id, 0)
            new_due_at = now + timedelta(microseconds=offset)
            while new_due_at in occupied:
                offset += 1
                new_due_at = now + timedelta(microseconds=offset)
            wake_offset_by_pub[publication_id] = offset + 1
        await db.execute(
            update(CommentCollectionSchedule)
            .where(CommentCollectionSchedule.id == row_id)
            .values(status="pending", due_at=new_due_at)
        )
    return len(resting)


def _text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def _fetch_replies_raw(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, channel: str, external_id: str | None,
) -> tuple[list[dict], bool, int | None]:
    """channel별 dispatch(insight_snapshots.py::_fetch_for_snapshot과 동형) — 어댑터가
    supports_fetch_replies를 선언 안 했으면 여기 도달 前에 호출자가 이미 unsupported로
    끝낸다(중복 판정 안 둠). 반환의 두 번째 값(complete)은 페드루 PO REQUIRED
    (2026-09-05, PR#3865 리뷰) — 이번 fetch가 그 publication의 댓글 전체를 봤는지.
    False면 collect_comments_for_publication이 삭제 리컨실을 건너뛴다(첫 페이지만
    보고 "없다=삭제됐다"로 오판하면 다음 페이지 댓글이 매 수집마다 소프트 삭제되는
    결함이 있었다 — sandbox=항상 2건 고정이라 테스트가 못 잡던 자리). 세 번째 값
    (story #3618)은 채널이 말하는 전체 댓글 개수(§7 Phase2 「댓글 누락률」 정의의
    분모) — 각 어댑터 `fetch_replies`가 그대로 3-tuple로 반환해 이 함수는 그대로
    통과시킨다(새 판정 로직 0, 여기서 조립하지 않음 — 어댑터가 아는 것을 여기서
    다시 추론하지 않는다).

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
        from app.models.channel_publication import ChannelPublication

        # story #3528(2026-09-12 근본처방) — sandbox 댓글의 결정적 timestamp는
        # 이 발행물의 실 published_at을 필요로 한다(sandbox_publish.py::
        # _deterministic_comment 참고, 벽시계 고정값이 「마지막 댓글로부터 7일」
        # 활성 창을 영구 False로 고정시키던 실사고 재발 방지) — 이전엔 instagram_
        # sandbox의 만료 마커 분기에서만 조건부로 pub을 조회했으나, 이제 두 sandbox
        # 채널 다 published_at이 항상 필요해 무조건 조회로 승격한다(옛 "새 DB 왕복
        # 0" 최적화 전제가 이 근본처방으로 무효가 됨).
        pub = await db.get(ChannelPublication, publication_id)
        if pub is None or pub.published_at is None:
            raise CommentFetchError(
                error_code="COMMENT_PUBLICATION_NOT_FOUND",
                message=f"channel_publication을 찾을 수 없습니다: {publication_id}",
            )
        # story #3640 — instagram_sandbox의 [sandbox:expire-after-publish] 마커가
        # media_id에 새긴 영구 접미사를 fetch_replies가 볼 때마다 401을 던지던
        # 「영구 지뢰」를 닫는다: 이 발행물이 이미 한 번 그 401을 관측했으면
        # (sandbox_expired_once) 접미사를 벗긴 media_id로 불러 200을 받는다.
        effective_external_id = external_id
        if channel == "instagram_sandbox":
            from app.services.instagram_sandbox_publish import (
                _EXPIRE_AFTER_PUBLISH_SUFFIX as _IG_EXPIRE_SUFFIX,
            )

            if external_id.endswith(_IG_EXPIRE_SUFFIX) and pub.sandbox_expired_once:
                effective_external_id = external_id[: -len(_IG_EXPIRE_SUFFIX)]
        _publish_client = get_publish_client_module(channel)
        from app.services.threads_publish import ThreadsPublishError
        import httpx
        try:
            async with httpx.AsyncClient() as client:
                return await _publish_client.fetch_replies(
                    client, access_token="sandbox", media_id=effective_external_id, published_at=pub.published_at,
                )
        except ThreadsPublishError as exc:
            # story #3640 — 위에서 접미사를 못 벗겼다(=이번이 첫 401)면 여기서
            # 「관측했다」로 표시해 다음 틱부터 벗겨진 media_id로 부른다(AC1).
            if pub is not None and not pub.sandbox_expired_once:
                pub.sandbox_expired_once = True
                await db.flush()
            # story #3597 — instagram_sandbox_publish.py::fetch_replies가 새
            # [sandbox:expire-after-publish] 마커로 401을 던지기 전까지는 이 분기가
            # 예외를 낼 일이 없어(sandbox_publish.py는 fetch_replies에서 절대
            # raise 안 함) 이 try/except 자체가 없었다 — 아래 공용 블록(157행대)의
            # 매핑을 그대로 재사용(새 판정 로직 0).
            # story #3605 — 401/403만 보던 휴리스틱을 classify_graph_error_code
            # (graph_api_errors.py, channel_posts.py::_classify_threads_error와
            # 같은 공용 함수)로 교체 — Graph subcode·10·200~299 family까지 정밀
            # 판정(발행 경로와 드리프트 0).
            from app.services.graph_api_errors import classify_graph_error_code

            error_code = classify_graph_error_code(
                status_code=exc.status_code, provider_error_code=exc.provider_error_code,
                provider_error_subcode=exc.provider_error_subcode, provider_error_type=exc.provider_error_type,
            )
            raise CommentFetchError(error_code=error_code, message=str(exc)) from exc

    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_adapters import ChannelPublishDispatchNotImplementedError
    from app.services.channel_connection import decrypt_for_use
    from app.services.threads_publish import ThreadsPublishError

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == publication_id)
    )).scalar_one_or_none()
    if pub is None or pub.external_id is None:
        # story #3612(PO 대조 CHANGES-1, insight_snapshots.py::_fetch_*_via_connection과
        # 같은 패턴) — "발행 기록 없음"은 연결 상태와 무관한 다른 사실인데 CHANNEL_
        # CONNECTION_NOT_ACTIVE를 재사용하고 있었다. 자기 코드로 분리(_COMMENT_
        # PRECHECK_CODES에도 등재 — 선검사 성격은 동일해 승격/기록 대상은 아니다).
        raise CommentFetchError(
            error_code="COMMENT_PUBLICATION_NOT_FOUND",
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

    # story #3640 — facebook_sandbox의 [sandbox:expire-after-publish] 마커도 ig와
    # 동형(영구 접미사 → 매 틱 401). 이 공용 블록이 이미 pub를 갖고 있어 sandbox
    # 분기 재사용 없이 여기서 바로(실 threads/instagram/facebook은 접미사가 애초에
    # 안 붙으니 이 if가 no-op).
    effective_external_id = pub.external_id
    if channel == "facebook_sandbox":
        from app.services.facebook_sandbox_publish import (
            _EXPIRE_AFTER_PUBLISH_SUFFIX as _FB_EXPIRE_SUFFIX,
        )

        if pub.external_id.endswith(_FB_EXPIRE_SUFFIX) and pub.sandbox_expired_once:
            effective_external_id = pub.external_id[: -len(_FB_EXPIRE_SUFFIX)]

    # story #3528(2026-09-12 근본처방) — facebook_sandbox만 published_at을 받는다
    # (sandbox_publish.py/instagram_sandbox_publish.py와 동형 이유, 위 §참고). 실
    # threads/instagram/facebook의 fetch_replies는 이 인자 자체가 없다(실 provider
    # 응답이 진짜 시각을 주므로 불필요) — 시그니처가 갈리는 유일한 자리라 kwargs를
    # 조건부로 조립한다(새 판정 로직 0, 위 effective_external_id 분기와 동형 축).
    extra_kwargs = {"published_at": pub.published_at} if channel == "facebook_sandbox" else {}
    import httpx
    try:
        async with httpx.AsyncClient() as client:
            return await _publish_client.fetch_replies(
                client, access_token=access_token, media_id=effective_external_id, **extra_kwargs,
            )
    except Exception as exc:  # noqa: BLE001 — ThreadsPublishError는 상태코드로 분류(threads/instagram/facebook 공용)
        if isinstance(exc, ThreadsPublishError):
            # story #3640 — 첫 401(=접미사를 못 벗겼다)이면 관측 기록.
            if channel == "facebook_sandbox" and not pub.sandbox_expired_once:
                from app.services.facebook_sandbox_publish import (
                    _EXPIRE_AFTER_PUBLISH_SUFFIX as _FB_EXPIRE_SUFFIX,
                )

                if pub.external_id.endswith(_FB_EXPIRE_SUFFIX):
                    pub.sandbox_expired_once = True
                    await db.flush()
            # story #3605 — 위 sandbox 분기와 동일하게 classify_graph_error_code로
            # 교체(새 판정 로직 0, 공용 함수 재사용).
            from app.services.graph_api_errors import classify_graph_error_code

            error_code = classify_graph_error_code(
                status_code=exc.status_code, provider_error_code=exc.provider_error_code,
                provider_error_subcode=exc.provider_error_subcode, provider_error_type=exc.provider_error_type,
            )
            raise CommentFetchError(error_code=error_code, message=str(exc)) from exc
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

    raw_comments, complete, channel_reported_comment_count = await _fetch_replies_raw(
        db, org_id=org_id, publication_id=publication_id, channel=channel, external_id=external_id,
    )

    now = datetime.now(timezone.utc)
    fetched_external_ids: set[str] = set()
    # story #3805(Phase3·3-1·PR 4, 페드루 PO 確定 2026-09-11 12:12Z) — 어댑터가
    # 끌어올린 공용 계약 `parent_external_id`(threads_publish.py 등 3종 동형)를
    # 모아 두고, 이 배치의 upsert가 전부 끝난 뒤 한 번에 해소한다(부모·답글이
    # 같은 페이지에 같이 올 수 있어 upsert 루프 안에서 즉시 조회하면 부모가
    # 아직 안 커밋된 채일 수 있다 — 배치 후처리로 순서 문제를 피한다).
    parent_external_id_by_child: dict[str, str] = {}
    # story #3805 PR 4 후속(페드루 PO 確定 2026-09-11 12:29Z, 「조용히 0」 처방) —
    # 어댑터가 실어 보낸 `parent_field_observed`를 모아 배치 하나라도 부재(False)면
    # 이 연결의 답글 구분이 불가능했다고 판정한다(아래 reply_detection 갱신).
    saw_unobserved_parent_field = False
    for raw in raw_comments:
        external_comment_id = str(raw.get("id"))
        if not external_comment_id or external_comment_id == "None":
            continue
        fetched_external_ids.add(external_comment_id)
        parent_external_id = raw.get("parent_external_id")
        if parent_external_id:
            parent_external_id_by_child[external_comment_id] = str(parent_external_id)
        if not raw.get("parent_field_observed", True):
            saw_unobserved_parent_field = True
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

    # story #3805 PR 4 — parent_comment_id 해소. 외부 parent id로 이 publication
    # 안(부모는 항상 같은 게시물 밑 댓글)의 기존 행을 조회 — 이번 배치에서 막
    # upsert된 부모(같은 페이지에 부모·답글이 같이 옴)든, 이전 수집에서 이미 들어온
    # 부모든 둘 다 이 select 하나로 잡는다(upsert가 이미 commit 불요 — 같은
    # 트랜잭션 안 select는 방금 execute한 INSERT를 본다). 부모를 못 찾으면(아직
    # 미수집) null로 남긴다 — 외부 parent id 자체는 raw JSONB에 이미 있어 유실 0.
    if parent_external_id_by_child:
        parent_rows = (await db.execute(
            select(ChannelPostComment.id, ChannelPostComment.external_comment_id).where(
                ChannelPostComment.publication_id == publication_id,
                ChannelPostComment.external_comment_id.in_(set(parent_external_id_by_child.values())),
            )
        )).all()
        internal_id_by_external_id = {ext: internal for internal, ext in parent_rows}
        for child_external_id, parent_external_id in parent_external_id_by_child.items():
            parent_internal_id = internal_id_by_external_id.get(parent_external_id)
            if parent_internal_id is None:
                continue
            await db.execute(
                update(ChannelPostComment)
                .where(
                    ChannelPostComment.publication_id == publication_id,
                    ChannelPostComment.external_comment_id == child_external_id,
                )
                .values(parent_comment_id=parent_internal_id)
            )

    # story #3805 PR 4 후속(페드루 PO 確定 2026-09-11 12:29Z, 「조용히 0」 처방) —
    # 이 연결의 reply_detection_unavailable_at 갱신. 이번 배치가 빈 응답(raw_
    # comments=0)이면 아무 증거가 없어(관측 자체를 안 함) 갱신을 건너뛴다 — 기존
    # 상태를 그대로 둔다. 자가치유: 다음 수집에 필드가 다시 관측되면 null로
    # 되돌아간다(연결이 영구히 「구분 불가」로 낙인찍히지 않는다).
    if raw_comments:
        from app.models.channel_connection import ChannelConnection
        from app.models.channel_publication import ChannelPublication

        pub_for_conn = await db.get(ChannelPublication, publication_id)
        if pub_for_conn is not None:
            await db.execute(
                update(ChannelConnection)
                .where(ChannelConnection.id == pub_for_conn.connection_id)
                .values(reply_detection_unavailable_at=now if saw_unobserved_parent_field else None)
            )

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
        "channel_reported_comment_count": channel_reported_comment_count,
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
            # story #3612 — connection_inactive도 "열린 행"으로 센다. 이 스윕은 그
            # 상태를 모르고 "due 3창 소진+최근활동없음"만 보는데, 뺴놓으면 매 틱
            # (a) 루프가 connection_inactive로 쉬게 함 → (b) 이 스윕이 그 즉시
            # "행 0"으로 보고 due_at=now 씨앗을 다시 심음 → (c) 다음 틱이 다시 그
            # 씨앗을 집어 선검사에 또 막혀 connection_inactive → 반복. "쉬게 한다
            # (AC2 매 틱 재시도 0)"가 이 스윕 때문에 무력화되던 것을 실측(로컬
            # 재현)으로 잡음 — 연결이 복귀하면 wake_resting_comment_schedules가
            # pending으로 되돌리므로 그 뒤엔 정상적으로 다시 열린 행으로 잡힌다.
            CommentCollectionSchedule.status.in_(("pending", "in_progress", "connection_inactive")),
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
                if exc.error_code in _COMMENT_PRECHECK_CODES:
                    # story #3612(라이브 결함, 배포 47) — 이건 선검사(이미 비활성/연결
                    # 없음/무자격)가 막은 것이지 provider가 새로 알려준 사실이 아니다.
                    # 승격·last_error 기록 대상이 아니다(AC1 — 안 그러면 그 이전에
                    # 적힌 진짜 원인(CHANNEL_TOKEN_EXPIRED 등)이 매 틱 이 순환 문구로
                    # 덮인다, 실사고 재현). 지속폴링 재생성도 안 부른다 — 이 행을
                    # "쉬게" 한다(pending이 아니라 connection_inactive라 다음 due
                    # 스캔에서 안 잡힘, AC2 "매 틱 재시도 0"). 연결이 active로 복귀
                    # 하면 wake_resting_comment_schedules()가 pending으로 되돌린다.
                    row.status = "connection_inactive"
                    row.error_code = exc.error_code
                    await db.commit()
                    counts["connection_inactive"] = counts.get("connection_inactive", 0) + 1
                elif failure_kind == FAILURE_KIND_CONNECTION:
                    await _promote_connection_status(
                        db, publication_id=row.publication_id, error_code=exc.error_code, message=str(exc),
                    )
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
            # story #3618 — §7 Phase2 「댓글 누락률」 분모(채널이 말하는 전체 개수).
            row.channel_reported_comment_count = result["channel_reported_comment_count"]
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


async def _promote_connection_status(
    db: AsyncSession, *, publication_id: uuid.UUID, error_code: str | None = None, message: str | None = None,
) -> None:
    """insight_snapshots.py::_promote_connection_status_for_snapshot과 동형 — 가드는
    channel 이름이 아니라 connection 유무(sandbox는 connection 자체가 없어 no-op).
    story #3597(Phase2·BE, 페드루 PO 確定 2026-09-06, 3595 실측 근거) — 이전엔
    `if channel != "threads": return`로 잘려 있어(#3517 원 구현이 threads만 구현하던
    시절 그대로 방치) IG/FB 댓글 수집 CONNECTION 실패는 에러코드까지 정확히
    분류되고도 /organization/channels 칩·재연결 버튼에 안 섰다 — insight_snapshots.py
    쪽은 애초에 이 가드가 없었다(그쪽이 맞았다).

    story #3603(Phase2·BE·소형·결함, 페드루 PO 確定 2026-09-07, 유나 3597 관찰) —
    `status`만 바꾸고 「왜」는 안 남겨 /organization/channels의 「서버 응답 보기」가
    비거나 옛 오류를 보였다. `last_error_code`·`last_error_at`은 status의 sticky
    여부와 무관하게 항상 갱신한다("지금도 실패 中"이라는 사실 자체가 갱신할
    가치가 있다, `channel_connection.apply_connection_failure`와 같은 규율).
    `last_error`(원문)는 message가 주어질 때만 채운다(호출자가 안 줄 수도 있다 —
    둘 다 optional).

    story #3605(실측 정정) — error_code 무관하게 항상 "expired"로 굳혔던 것을
    바로잡는다(publication_command.py::apply_command_failure와 같은 결함 클래스,
    같은 스토리에서 같이 고침). `graph_api_errors.sticky_connection_status`(공유
    단일 지점, CHANGES-2)가 정확한 status를 고른다 — #3603의 `not in ("revoked",
    "error")` 가드를 이 함수가 대체한다(expired도 이제 동등하게 sticky)."""
    from datetime import datetime, timezone

    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.services.graph_api_errors import mark_connection_failed

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == publication_id)
    )).scalar_one_or_none()
    if pub is None:
        return
    connection = await db.get(ChannelConnection, pub.connection_id)
    if connection is None:
        return
    # story #3646 — insight_snapshots.py::_promote_connection_status_for_snapshot·
    # publication_command.py::apply_command_failure(CONNECTION 분기)와 이제 이
    # 4줄을 한 헬퍼로 공유한다(중복 3벌 → 1).
    mark_connection_failed(connection, error_code=error_code, message=message, now=datetime.now(timezone.utc))


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
        # story #3597(잔여, PO 라이브 회차 2026-09-07 02:27~02:33Z 실측·PO 確定) —
        # 스케줄 루프(process_due_comment_collections)는 CONNECTION 실패 시
        # `_promote_connection_status`를 부르는데 이 수동 경로는 그 호출이 아예
        # 없었다(AC1 「수집이 connection 실패로 끝나면 칩이 선다」가 「다시 수집」
        # 버튼에서 안 섬 — 라이브 실측: FB 샌드박스 502 CHANNEL_TOKEN_EXPIRED 뒤에도
        # connection.status가 active 그대로). 루프와 같은 순서(승격 먼저, 그 다음
        # schedule_row 상태 기록)로 맞춘다. `_schedule_next_continuous_poll_if_active`
        # 는 여기서 안 부른다 — 그건 «다음 자동 폴링 예약» 개념인데 이 경로는 사람이
        # 그 자리에서 손으로 누른 1회성 재수집이라 다음 폴링 스케줄과 무관하다(루프
        # 전용 개념을 수동 경로에 섞지 않는다).
        # story #3605(rebase 반영) — `_promote_connection_status`에 `error_code`가
        # 추가돼(어떤 status로 승격할지 error_code로 정확히 고르기 위해) 호출부도
        # 그 값을 넘긴다.
        from app.services.publication_command import classify_failure_kind, FAILURE_KIND_CONNECTION

        # story #3612(라이브 결함, 배포 47) — CHANNEL_CONNECTION_NOT_ACTIVE는 선검사
        # (이미 비활성/연결 없음/무자격)일 뿐 새 증거가 아니다 — 승격·기록 대상이
        # 아니다(AC3, 스케줄 루프 쪽 AC1과 동형). 사람에게는 그대로 409로 알린다
        # (schedule_row.status="failed"·raise는 불변) — «기록 안 함»과 «알림 안 함»은
        # 다르다, 이 버튼을 누른 그 사람에게는 지금 실패했다는 사실 자체가 유효한 응답.
        if classify_failure_kind(exc.error_code) == FAILURE_KIND_CONNECTION and exc.error_code not in _COMMENT_PRECHECK_CODES:
            # story #3603(잔여, 페드루 PO 追加 2026-09-07) — error_code/message를 안 실으면
            # 이 수동 경로만 last_error 3종이 안 채워져(3597과 같은 클래스 재발) 「서버
            # 응답 보기」가 여기서 시작된 만료엔 비거나 옛 오류를 보인다.
            await _promote_connection_status(db, publication_id=publication_id, error_code=exc.error_code, message=str(exc))
        schedule_row.status = "failed"
        schedule_row.error_code = exc.error_code
        await db.commit()
        raise

    schedule_row.status = "captured"
    schedule_row.captured_at = result["captured_at"]
    # story #3618 — §7 Phase2 「댓글 누락률」 분모(채널이 말하는 전체 개수).
    schedule_row.channel_reported_comment_count = result["channel_reported_comment_count"]
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
    `.get(comment_id)` → None="무응답").

    story #3596(유나 Design CHANGES①, 페드루 PO 정정 2026-09-07) — 한때 이 필드를
    sent/failed로 좁히는 처방을 냈다가 소비처 grep 없이 낸 결정임이 드러나
    되돌렸다: 이 필드(reply)는 칩 4상태·답변 미리보기(latestReplyText)·실패
    줄(replyFailureAction)·「다시 상신」(replyId)까지 겹쳐 쓴다 — draft/pending을
    빼면 그 전부가 통째로 꺼진다(실측: 미응답 회귀 4건). 배지 «최신 상태» 주어
    불일치(보낸 답변 있는데 배지가 초안을 말하는 자리)는 그때 별도 additive
    필드(`latest_sent_reply_status`)로 해소했으나, story #3592(유나 §22-16 ②
    「제3의 답」, PO 決 2026-09-07 01:24Z)가 그 처방 자체를 폐기했다 — 배지
    status 주어는 count 임계와 무관하게 이 필드(`reply.status`) 하나로
    되돌아간다(그 additive 필드·소비 전부 제거됨)."""
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


# story #3805(Phase3·3-1, 페드루 PO 確定 2026-09-11·낱말 정정 08:14Z) — 「반응」
# (Engagement) 화면(채널 포스트 화면의 뷰 하나, 새 사이드바 항목 0)의 org 단위 큐.
# 그라운딩 ①~⑤ 그대로: 새 테이블 0·새 커서 포맷 0(3502 encode_metric_cursor 재사용)·
# 새 판정 로직 0(get_last_collected_at_by_publication_ids와 같은 집계식 재사용).
# 08:14Z 정정 — 원래 `inbox/*`로 이름 붙였던 걸 `engagement/*`로 갈음(`/inbox`는
# 알림이 이미 점유) + 상태 enum 4번째 값 `ignored`→`skipped`(ko 「넘김」·en Skipped,
# 유나 대안 채택).

_TRIAGE_STATUSES = ("open", "in_progress", "done", "skipped")


class EngagementItemNotFoundError(Exception):
    """CI 정정(2026-09-11, 카디르 실측·페드루 전달) — BE 한글 사용자 문장 가드(story
    #3779) 신규 위반. 서비스 레이어는 `resolved_locale`를 모른다(Header() DI는 라우트
    경계에서만, i18n_catalog.py 모듈 docstring 원칙) — 실제 사용자 노출 문구는
    라우터가 `t("engagement_items.not_found", resolved_locale)`로 새로 짓는다(dependencies.
    not_found와 동형: id를 문구에 안 싣는다). 이 메시지는 개발자 진단용 영문 고정."""

    def __init__(self, comment_id: uuid.UUID):
        self.comment_id = comment_id
        super().__init__(f"engagement item not found: {comment_id}")


class EngagementItemInvalidStatusError(Exception):
    """위와 동형 — 사용자 노출 문구는 라우터가 `t("engagement_items.invalid_status",
    resolved_locale)`로 새로 짓는다. 이 메시지는 개발자 진단용 영문 고정."""

    def __init__(self, *, status: str):
        self.status = status
        super().__init__(f"invalid triage_status: {status}")


async def list_engagement_items(
    db: AsyncSession, *, org_id: uuid.UUID, status: str | None = None, channel: str | None = None,
    kind: str | None = None, cursor: str | None = None, limit: int = 50,
) -> dict[str, Any]:
    """그라운딩 ①③④ — org 단위 큐. 정렬=open 우선(0)→그 외(1)→captured_at desc→id
    desc(마이그마다 정렬이 안 깨지게 3키 전부 cursor에 싣는다 — 3713류 「경계 넘는
    이름이 다르면 조용히 버려진다」 재발 방지). priority 자체가 진짜 정렬키라
    encode_metric_cursor(3502 metric 정렬 선례)를 그대로 재사용 — 3번째 커서 포맷
    발명 금지. 소프트 삭제된 댓글은 큐에서 제외(deleted_at IS NOT NULL).

    story #3805 PR 4 — `kind`(comment|reply)는 저장 컬럼이 아니라 `parent_comment_id`
    의 有無로 판정한다(라우터의 `_item_response`와 동일 규칙, 새 진실원천 안 만듦).
    """
    priority_expr = case((ChannelPostComment.triage_status == "open", 0), else_=1)

    conditions = [ChannelPostComment.org_id == org_id, ChannelPostComment.deleted_at.is_(None)]
    if status is not None:
        conditions.append(ChannelPostComment.triage_status == status)
    if channel is not None:
        conditions.append(ChannelPostComment.channel == channel)
    if kind == "comment":
        conditions.append(ChannelPostComment.parent_comment_id.is_(None))
    elif kind == "reply":
        conditions.append(ChannelPostComment.parent_comment_id.isnot(None))

    if cursor is not None:
        cur_priority, cur_captured_at, cur_id = decode_metric_cursor(cursor)
        conditions.append(or_(
            priority_expr > cur_priority,
            and_(priority_expr == cur_priority, ChannelPostComment.captured_at < cur_captured_at),
            and_(
                priority_expr == cur_priority, ChannelPostComment.captured_at == cur_captured_at,
                ChannelPostComment.id < cur_id,
            ),
        ))

    rows = (await db.execute(
        select(ChannelPostComment)
        .where(*conditions)
        .order_by(priority_expr.asc(), ChannelPostComment.captured_at.desc(), ChannelPostComment.id.desc())
        .limit(limit + 1)
    )).scalars().all()

    has_more = len(rows) > limit
    page = list(rows[:limit])
    next_cursor = None
    if has_more and page:
        last = page[-1]
        last_priority = 0 if last.triage_status == "open" else 1
        next_cursor = encode_metric_cursor(last_priority, last.captured_at, last.id)
    return {"items": page, "has_more": has_more, "next_cursor": next_cursor}


async def patch_engagement_item(
    db: AsyncSession, *, org_id: uuid.UUID, comment_id: uuid.UUID,
    triage_status: str | None = None,
    assignee_member_id: uuid.UUID | None = None, assignee_member_id_set: bool = False,
) -> ChannelPostComment:
    """PATCH — model_fields_set 관례(3437 §후속 동형): 생략=유지, 명시 null=해제.
    `assignee_member_id_set`이 라우터가 넘기는 "이 필드가 요청 본문에 있었나" 플래그
    (Pydantic exclude_unset)다. triage_status는 4상태 허용목록으로 fail-closed 검증
    (오타 값이 조용히 저장되지 않는다)."""
    comment = (await db.execute(
        select(ChannelPostComment).where(
            ChannelPostComment.id == comment_id, ChannelPostComment.org_id == org_id,
        )
    )).scalar_one_or_none()
    if comment is None:
        raise EngagementItemNotFoundError(comment_id)

    if triage_status is not None:
        if triage_status not in _TRIAGE_STATUSES:
            raise EngagementItemInvalidStatusError(status=triage_status)
        comment.triage_status = triage_status
    if assignee_member_id_set:
        comment.assignee_member_id = assignee_member_id

    await db.commit()
    await db.refresh(comment)
    return comment


async def get_engagement_collection_status(db: AsyncSession, *, org_id: uuid.UUID) -> list[dict[str, Any]]:
    """그라운딩 ⑤ — 연결별 «마지막 수집 시각 / 수집 안 됨». `CommentCollectionSchedule.
    captured_at`(status="captured" MAX) 집계식은 `get_last_collected_at_by_publication_
    ids`와 정의가 같다(두 번째 구현 0) — 여기선 발행물이 아니라 연결 단위로 묶는다.
    null=이 연결로 수집이 한 번도 성공한 적 없음(0건과 다름, null≠0 규약)."""
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication

    connections = (await db.execute(
        select(
            ChannelConnection.id, ChannelConnection.channel, ChannelConnection.account_label,
            ChannelConnection.reply_detection_unavailable_at,
        )
        .where(ChannelConnection.org_id == org_id)
    )).all()
    if not connections:
        return []

    connection_ids = [c.id for c in connections]
    rows = (await db.execute(
        select(ChannelPublication.connection_id, func.max(CommentCollectionSchedule.captured_at))
        .join(CommentCollectionSchedule, CommentCollectionSchedule.publication_id == ChannelPublication.id)
        .where(
            ChannelPublication.connection_id.in_(connection_ids),
            CommentCollectionSchedule.status == "captured",
        )
        .group_by(ChannelPublication.connection_id)
    )).all()
    last_by_connection = {cid: captured_at for cid, captured_at in rows}
    return [
        {
            "connection_id": c.id, "channel": c.channel, "account_label": c.account_label,
            "last_collected_at": last_by_connection.get(c.id),
            # story #3805 PR 4 후속 — 「조용히 0」 처방.
            "reply_detection_unavailable": c.reply_detection_unavailable_at is not None,
        }
        for c in connections
    ]


async def get_latest_sent_reply_at_by_comment_ids(
    db: AsyncSession, *, comment_ids: list[uuid.UUID],
) -> dict[uuid.UUID, datetime]:
    """PR 3(답변함 마커, 페드루 PO 定 2026-09-11 10:36Z) — 정정 배경: 「답글 편입」을
    처음엔 `channel_post_comment_replies`를 큐에 UNION으로 합류시켜 구현했으나,
    이 테이블은 author 개념이 `created_by_member_id`+`created_by_kind`('human'|
    'agent') 하나뿐 — 고객이 남긴 값을 담을 자리가 스키마에 없어 **모든 행이
    100% outbound**(우리가 쓴 답변)다. "받은 반응" 큐(inbound)에 outbound를
    섞은 설계 오류였다(PO 실측 지적) — 되돌리고, 대신 이 함수로 댓글 행 옆에
    읽기전용 「답변함 · 시각」만 보인다(트리아지 상태는 안 건드림 — 사람이 직접
    done으로 옮긴다).

    status="sent"만 잡는다(초안/대기/실패는 「아직 안 보냄」 — 답변함 아님).
    "시각"은 이 레포에 「발송 성공 시각」 전용 컬럼이 없어(status 전환 시점을
    별도로 안 남김) `updated_at`(상신 성공 시 sent로 바뀌며 갱신됨)을 근사값으로
    쓴다 — 정확한 external 타임스탬프가 필요해지면 그때 전용 컬럼을 늘린다(이
    스토리 범위 밖, 지금은 지어내지 않는 선에서 가장 가까운 값). comment_id 없으면
    dict에서 빠짐(호출부가 `.get(comment_id)` → None="답변함 아님")."""
    if not comment_ids:
        return {}
    rows = (await db.execute(
        select(ChannelPostCommentReply.comment_id, func.max(ChannelPostCommentReply.updated_at))
        .where(
            ChannelPostCommentReply.comment_id.in_(comment_ids),
            ChannelPostCommentReply.status == "sent",
        )
        .group_by(ChannelPostCommentReply.comment_id)
    )).all()
    return {comment_id: updated_at for comment_id, updated_at in rows}
