"""story #3497(Phase2·마케팅운영, 페드루 決定 2026-09-05) — 인사이트 수집 잡. 블루프린트
v3 §2(d)·§3 「발행 후 1일·7일 스냅샷이 동일 게시물 evidence에 누적된다」·「토큰·한도
실패는 연결 상태로 승격한다」·「0과 미제공을 구분한다」의 실행 단위.

워커 tick 진입점은 `process_due_insight_snapshots()` 하나(그라운딩 §4 — 기존
`process_due_publication_commands`와 동형 SKIP LOCKED 2단계 커밋, 새 Cloud Scheduler
잡 0). 발행 성공 콜백은 `schedule_insight_snapshots()` 하나 — 도메인 4곳(threads/
wordpress/webhook 외부 발행 2곳, hosted_site 발행 2곳)이 전부 이 함수 하나를 부른다."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.insight_snapshot import InsightSnapshot

logger = logging.getLogger(__name__)

BATCH_SIZE = 50
_SNAPSHOT_OFFSETS = (timedelta(days=1), timedelta(days=7))
# 블루프린트 v3 §2(d) 7키 — 이 순서·이 이름 그대로가 정규화 계약의 SSOT.
NORMALIZED_KEYS = ("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions")

# story #3414 classify_failure_kind()와 같은 error_code 문자열을 재사용한다(새 상태값
# 0, 페드루 決定⑤) — CHANNEL_TOKEN_EXPIRED/CHANNEL_PUBLISH_AUTH_REJECTED=connection
# 승격, CHANNEL_RATE_LIMITED=transient 재시도. 아래 InsightFetchError가 이 문자열
# 그대로를 error_code에 싣는다.


class InsightFetchError(Exception):
    """어댑터의 fetch_insights 계열 함수가 실패를 알리는 유일한 통로. error_code는
    `publication_command.py::classify_failure_kind`가 아는 문자열 그대로 재사용한다
    (새 매핑표를 따로 안 만든다)."""

    def __init__(self, *, error_code: str, message: str):
        self.error_code = error_code
        super().__init__(message)


async def schedule_insight_snapshots(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    publication_id: uuid.UUID,
    publication_kind: str,
    channel: str,
    external_id: str | None,
    anchor_at: datetime,
) -> None:
    """발행 성공 직후(같은 트랜잭션 안, commit은 호출자 몫) +1d·+7d 두 행을 연다.
    `anchor_at`은 호출자가 이미 확정한 발행 시각(예: `row.published_at`)을 그대로
    넘긴다 — `datetime.now()`를 여기서 새로 재면, 같은 발행이 재처리(워커 재시도 등)
    될 때마다 due_at이 미세하게 달라져 UNIQUE(publication_id, due_at) 멱등이 무력화
    된다(페드루 決定①의 "같은 발행 재처리에도 2행 유지"가 실제로 성립하려면 이
    앵커가 안정적이어야 한다)."""
    for offset in _SNAPSHOT_OFFSETS:
        stmt = pg_insert(InsightSnapshot).values(
            id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id,
            publication_id=publication_id, publication_kind=publication_kind,
            channel=channel, external_id=external_id, due_at=anchor_at + offset,
            status="pending",
        ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at")
        await db.execute(stmt)


def _normalize(*, declared_metrics: tuple[str, ...], values: dict[str, int]) -> dict[str, int | None]:
    """0과 미제공을 가르는 유일한 자리(페드루 決定, 이 스토리의 척추) — null은 두
    경우 모두: ①채널이 이 지표를 아예 선언 안 함(`declared_metrics`에 없음, 예:
    hosted_site의 impressions) ②선언은 했지만 **이번 fetch가 값을 못 줌**(`values`에
    그 키가 없음 — 예: hosted_site가 beacon 미도입이라 views조차 못 잰 경우, 어댑터가
    빈 dict를 돌려준다). "선언했으니 없으면 0"으로 채우면 ②를 0으로 지어내 버린다
    (실제로 잰 적 없는 지표를 "쟀는데 0"이라고 거짓 기록하는 것) — 값은 `values`에
    그 키가 **실제로 있을 때만** 싣는다. `declared_metrics`는 안전망(어댑터가 실수로
    선언 밖 키를 돌려줘도 여기서 걸러진다)."""
    return {
        key: (int(values[key]) if key in values and key in declared_metrics else None)
        for key in NORMALIZED_KEYS
    }


def _fetch_sandbox(*, publication_id: uuid.UUID) -> dict[str, Any]:
    """story 5b27b32f와 동일 취지 — 실 provider 없이 정규화·evidence 파이프라인
    전체를 라이브로 실측하기 위한 결정적 합성값(publication_id 기반, 매 호출 동일
    값 — 진짜 API처럼 "그때그때 값이 바뀌는" 것을 흉내 내지 않는다, 재현성 우선)."""
    seed = int(publication_id.hex[:8], 16)
    raw = {
        "impressions": seed % 1000, "reach": seed % 700, "views": seed % 500,
        "engagements": seed % 100, "clicks": seed % 50, "spend": 0, "conversions": seed % 5,
    }
    return {"raw": raw, "values": raw}


async def _fetch_hosted_site(db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID) -> dict[str, Any]:
    """story #3497 그라운딩②(페드루 決定 반영) — beacon 집계(`org_pageview_daily`)
    기반 views. path는 `site_posts.py::_blog_post_path(lang, slug)`(공용 헬퍼, 이
    스토리가 세 번째 자리가 될 뻔한 리터럴을 뽑아 재사용)로 구성 — 고객 사이트가
    이 라우트를 실제로 구현했다는 전제 위에 서 있다(강제 보장 없음, 어댑터 선언
    주석·AC에 명시). "미제공"=`org_metering_keys`에 살아있는(revoked_at NULL) 키가
    아예 없음(beacon 자체를 도입 안 함) · "0"=키는 있고 집계 행이 0 또는 부재."""
    from app.models.org_metering_key import OrgMeteringKey
    from app.models.org_pageview_daily import OrgPageviewDaily
    from app.models.site_post import SitePost
    from app.services.site_posts import _blog_post_path

    post = (await db.execute(select(SitePost).where(SitePost.id == publication_id))).scalar_one_or_none()
    if post is None:
        raise InsightFetchError(error_code="SITE_POST_DRAFT_NOT_FOUND", message=f"site_post를 찾을 수 없습니다: {publication_id}")

    has_beacon = (await db.execute(
        select(OrgMeteringKey.id).where(OrgMeteringKey.org_id == org_id, OrgMeteringKey.revoked_at.is_(None)).limit(1)
    )).scalar_one_or_none()
    if has_beacon is None:
        # beacon 자체가 없다 — "0"이 아니라 "미제공"(views=null). _normalize가 이 값을
        # 그대로 실으면 null이 되도록 values에서 아예 뺀다.
        return {"raw": {"path": None, "beacon_provisioned": False}, "values": {}}

    path = _blog_post_path(lang=post.lang, slug=post.slug)
    total = (await db.execute(
        select(OrgPageviewDaily.count).where(OrgPageviewDaily.org_id == org_id, OrgPageviewDaily.path == path)
    )).scalars().all()
    views = sum(total)  # beacon은 있는데 이 path에 아직 집계가 없으면 sum([])==0(정확히 "0").
    return {"raw": {"path": path, "beacon_provisioned": True, "daily_rows": len(total)}, "values": {"views": views}}


_THREADS_INSIGHTS_URL_TMPL = "https://graph.threads.net/v1.0/{media_id}/insights"
# Meta 공식 문서 실측(developers.facebook.com/docs/threads/insights, 조회일
# 2026-09-05) — 유기 게시물(organic post) 인사이트 지표 이름 그대로.
_THREADS_INSIGHTS_METRICS = "views,likes,replies,reposts,quotes,shares"
_THREADS_ENGAGEMENT_METRICS = ("likes", "replies", "reposts", "quotes", "shares")


async def _fetch_threads(client: "httpx.AsyncClient", *, access_token: str, media_id: str) -> dict[str, Any]:  # noqa: F821
    """토큰 착지 뒤 실호출(페드루 決定③) — 지금은 함수 자체가 완성돼 있고 테스트는
    httpx.MockTransport로 200/401/429/5xx를 흉내 낸다(mock까지, 실 토큰 없이도 이
    함수의 정규화·에러분류 로직 전부를 검증 가능). views→views 그대로, likes+
    replies+reposts+quotes+shares 합산→engagements(§2(d) 7키엔 개별 반응 종류가
    없어 뭉친다). threads_publish.py의 기존 에러 분류(_classify_threads_error)와
    같은 error_code 문자열(CHANNEL_TOKEN_EXPIRED·CHANNEL_RATE_LIMITED 등)을
    재사용해 classify_failure_kind()가 그대로 먹힌다(새 매핑표 0)."""
    import httpx

    resp = await client.get(
        _THREADS_INSIGHTS_URL_TMPL.format(media_id=media_id),
        params={"metric": _THREADS_INSIGHTS_METRICS, "access_token": access_token},
    )
    if resp.status_code == 401:
        raise InsightFetchError(error_code="CHANNEL_TOKEN_EXPIRED", message="Threads 액세스 토큰이 만료되었습니다")
    if resp.status_code == 429:
        raise InsightFetchError(error_code="CHANNEL_RATE_LIMITED", message="Threads 인사이트 API 한도 초과")
    if resp.status_code >= 500:
        raise InsightFetchError(error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", message=f"Threads 서버 오류: {resp.status_code}")
    if resp.status_code >= 400:
        raise InsightFetchError(error_code="CHANNEL_PUBLISH_AUTH_REJECTED", message=f"Threads 인사이트 요청 거부: {resp.status_code}")

    body = resp.json()
    values: dict[str, int] = {}
    for item in body.get("data", []):
        name = item.get("name")
        total = 0
        for v in item.get("values", []) or []:
            total += int(v.get("value", 0) or 0)
        if name == "views":
            values["views"] = values.get("views", 0) + total
        elif name in _THREADS_ENGAGEMENT_METRICS:
            values["engagements"] = values.get("engagements", 0) + total
    return {"raw": body, "values": values}


async def _fetch_for_snapshot(db: AsyncSession, snapshot: InsightSnapshot) -> dict[str, Any]:
    """channel별 dispatch. 호출 前 `insight_metrics`가 빈 튜플이 아님을 이미 확인했다는
    전제(호출자 `process_due_insight_snapshots`가 그 판정을 한다 — 여기선 순수 dispatch
    만, "이 채널을 아는지 모르는지" 판단을 두 곳에 중복 안 둔다)."""
    if snapshot.channel == "sandbox":
        return _fetch_sandbox(publication_id=snapshot.publication_id)
    if snapshot.channel == "hosted_site":
        return await _fetch_hosted_site(db, org_id=snapshot.org_id, publication_id=snapshot.publication_id)
    if snapshot.channel == "threads":
        return await _fetch_threads_via_connection(db, snapshot)
    raise InsightFetchError(
        error_code="INSIGHT_CHANNEL_NOT_IMPLEMENTED",
        message=f"insight_metrics는 선언됐지만 fetch dispatch가 없습니다: {snapshot.channel}",
    )


async def _fetch_threads_via_connection(db: AsyncSession, snapshot: InsightSnapshot) -> dict[str, Any]:
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_connection import decrypt_for_use

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == snapshot.publication_id)
    )).scalar_one_or_none()
    if pub is None or pub.external_id is None:
        raise InsightFetchError(
            error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message=f"channel_publication을 찾을 수 없습니다: {snapshot.publication_id}",
        )
    connection = await db.get(ChannelConnection, pub.connection_id)
    if connection is None or connection.status != "active":
        raise InsightFetchError(
            error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message=f"연결이 활성 상태가 아닙니다: {pub.connection_id}",
        )
    access_token = decrypt_for_use(connection)
    if access_token is None:
        raise InsightFetchError(error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message="연결에 자격이 없습니다")

    import httpx

    async with httpx.AsyncClient() as client:
        return await _fetch_threads(client, access_token=access_token, media_id=pub.external_id)


async def process_due_insight_snapshots(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """story #3497 그라운딩④ — `process_due_publication_commands`와 동형 SKIP LOCKED
    2단계 커밋(클레임 commit → 개별 처리 commit/rollback 격리). due_at이 도래한
    status='pending' 스냅샷을 배치로 집어 처리한다."""
    from app.services.channel_adapters import CHANNEL_ADAPTERS
    from app.services.publication_command import classify_failure_kind, FAILURE_KIND_CONNECTION, FAILURE_KIND_TRANSIENT

    now = now or datetime.now(timezone.utc)
    rows = (await db.execute(
        select(InsightSnapshot).where(
            InsightSnapshot.status == "pending", InsightSnapshot.due_at <= now,
        ).order_by(InsightSnapshot.due_at.asc())
        .limit(BATCH_SIZE)
        .with_for_update(skip_locked=True)
    )).scalars().all()

    for snapshot in rows:
        snapshot.status = "in_progress"
    await db.commit()

    counts = {"captured": 0, "unsupported": 0, "failed": 0, "pending_retry": 0, "error": 0}
    for snapshot in rows:
        try:
            adapter = CHANNEL_ADAPTERS.get(snapshot.channel)
            declared = adapter.insight_metrics if adapter is not None else ()
            if not declared:
                snapshot.status = "unsupported"
                snapshot.captured_at = now
                await db.commit()
                counts["unsupported"] += 1
                continue

            try:
                result = await _fetch_for_snapshot(db, snapshot)
            except InsightFetchError as exc:
                failure_kind = classify_failure_kind(exc.error_code)
                if failure_kind == FAILURE_KIND_CONNECTION:
                    await _promote_connection_status_for_snapshot(db, snapshot)
                    snapshot.status = "failed"
                    snapshot.error_code = exc.error_code
                    await db.commit()
                    counts["failed"] += 1
                elif failure_kind == FAILURE_KIND_TRANSIENT:
                    snapshot.attempt_count += 1
                    snapshot.error_code = exc.error_code
                    if snapshot.attempt_count >= 5:
                        snapshot.status = "failed"
                        await db.commit()
                        counts["failed"] += 1
                    else:
                        snapshot.status = "pending"
                        await db.commit()
                        counts["pending_retry"] += 1
                else:
                    snapshot.status = "failed"
                    snapshot.error_code = exc.error_code
                    await db.commit()
                    counts["failed"] += 1
                continue

            snapshot.raw_payload = result["raw"]
            snapshot.normalized = _normalize(declared_metrics=declared, values=result["values"])
            snapshot.status = "captured"
            snapshot.captured_at = now
            snapshot.source = snapshot.channel
            await _record_insight_evidence(db, snapshot)
            await db.commit()
            counts["captured"] += 1
        except Exception:  # noqa: BLE001 — publication_command.py와 동형 2중 방어.
            await db.rollback()
            counts["error"] += 1
            logger.exception("insight snapshot 처리 실패 snapshot_id=%s", snapshot.id)
    return counts


async def _promote_connection_status_for_snapshot(db: AsyncSession, snapshot: InsightSnapshot) -> None:
    """publication_command.py:454-461과 동형 inline 승격(그라운딩⑤, 새 상태값 0) —
    hosted_site/sandbox는 connection 자체가 없어 no-op(그 두 채널은 애초에
    FAILURE_KIND_CONNECTION을 못 낸다 — CHANNEL_TOKEN_EXPIRED류를 던지는 곳이
    threads 경로뿐)."""
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication

    if snapshot.publication_kind != "channel_publication":
        return
    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == snapshot.publication_id)
    )).scalar_one_or_none()
    if pub is None:
        return
    connection = await db.get(ChannelConnection, pub.connection_id)
    if connection is not None and connection.status not in ("revoked", "error"):
        connection.status = "expired"


async def _record_insight_evidence(db: AsyncSession, snapshot: InsightSnapshot) -> None:
    """story #3497 그라운딩①(페드루 決定 반영) — evidence.payload(JSONB)에 구조화
    데이터를, note에는 사람용 한 줄만. Evidence(...) 직접 construct(evidence_service.py
    ::create_gate_approval_evidence_if_applicable 선례와 동형 — 서비스 함수를 안 거치는
    시스템 생성 관례, 그 함수는 라우터 전용 세션 커밋 포함이라 내부 호출용이 아니다).

    created_by=None(페드루 決定, 2026-09-05 열린 질문 판정) — activity_log의
    actor_type=platform·actor_id=None과 동류인 순수 시스템 기록이라 실 행위자가
    없다. NIL UUID 같은 센티널로 "없는 행위자를 지어내지" 않는다(evidence.created_
    by가 이 스토리에서 nullable로 바뀐 이유, migration 0332). payload.recorded_by
    가 그 표식(apps/web이 non-null 가정으로 렌더하면 이 값으로 "플랫폼" 라벨을 건다)."""
    from app.models.evidence import Evidence

    n = snapshot.normalized or {}
    parts = [f"{k}={v}" for k, v in n.items() if v is not None]
    note = f"{', '.join(parts)} · captured {snapshot.captured_at.strftime('%m-%d %H:%MZ')}" if snapshot.captured_at else ", ".join(parts)

    db.add(Evidence(
        id=uuid.uuid4(), org_id=snapshot.org_id, work_item_id=snapshot.work_item_id,
        work_item_type="story", type="metric", ref=str(snapshot.id), source=snapshot.channel,
        note=note, created_by=None,
        payload={
            **n, "captured_at": snapshot.captured_at.isoformat() if snapshot.captured_at else None,
            "source": snapshot.channel, "snapshot_id": str(snapshot.id), "recorded_by": "platform",
        },
    ))
