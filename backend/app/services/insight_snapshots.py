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

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_post_image import ChannelPostImage
from app.models.channel_post_version import ChannelPostVersion
from app.models.channel_post_video import ChannelPostVideo
from app.models.channel_publication import ChannelPublication
from app.models.insight_snapshot import InsightSnapshot
from app.services.facebook_publish import _GRAPH_BASE as _FACEBOOK_GRAPH_BASE
from app.services.instagram_publish import _GRAPH_BASE as _INSTAGRAM_GRAPH_BASE

logger = logging.getLogger(__name__)

BATCH_SIZE = 50
_SNAPSHOT_OFFSETS = (timedelta(days=1), timedelta(days=7))
# 블루프린트 v3 §2(d) 7키 + story #3583-BE(GA4 유입 3키, 그라운딩③ PO 確定) — 이
# 순서·이 이름 그대로가 정규화 계약의 SSOT. inflow_* 3키는 채널 어댑터의
# insight_metrics 선언 축과 별개다(org GA4 연결 여부로 판정 — `_maybe_enrich_
# with_ga4_inflow` 참고, declared_metrics 게이트를 안 탄다).
NORMALIZED_KEYS = (
    "impressions", "reach", "views", "engagements", "clicks", "spend", "conversions",
    "inflow_sessions", "inflow_users", "inflow_conversions",
)

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
    앵커가 안정적이어야 한다).

    story #3660(BE·insights·상태 자가회수, 페드루 PO 確定 2026-09-07, 카디르 발견
    PR#4003) — 같은 publication_id를 유지한 채 anchor_at만 바뀌는 재발행(hosted_site
    update·ChannelPublication 같은 (gate_id, version_id) 재처리 둘 다 해당, AC4)에서
    옛 사이클의 pending/in_progress 행이 그대로 살아남아 수집기가 계속 due로 집었다.
    새 2행을 연 뒤 같은 트랜잭션에서 이 publication의 **다른** due_at(=이번 anchor가
    아닌 사이클)에 걸린 pending/in_progress 행을 superseded로 회수한다 — captured/
    failed/unsupported는 이력이라 손대지 않는다(#3651 MCP superseded_snapshots가 그
    구분을 이미 전제한다). 같은 anchor 재처리(due_at이 이번 anchor와 일치)는 이
    UPDATE의 WHERE에 안 걸려 무변(2행 그대로 — 페드루 決定① 회귀 보존)."""
    new_due_ats = [anchor_at + offset for offset in _SNAPSHOT_OFFSETS]
    for due_at in new_due_ats:
        stmt = pg_insert(InsightSnapshot).values(
            id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id,
            publication_id=publication_id, publication_kind=publication_kind,
            channel=channel, external_id=external_id, due_at=due_at,
            status="pending",
        ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at")
        await db.execute(stmt)

    await db.execute(
        update(InsightSnapshot)
        .where(
            InsightSnapshot.org_id == org_id,
            InsightSnapshot.publication_id == publication_id,
            InsightSnapshot.due_at.notin_(new_due_ats),
            InsightSnapshot.status.in_(("pending", "in_progress")),
        )
        .values(status="superseded")
    )


async def list_insight_snapshots_for_publication(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID,
) -> list[InsightSnapshot]:
    """story #3497 조각3(조회 API) — 스냅샷 목록(due_at 오름차순, +1d 먼저). org
    격리는 호출자(라우터)가 이미 검증한 뒤 이 함수를 부른다는 전제(다른 서비스
    함수들과 동형 — org_id는 여기서도 WHERE에 걸어 이중 방어)."""
    rows = (await db.execute(
        select(InsightSnapshot)
        .where(InsightSnapshot.org_id == org_id, InsightSnapshot.publication_id == publication_id)
        .order_by(InsightSnapshot.due_at.asc())
    )).scalars().all()
    return list(rows)


async def resolve_publication_org_id(db: AsyncSession, *, publication_id: uuid.UUID) -> uuid.UUID | None:
    """story #3796(페드루 PO 確定 2026-09-10, 유나 실측) — 폴리모픽 publication_id의
    실 소유 org. 라우터가 스냅샷 0건일 때만 부른다(존재+타 org인지 vs 애초에 미존재인지
    구분하기 위함 — 전자만 404, 후자는 기존 "빈 목록" 계약 그대로 유지). resolve_
    publication_published_at과 같은 두 테이블(ChannelPublication·SitePost)을 보되,
    이쪽은 kind를 모르는 채로 호출되므로(스냅샷 행 자체가 없어 kind를 읽을 자리가
    없다) 순서대로 둘 다 시도 — 어느 쪽도 없으면 None(지어내지 않는다)."""
    from app.models.channel_publication import ChannelPublication
    from app.models.site_post import SitePost

    org_id = (await db.execute(
        select(ChannelPublication.org_id).where(ChannelPublication.id == publication_id)
    )).scalar_one_or_none()
    if org_id is not None:
        return org_id
    return (await db.execute(
        select(SitePost.org_id).where(SitePost.id == publication_id)
    )).scalar_one_or_none()


async def resolve_publication_published_at(
    db: AsyncSession, *, publication_kind: str, publication_id: uuid.UUID,
) -> datetime | None:
    """publication_kind별 «지금」 published_at 해석 — insights_board.py의 rows_cte가
    kind별로 이미 푸는 자리와 같은 소스(SitePost.published_at·ChannelPublication.
    published_at). 존재하지 않는 publication_id는 None(지어내지 않는다)."""
    from app.models.channel_publication import ChannelPublication
    from app.models.site_post import SitePost

    model = SitePost if publication_kind == "site_post" else ChannelPublication
    return (await db.execute(
        select(model.published_at).where(model.id == publication_id)
    )).scalar_one_or_none()


def label_snapshot_offset(*, due_at: datetime, published_at: datetime) -> str | None:
    """due_at이 «지금» published_at 기준 +1일/+7일 버킷 중 어디인지 — insights_board.py
    관찰 그대로(round()로 부동소수 잡음 완충, `.days`는 0을 향해 버려 경계값이 밀릴
    수 있다). 매치 안 되면 None — 카디르 발견(PR#4003, 2026-09-07): hosted_site 재발행은
    같은 publication_id를 유지한 채 published_at을 갱신하고, `schedule_insight_
    snapshots`가 새 due_at 2행을 더 연다(UNIQUE(publication_id, due_at)는 «새» due_at을
    안 막는다) — 원래 있던 인덱스 기반 라벨링("idx0=1d·나머지=7d")은 이 옛 발행 사이클의
    잔존 스냅샷을 «7d»로 오라벨했다. None은 "옛 사이클 잔존"의 정직한 신호 — 호출자가
    델타 계산에서 빼고 개수만 알린다(3651 MCP 도구의 superseded_snapshots)."""
    offset = round((due_at - published_at).total_seconds() / 86400)
    if offset == 1:
        return "1d"
    if offset == 7:
        return "7d"
    return None


async def get_latest_insight_snapshot(db: AsyncSession, *, publication_id: uuid.UUID) -> InsightSnapshot | None:
    """story #3497 조각3 — get_*_publication 응답에 얹는 `latest_insight` 1건(그라운딩
    確定④). "최신"은 captured_at 내림차순 — 아직 아무것도 안 잡힌 발행은 None(지어
    내지 않는다, "0건" 그 자체가 정직한 값)."""
    return (await db.execute(
        select(InsightSnapshot)
        .where(InsightSnapshot.publication_id == publication_id, InsightSnapshot.captured_at.isnot(None))
        .order_by(InsightSnapshot.captured_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def compute_insight_snapshot_counts(
    db: AsyncSession, *, org_id: uuid.UUID, window_days: int = 7, now: datetime | None = None,
) -> dict[str, int]:
    """story #3497 確定⑤ — 3475 publishing-metrics 접합용 카운트 함수(이 PR에선
    호출부를 안 연다 — 3475가 아직 develop 미착지라 그 스택 착지 뒤 후속 커밋으로
    미룬다, 페드루 決定). 창(window)은 `created_at`(스냅샷이 예약된 시각) 기준 —
    `captured_at`은 status='captured'에만 있어 failed/unsupported를 못 센다."""
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=window_days)
    rows = (await db.execute(
        select(InsightSnapshot.status).where(
            InsightSnapshot.org_id == org_id, InsightSnapshot.created_at >= since,
            InsightSnapshot.status.in_(("captured", "failed", "unsupported")),
        )
    )).scalars().all()
    counts = {"captured": 0, "failed": 0, "unsupported": 0}
    for status in rows:
        counts[status] += 1
    return counts


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
    아예 없음(beacon 자체를 도입 안 함) · "0"=키는 있고 집계 행이 0 또는 부재.

    story #3506(Phase2·마케팅운영, 페드루 PO 確定 (e), 그라운딩 왕복 2026-09-05 —
    (A) path 축 확定) — clicks도 같은 path 축으로 `org_pageview_utm_daily`를 합산한다
    ("이 글로 온 UTM 유입 전체", utm_content 특정값 매칭 아님 — 조각①이 UTM을 «이리로
    향하는 channel_post 링크»에만 붙이므로 utm_content의 값 공간이 channel_post
    draft이지 이 hosted_site 글 자신의 식별자가 아니다, (B)안 기각 사유 그대로).
    views와 동일하게 beacon 미배선이면 null 유지(values에서 뺌) — 배선돼 있으면
    집계 0건도 정확히 "0". utm_* 분해값은 raw에 그대로 실어(세부 breakdown은 후속
    스토리 몫, 지금은 손실 없이 보존만)."""
    from app.models.org_metering_key import OrgMeteringKey
    from app.models.org_pageview_daily import OrgPageviewDaily
    from app.models.org_pageview_utm_daily import OrgPageviewUtmDaily
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

    utm_rows = (await db.execute(
        select(
            OrgPageviewUtmDaily.count, OrgPageviewUtmDaily.utm_source, OrgPageviewUtmDaily.utm_medium,
            OrgPageviewUtmDaily.utm_campaign, OrgPageviewUtmDaily.utm_content,
        ).where(OrgPageviewUtmDaily.org_id == org_id, OrgPageviewUtmDaily.path == path)
    )).all()
    clicks = sum(r.count for r in utm_rows)
    utm_breakdown = [
        {
            "count": r.count, "utm_source": r.utm_source, "utm_medium": r.utm_medium,
            "utm_campaign": r.utm_campaign, "utm_content": r.utm_content,
        }
        for r in utm_rows
    ]
    return {
        "raw": {"path": path, "beacon_provisioned": True, "daily_rows": len(total), "utm_breakdown": utm_breakdown},
        "values": {"views": views, "clicks": clicks},
    }


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
    if resp.status_code >= 400:
        # story #3605 — 401/403 뭉뚱그림을 Graph envelope 파싱으로 먼저 세분화한다
        # (code==190/OAuthException·10·200~299 family). 이 family 밖(None)이면
        # 기존 status_code 휴리스틱(아래)이 그대로 유일한 판정 근거 — 403의
        # CHANNEL_PUBLISH_AUTH_REJECTED류 기존 분류는 안 건드린다(회귀 0).
        from app.services.graph_api_errors import classify_graph_oauth_error, parse_graph_error_envelope

        _code, _subcode, _type = parse_graph_error_envelope(resp)
        oauth_reason = classify_graph_oauth_error(error_code=_code, error_subcode=_subcode, error_type=_type)
        if oauth_reason is not None:
            _status, _ = oauth_reason
            _error_code = {
                "expired": "CHANNEL_TOKEN_EXPIRED", "revoked": "CHANNEL_CONNECTION_REVOKED",
            }.get(_status, "CHANNEL_CONNECTION_AUTH_ERROR")
            raise InsightFetchError(error_code=_error_code, message=f"Threads 인사이트 인증 오류: {resp.text[:500]}")
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


# story #3320 — 페드루 PO REQUIRED(2026-09-06, #3872 PASS 철회, #3874 리뷰
# "자체 상수 X, _GRAPH_BASE 참조") — 새 호스트 상수를 여기 또 만들지 않고
# instagram_publish.py의 것을 그대로 import해 쓴다(호스트를 되돌리는 실수가
# 한 곳만 고치면 되게 — instagram_publish.py::_GRAPH_BASE docstring 참고).
_INSTAGRAM_INSIGHTS_URL_TMPL = _INSTAGRAM_GRAPH_BASE + "/{media_id}/insights"
# story #3320 조각③ — 페드루 PO 決定⑤=(b): likes+comments+saved(+shares, 있으면)를
# threads_publish.py의 engagements 합산과 같은 모양으로 뭉친다(같은 낱말=같은
# 정의). reach는 §2(d) 7키에 그대로 이름이 있어 개별 유지.
#
# 페드루 PO REQUIRED(2026-09-06, #3874 리뷰, Meta 문서 재확認) — **impressions는
# 2024-07-02 이후 생성된 미디어에 폐기**됐다(우리 발행물 전부 이 이후) — 요청
# metric에 넣으면 실계정 첫 호출이 400(#3872의 graph.facebook.com 호스트 오류와
# 같은 클래스: sandbox는 이 파라미터를 실제로 안 쳐서 통과하고 실계정에서만
# 드러남). impressions는 이제 요청도 안 하고 항상 None(선언 안 함, insight_
# snapshots.py의 null≠0 원칙 그대로 — "쟀는데 0"이 아니라 "이 채널이 이 지표를
# 안 준다"). 대신 `views`를 요청해 §2(d) 7키의 `views`에 그대로 싣는다(threads의
# views와 같은 이름, 별도 합산 없음).
_INSTAGRAM_INSIGHTS_METRICS = "views,reach,likes,comments,saved,shares"
_INSTAGRAM_ENGAGEMENT_METRICS = ("likes", "comments", "saved", "shares")


async def _fetch_instagram(client: "httpx.AsyncClient", *, access_token: str, media_id: str) -> dict[str, Any]:  # noqa: F821
    """_fetch_threads와 동형 에러분류(같은 error_code 문자열 재사용, 새 매핑표 0)."""
    import httpx

    resp = await client.get(
        _INSTAGRAM_INSIGHTS_URL_TMPL.format(media_id=media_id),
        params={"metric": _INSTAGRAM_INSIGHTS_METRICS, "access_token": access_token},
    )
    if resp.status_code >= 400:
        # story #3605 — _fetch_threads와 동형(Graph envelope 파싱 우선, 밖이면
        # 기존 status_code 휴리스틱 폴백, 회귀 0).
        from app.services.graph_api_errors import classify_graph_oauth_error, parse_graph_error_envelope

        _code, _subcode, _type = parse_graph_error_envelope(resp)
        oauth_reason = classify_graph_oauth_error(error_code=_code, error_subcode=_subcode, error_type=_type)
        if oauth_reason is not None:
            _status, _ = oauth_reason
            _error_code = {
                "expired": "CHANNEL_TOKEN_EXPIRED", "revoked": "CHANNEL_CONNECTION_REVOKED",
            }.get(_status, "CHANNEL_CONNECTION_AUTH_ERROR")
            raise InsightFetchError(error_code=_error_code, message=f"Instagram 인사이트 인증 오류: {resp.text[:500]}")
    if resp.status_code == 401:
        raise InsightFetchError(error_code="CHANNEL_TOKEN_EXPIRED", message="Instagram 액세스 토큰이 만료되었습니다")
    if resp.status_code == 429:
        raise InsightFetchError(error_code="CHANNEL_RATE_LIMITED", message="Instagram 인사이트 API 한도 초과")
    if resp.status_code >= 500:
        raise InsightFetchError(error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", message=f"Instagram 서버 오류: {resp.status_code}")
    if resp.status_code >= 400:
        raise InsightFetchError(error_code="CHANNEL_PUBLISH_AUTH_REJECTED", message=f"Instagram 인사이트 요청 거부: {resp.status_code}")

    body = resp.json()
    values: dict[str, int] = {}
    for item in body.get("data", []):
        name = item.get("name")
        total = 0
        for v in item.get("values", []) or []:
            total += int(v.get("value", 0) or 0)
        if name in ("views", "reach"):
            values[name] = values.get(name, 0) + total
        elif name in _INSTAGRAM_ENGAGEMENT_METRICS:
            values["engagements"] = values.get("engagements", 0) + total
    return {"raw": body, "values": values}


async def _fetch_instagram_via_connection(db: AsyncSession, snapshot: InsightSnapshot) -> dict[str, Any]:
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_connection import decrypt_for_use

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == snapshot.publication_id)
    )).scalar_one_or_none()
    if pub is None or pub.external_id is None:
        raise InsightFetchError(
            error_code="INSIGHT_PUBLICATION_NOT_FOUND", message=f"channel_publication을 찾을 수 없습니다: {snapshot.publication_id}",
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
        return await _fetch_instagram(client, access_token=access_token, media_id=pub.external_id)


# story #3571(Phase2·BE, 페드루 PO 確定 2026-09-06②) — Meta 문서 지식(⚠️미확認,
# threads/instagram 상단 딱지와 동형). Page 게시물 insights → §2(d) 7키 매핑:
# post_impressions→impressions·post_impressions_unique→reach(Page 게시물의 «도달»
# 표준 메트릭·⚠️미확認)·post_engaged_users→engagements·post_clicks→clicks·
# post_video_views→views(영상 게시물만 — 텍스트/이미지 게시물은 이 메트릭이
# 응답에 아예 안 실려, `values`에서 빠져 _normalize가 자동으로 null="미제공"
# 처리한다. threads/instagram의 "선언 안 함=null"과 다른 축 — 이건 "선언은
# 했지만 이번 fetch가 값을 못 줌"쪽, _normalize 독스트링의 두 번째 경우 그대로
# 재사용, 새 메커니즘 0). spend/conversions은 아예 요청하지 않는다(광고 축·
# Phase 3, 대응 후보 자체가 없음 — threads/instagram과 동일 사유).
_FACEBOOK_INSIGHTS_URL_TMPL = _FACEBOOK_GRAPH_BASE + "/{post_id}/insights"
_FACEBOOK_INSIGHTS_METRICS = "post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_video_views"
_FACEBOOK_METRIC_TO_KEY = {
    "post_impressions": "impressions",
    "post_impressions_unique": "reach",
    "post_engaged_users": "engagements",
    "post_clicks": "clicks",
    "post_video_views": "views",
}


async def _fetch_facebook(client: "httpx.AsyncClient", *, access_token: str, media_id: str) -> dict[str, Any]:  # noqa: F821
    """_fetch_threads/_fetch_instagram과 동형 에러분류(같은 error_code 문자열
    재사용, 새 매핑표 0)."""
    import httpx

    resp = await client.get(
        _FACEBOOK_INSIGHTS_URL_TMPL.format(post_id=media_id),
        params={"metric": _FACEBOOK_INSIGHTS_METRICS, "access_token": access_token},
    )
    if resp.status_code >= 400:
        # story #3605 — _fetch_threads와 동형(Graph envelope 파싱 우선, 밖이면
        # 기존 status_code 휴리스틱 폴백, 회귀 0).
        from app.services.graph_api_errors import classify_graph_oauth_error, parse_graph_error_envelope

        _code, _subcode, _type = parse_graph_error_envelope(resp)
        oauth_reason = classify_graph_oauth_error(error_code=_code, error_subcode=_subcode, error_type=_type)
        if oauth_reason is not None:
            _status, _ = oauth_reason
            _error_code = {
                "expired": "CHANNEL_TOKEN_EXPIRED", "revoked": "CHANNEL_CONNECTION_REVOKED",
            }.get(_status, "CHANNEL_CONNECTION_AUTH_ERROR")
            raise InsightFetchError(error_code=_error_code, message=f"Facebook 인사이트 인증 오류: {resp.text[:500]}")
    if resp.status_code == 401:
        raise InsightFetchError(error_code="CHANNEL_TOKEN_EXPIRED", message="Facebook 액세스 토큰이 만료되었습니다")
    if resp.status_code == 429:
        raise InsightFetchError(error_code="CHANNEL_RATE_LIMITED", message="Facebook 인사이트 API 한도 초과")
    if resp.status_code >= 500:
        raise InsightFetchError(error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", message=f"Facebook 서버 오류: {resp.status_code}")
    if resp.status_code >= 400:
        raise InsightFetchError(error_code="CHANNEL_PUBLISH_AUTH_REJECTED", message=f"Facebook 인사이트 요청 거부: {resp.status_code}")

    body = resp.json()
    values: dict[str, int] = {}
    for item in body.get("data", []):
        key = _FACEBOOK_METRIC_TO_KEY.get(item.get("name"))
        if key is None:
            continue
        item_values = item.get("values") or []
        # 페드루 PO 리뷰(2026-09-06) — 「값이 실제로 있을 때만 싣는다」 원칙: name은
        # 왔지만 values가 빈 목록이면(예: 이 지표가 이번 응답에서 실제로 안 잡힘)
        # total=0으로 지어내 싣지 않는다 — 항목이 1개 이상일 때만 합산해 싣는다.
        if not item_values:
            continue
        total = sum(int(v.get("value", 0) or 0) for v in item_values)
        values[key] = values.get(key, 0) + total
    return {"raw": body, "values": values}


async def _fetch_facebook_via_connection(db: AsyncSession, snapshot: InsightSnapshot) -> dict[str, Any]:
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_connection import decrypt_for_use

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == snapshot.publication_id)
    )).scalar_one_or_none()
    if pub is None or pub.external_id is None:
        raise InsightFetchError(
            error_code="INSIGHT_PUBLICATION_NOT_FOUND", message=f"channel_publication을 찾을 수 없습니다: {snapshot.publication_id}",
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
        return await _fetch_facebook(client, access_token=access_token, media_id=pub.external_id)


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
    if snapshot.channel == "instagram":
        return await _fetch_instagram_via_connection(db, snapshot)
    if snapshot.channel == "facebook":
        return await _fetch_facebook_via_connection(db, snapshot)
    # story #3696(Phase2·BE·funnel 갭, 디디 e2e 그라운딩 발견 2026-09-08) — 이전
    # 주석("instagram_sandbox와 달리 facebook_sandbox는 dispatch가 없으면...")이
    # instagram_sandbox는 이미 분기가 있다는 전제로 쓰여 있었으나 실제로는 없었다
    # (facebook_sandbox 추가 시 그 옆 채널도 있으려니 한 자기기만 — 어댑터 선언
    # (insight_metrics 非빈)과 dispatch가 갈려, instagram_sandbox 발행물의 due
    # 스냅샷이 매번 이 함수 끝의 INSIGHT_CHANNEL_NOT_IMPLEMENTED로 떨어져 영구
    # 'failed'였다). 두 sandbox 채널 다 여기서 명시 — 어댑터 선언과 dispatch를
    # 짝으로 유지한다(AC3 가드 test_3696가 이 짝을 구조적으로 계속 대조한다).
    if snapshot.channel in ("facebook_sandbox", "instagram_sandbox"):
        return _fetch_sandbox(publication_id=snapshot.publication_id)
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
            error_code="INSIGHT_PUBLICATION_NOT_FOUND", message=f"channel_publication을 찾을 수 없습니다: {snapshot.publication_id}",
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


# story #3660 CHANGES①(페드루 PO, 2026-09-07, PR #4015) — 클레임(pending→in_progress
# 전이·commit) 뒤 개별 처리 사이의 창에서, 같은 publication의 재발행이 이 행을
# superseded로 회수할 수 있다(schedule_insight_snapshots, 별도 트랜잭션). 실측(라이브
# 재현) — 처음엔 `snapshot.status = "captured"`처럼 status도 **파이썬 속성**으로 대입해
# 뒀는데, 그 뒤(같은 반복 안에서) `_maybe_enrich_with_ga4_inflow`가 부르는
# `db.execute(select(...))` 같은 다른 쿼리가 **autoflush**를 유발해 그 dirty
# status="captured"가 가드 UPDATE보다 **먼저** 무조건 DB에 써져 버렸다 — 그 뒤로는 내
# 가드(`WHERE status='in_progress'`)가 항상 거짓으로 "이미 회수됨"이라 오판했다(제 손
# 으로 in_progress를 지워 놓고). 처방 — **status는 파이썬 속성으로 절대 대입하지
# 않는다**(다른 필드는 무해 — autoflush돼도 그 값 자체는 그대로 맞다). 오직 이 함수의
# `new_status` 인자(지역 변수, ORM dirty-tracking 밖)로만 가드 UPDATE에 실린다.
_NON_STATUS_TERMINAL_FIELDS = ("captured_at", "error_code", "raw_payload", "normalized", "source", "attempt_count")


async def _finalize_snapshot_write(db: AsyncSession, snapshot: InsightSnapshot, *, new_status: str) -> bool:
    """`snapshot`의 status 아닌 필드(이미 파이썬 속성으로 대입돼 있음, autoflush돼도
    무해)를 그대로 읽고, `new_status`(호출자의 지역 변수 — `snapshot.status`엔 한 번도
    대입 안 됨)를 더해 `WHERE id=:id AND status='in_progress'` 가드가 붙은 명시적
    UPDATE로 쓴다. `db.expunge(snapshot)`로 세션 추적에서 뗀 뒤 실행 — 안 그러면
    `db.execute()`의 autoflush가(non-status 필드라도) 이 객체의 dirty 상태를 내 가드
    보다 먼저 써 버릴 수 있다. `synchronize_session=False` — 이 UPDATE가 세션의
    identity map과 동기화하려 들면(기본 "auto"), 같은 배치의 *다른* still-attached
    InsightSnapshot(예: 같은 tick의 7d 짝)까지 재평가하다 만료된/미로딩 속성을
    lazy-load하려 시도해 async 세션에서 MissingGreenlet으로 죽는다(실측) — 이 UPDATE는
    정확히 이 한 행만 겨눈다는 것을 이미 아니 동기화가 불필요하다.

    반환 False(가드 미통과=그 사이 superseded로 회수됨)면 이 트랜잭션 전체를 rollback
    한다 — 이 반복에서 `db.add()`한 부수 기록(예: `_record_insight_evidence`의 Evidence)
    도 같이 버려진다(이미 회수된 옛 사이클의 evidence를 남기지 않는다, 올바른 동작)."""
    values = {f: getattr(snapshot, f) for f in _NON_STATUS_TERMINAL_FIELDS}
    values["status"] = new_status
    snapshot_id = snapshot.id
    db.expunge(snapshot)
    result = await db.execute(
        update(InsightSnapshot)
        .where(InsightSnapshot.id == snapshot_id, InsightSnapshot.status == "in_progress")
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount == 0:
        await db.rollback()
        return False
    await db.commit()
    return True


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
                snapshot.captured_at = now
                if await _finalize_snapshot_write(db, snapshot, new_status="unsupported"):
                    counts["unsupported"] += 1
                continue

            try:
                result = await _fetch_for_snapshot(db, snapshot)
            except InsightFetchError as exc:
                failure_kind = classify_failure_kind(exc.error_code)
                if failure_kind == FAILURE_KIND_CONNECTION:
                    await _promote_connection_status_for_snapshot(
                        db, snapshot, error_code=exc.error_code, message=str(exc),
                    )
                    snapshot.error_code = exc.error_code
                    if await _finalize_snapshot_write(db, snapshot, new_status="failed"):
                        counts["failed"] += 1
                elif failure_kind == FAILURE_KIND_TRANSIENT:
                    snapshot.attempt_count += 1
                    snapshot.error_code = exc.error_code
                    if snapshot.attempt_count >= 5:
                        if await _finalize_snapshot_write(db, snapshot, new_status="failed"):
                            counts["failed"] += 1
                    else:
                        if await _finalize_snapshot_write(db, snapshot, new_status="pending"):
                            counts["pending_retry"] += 1
                else:
                    snapshot.error_code = exc.error_code
                    if await _finalize_snapshot_write(db, snapshot, new_status="failed"):
                        counts["failed"] += 1
                continue

            snapshot.raw_payload = result["raw"]
            snapshot.normalized = _normalize(declared_metrics=declared, values=result["values"])
            snapshot.captured_at = now
            snapshot.source = snapshot.channel
            await _maybe_enrich_with_ga4_inflow(db, snapshot)
            await _record_insight_evidence(db, snapshot)
            if await _finalize_snapshot_write(db, snapshot, new_status="captured"):
                counts["captured"] += 1
        except Exception:  # noqa: BLE001 — publication_command.py와 동형 2중 방어.
            await db.rollback()
            counts["error"] += 1
            logger.exception("insight snapshot 처리 실패 snapshot_id=%s", snapshot.id)
    return counts


async def _promote_connection_status_for_snapshot(
    db: AsyncSession, snapshot: InsightSnapshot, *, error_code: str | None = None, message: str | None = None,
) -> None:
    """publication_command.py:454-461과 동형 inline 승격(그라운딩⑤, 새 상태값 0) —
    hosted_site/sandbox는 connection 자체가 없어 no-op(그 두 채널은 애초에
    FAILURE_KIND_CONNECTION을 못 낸다 — CHANNEL_TOKEN_EXPIRED류를 던지는 곳이
    threads 경로뿐).

    story #3603(Phase2·BE·소형·결함, 페드루 PO 確定 2026-09-07) — channel_post_
    comments.py::_promote_connection_status와 동형 last_error 3종 additive
    (status의 sticky 여부와 무관하게 last_error_code·last_error_at은 항상 갱신).

    story #3605(실측 정정) — error_code 무관하게 항상 "expired"로 굳혔던 것을
    바로잡는다(channel_post_comments.py::_promote_connection_status·publication_
    command.py::apply_command_failure와 같은 결함 클래스, 같은 스토리에서 같이
    고침). `graph_api_errors.sticky_connection_status`(공유 단일 지점, CHANGES-2)
    가 정확한 status를 고른다 — #3603의 `not in ("revoked", "error")` 가드를 이
    함수가 대체한다(expired도 이제 동등하게 sticky)."""
    from datetime import datetime, timezone

    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.services.graph_api_errors import mark_connection_failed

    if snapshot.publication_kind != "channel_publication":
        return
    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == snapshot.publication_id)
    )).scalar_one_or_none()
    if pub is None:
        return
    connection = await db.get(ChannelConnection, pub.connection_id)
    if connection is None:
        return
    # story #3646 — channel_post_comments.py::_promote_connection_status·
    # publication_command.py::apply_command_failure(CONNECTION 분기)와 이제 이
    # 4줄을 한 헬퍼로 공유한다(중복 3벌 → 1).
    mark_connection_failed(connection, error_code=error_code, message=message, now=datetime.now(timezone.utc))


_GA4_RUN_REPORT_URL_TMPL = "https://analyticsdata.googleapis.com/v1beta/properties/{property_id}:runReport"


async def _fetch_ga4_inflow(
    client: "httpx.AsyncClient", *, access_token: str, property_id: str,  # noqa: F821
    source: str, medium: str, campaign: str, start_date: str, end_date: str,
) -> dict[str, int]:
    """story #3583-BE(그라운딩③ PO 確定) — GA4 Data API `runReport`. 이 발행물의
    UTM(source/medium/campaign) **정확 일치** 세션만 필터링해 sessions·totalUsers·
    keyEvents를 합산한다. `rows`가 아예 없으면(그 필터로 온 세션이 0건이거나
    GA4 데이터 처리 지연으로 이 기간을 아직 안 채웠을 수 있음) 빈 dict를 돌려준다
    — 0을 지어내지 않고 호출부가 그대로 「미제공」 처리하게 한다(보수적 판단,
    threads/instagram/facebook의 "값이 있을 때만 싣는다" 원칙과 동형).

    페드루 PO 리뷰(2026-09-06) — GA4 `conversions` 메트릭은 2024-05-06 changelog
    로 deprecated, 대체는 `keyEvents`(같은 개념·새 이름). `conversions`를 그대로
    요청하면 400이 나고 이 함수의 `resp.status_code != 200` 분기가 예외를 던져
    호출부(`_maybe_enrich_with_ga4_inflow`)가 조용히 전부 미제공으로 삼켜버리는
    자리라 — 지금 고치지 않으면 라이브에서 inflow_conversions가 영원히 null이
    되는 잠복 결함이었다."""
    from app.services.ga4_oauth import GA4OAuthError

    body = {
        "dateRanges": [{"startDate": start_date, "endDate": end_date}],
        "dimensions": [
            {"name": "sessionSource"}, {"name": "sessionMedium"}, {"name": "sessionCampaignName"},
        ],
        "metrics": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "keyEvents"}],
        "dimensionFilter": {
            "andGroup": {"expressions": [
                {"filter": {"fieldName": "sessionSource", "stringFilter": {"value": source}}},
                {"filter": {"fieldName": "sessionMedium", "stringFilter": {"value": medium}}},
                {"filter": {"fieldName": "sessionCampaignName", "stringFilter": {"value": campaign}}},
            ]}
        },
    }
    resp = await client.post(
        _GA4_RUN_REPORT_URL_TMPL.format(property_id=property_id),
        json=body, headers={"Authorization": f"Bearer {access_token}"},
    )
    if resp.status_code != 200:
        raise GA4OAuthError("GA4_RUN_REPORT_FAILED", resp.text[:500], status_code=resp.status_code)

    result = resp.json()
    rows = result.get("rows") or []
    if not rows:
        return {}
    metric_names = [h["name"] for h in result.get("metricHeaders", [])]
    totals = {name: 0 for name in metric_names}
    for row in rows:
        for i, mv in enumerate(row.get("metricValues", [])):
            if i < len(metric_names):
                totals[metric_names[i]] += int(float(mv.get("value", 0) or 0))
    return {
        "inflow_sessions": totals.get("sessions", 0),
        "inflow_users": totals.get("totalUsers", 0),
        "inflow_conversions": totals.get("keyEvents", 0),
    }


async def _maybe_enrich_with_ga4_inflow(db: AsyncSession, snapshot: InsightSnapshot) -> None:
    """story #3583-BE(그라운딩③ PO 確定) — inflow_* 3키는 채널 어댑터의 declared_
    metrics 축과 별개(org GA4 연결 여부로만 판정) — `_normalize`가 이미 이 3키를
    null로 채워 둔 뒤(어느 채널 어댑터도 이 키들을 선언 안 하므로), 이 함수는
    조건이 맞을 때만 그 값을 **덮어쓴다**. 외부 channel_post 발행물에만 적용
    (hosted_site는 그 글이 UTM 링크의 목적지지 발신지가 아니므로 스코프 밖).

    best-effort — 이 함수의 어떤 실패도 스냅샷 전체를 실패시키지 않는다(채널
    자신의 성과 캡처는 이미 끝난 뒤 호출된다, inflow는 부가 정보). 지속 인증
    실패만 GA4Connection을 needs_reauth로 승격(덧붙임 c) — 그 외(429/5xx/
    네트워크/UTM 불일치로 rows 0건)는 조용히 미제공으로 남긴다."""
    if snapshot.publication_kind != "channel_publication":
        return

    import httpx

    from app.models.channel_post_version import ChannelPostVersion
    from app.models.channel_publication import ChannelPublication
    from app.models.ga4_connection import GA4Connection
    from app.services.channel_adapters import CHANNEL_ADAPTERS
    from app.services.channel_credential_crypto import decrypt_channel_credential, encrypt_channel_credential
    from app.services.ga4_oauth import (
        GA4OAuthError,
        classify_ga4_reauth_reason,
        is_persistent_ga4_auth_failure,
        refresh_access_token,
    )
    from app.services.utm import resolve_utm_campaign

    ga4_connection = (await db.execute(
        select(GA4Connection).where(GA4Connection.org_id == snapshot.org_id)
    )).scalar_one_or_none()
    if ga4_connection is None or ga4_connection.status != "connected" or not ga4_connection.property_id:
        return

    adapter = CHANNEL_ADAPTERS.get(snapshot.channel)
    if adapter is None or not adapter.utm_source:
        return  # 이 채널은 UTM 부착 자체를 선언 안 함.

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == snapshot.publication_id)
    )).scalar_one_or_none()
    if pub is None or pub.published_at is None:
        return
    version = await db.get(ChannelPostVersion, pub.version_id)
    if version is None:
        return
    campaign = resolve_utm_campaign(version.link_url, fallback_draft_id=version.draft_id)

    from app.core.config import settings
    from app.services.org_time import get_org_timezone, to_org_date

    # story #3684(3682 그라운딩 확定, PO 確定 2026-09-07) — GA4 dateRanges는 속성
    # 시간대의 "온전한 날"만 받는다. published_at/due_at(둘 다 UTC datetime)을
    # 그대로 .date()로 자르면 org가 UTC보다 앞선 시간대(KST 등)일 때 자정~그
    # 시차만큼의 발행분이 "발행 前날"로 잘못 잘린다(3682 실측: KST 00~09시
    # 발행분, moonklabs 실 사례 — org tz=property tz=Asia/Seoul인데도 코드가
    # 어느 쪽 tz도 거치지 않아 어긋났다). «날»의 정의(PO 確定): 1일 유입=발행
    # org-일 단 하루, 7일 유입=발행 org-일부터 7 org-일 — GA4가 보는 "온전한 날"
    # 창은 그 자체로 24시간 경과 스냅샷(due_at, _SNAPSHOT_OFFSETS)과는 다른
    # 축이다(그 스냅샷 계약 자체는 무변).
    #
    # 불변식 — 이 창의 마지막 org-일은 due_at 直前(자정 기준)에 끝난다(1d:
    # 발행 당일 하루<다음날 due_at, 7d: 발행+6일<발행+7일 due_at) — due_at에
    # 아직 데이터가 안 채워진 미완은 GA4 처리 지연뿐이고, 그건 기존 rows=[]
    # "미제공" 처리 그대로다(due_at은 "언제 수집 시도하나"만 담당, 이 날짜
    # 문자열과는 이제 분리된 축).
    org_timezone = await get_org_timezone(db, snapshot.org_id)
    start_org_date = to_org_date(pub.published_at, org_timezone)
    # story #3684 CHANGES(카디르 QA·PO 페드루 처방①, 2026-09-08) — offset_days를
    # due_at의 경과 wall-time을 86400으로 나눠 역산하지 않는다. 스케줄 시점에 이미
    # 아는 의도(_SNAPSHOT_OFFSETS의 1d/7d)를 due_at과 직접 대조해 그대로 읽는다 —
    # "경과시간 ÷ 하루초" 라는 암묵적 등식 자체를 걷어낸다(날짜창은 org-date
    # 산술이라 이미 DST 무관하게 견고, 아래 참고).
    offset_days = next(
        (offset.days for offset in _SNAPSHOT_OFFSETS if snapshot.due_at == pub.published_at + offset),
        None,
    )
    if offset_days is None:
        # 알려진 오프셋과 due_at이 정확히 안 맞는 행(레거시/수동 seed 등) — 예전
        # 근사식으로 폴백(이 갈래는 새 코드 경로가 아니라 안전망).
        offset_days = round(
            ((snapshot.due_at or pub.published_at) - pub.published_at).total_seconds() / 86400
        )
    end_org_date = start_org_date + timedelta(days=max(offset_days - 1, 0))
    start_date = start_org_date.isoformat()
    end_date = end_org_date.isoformat()
    # ⚠️알려진 제약(카디르 QA 재현·PO 페드루 確定 2026-09-08, 스코프 밖) — due_at
    # 자체는 여전히 `_SNAPSHOT_OFFSETS`가 주는 고정 UTC 경과시간(24h/7×24h)이다.
    # org 시간대가 DST를 쓰면 fall-back일(로컬 25시간짜리 하루)을 낀 창에서 due_at이
    # 그 org-일의 실제 로컬 자정(끝)보다 최대 1시간 먼저 올 수 있다(카디르 재현:
    # America/New_York 2026-11-01 04:30 UTC 발행 → due_at=+24h=2026-11-02 04:30 UTC
    # 인데 그 org-일 로컬 자정은 2026-11-02 05:00 UTC — 30분 모자람, 아래 회귀
    # 테스트가 이 표본을 고정한다). 완전한 처방(due_at 자체를 org-로컬 자정 경계로
    # 다시 계산)은 due_at을 만드는 `schedule_insight_snapshots`의 스케줄링 자체를
    # 바꿔야 하는데, 그 due_at은 이 GA4 보강뿐 아니라 스냅샷 캡처 틱 자체의
    # 트리거이기도 해(story #3497) 이 스토리 스코프(GA4 날짜창 계산 하나)보다
    # 크다 — PO 確定으로 이번엔 알려진 제약으로 남긴다. DST가 없는 tz(Asia/Seoul 등)
    # 는 전혀 안 걸린다.

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            access_token, _expires_in = await refresh_access_token(
                client, refresh_token=decrypt_channel_credential(ga4_connection.encrypted_refresh_token),
                client_id=settings.google_client_id, client_secret=settings.google_client_secret,
            )
        except GA4OAuthError as exc:
            if is_persistent_ga4_auth_failure(exc):
                ga4_connection.status = "needs_reauth"
                ga4_connection.reason = classify_ga4_reauth_reason(exc)
            return
        try:
            inflow = await _fetch_ga4_inflow(
                client, access_token=access_token, property_id=ga4_connection.property_id,
                source=adapter.utm_source, medium=adapter.utm_medium, campaign=campaign,
                start_date=start_date, end_date=end_date,
            )
        except GA4OAuthError:
            return

    ga4_connection.encrypted_access_token = encrypt_channel_credential(access_token)
    if inflow and snapshot.normalized is not None:
        snapshot.normalized.update(inflow)


async def _resolve_channel_publication_asset_evidence(
    db: AsyncSession, *, publication_kind: str, publication_id: uuid.UUID,
) -> tuple[list[str] | None, str | None]:
    """story #3645(Phase2·BE, 페드루 PO 確定 2026-09-07 — 그라운딩 정정: asset_master
    개념은 코드 0건, 블루프린트 «처분»을 «착지»로 읽은 PO 오독이었다) — 이 발행물이
    실제로 내보낸 소재(이미지/영상)의 sha256을 position 순으로, 그리고 그 버전에
    걸린 `hook_key`를 함께(`(asset_sha256s, hook_key)`) — 같은 `ChannelPublication`→
    `ChannelPostVersion` 조회를 한 번만 태운다.

    story #3656(페드루 PO 確定 2026-09-07) — 원래 `InsightSnapshot` 객체 하나를
    받았으나, `list_insights_board`(다른 호출부, 스냅샷이 아니라 UNION 행에서
    kind/publication_id를 직접 갖고 있다 — 행마다 스냅샷이 있다는 보장도 없다,
    아직 스냅샷 자체가 안 뜬 신규 발행물도 이 화면엔 뜬다)도 같은 로직이 필요해져
    `snapshot.publication_kind`/`snapshot.publication_id` 두 속성만 쓰던 것을
    평범한 인자 둘로 뺐다(동작 변경 0 — 기존 유일 호출부 `_record_insight_evidence`
    도 이 두 값을 그대로 넘기도록 같이 고쳤다).

    `publication_kind == "site_post"`(hosted_site)는 이미지/영상·hook_key 개념
    자체가 없어 `(None, None)`(있는 걸 지어내지 않는다). `channel_publication`만
    `ChannelPublication.version_id`를 거쳐 찾는다 — 릴스(`ChannelPostVideo`, story
    #3554)면 영상+커버(position=0 이미지) 순으로 2건, 아니면 `ChannelPostImage`를
    position 순으로(캐러셀 N장 또는 단일 1장). 이미지도 영상도 없으면(텍스트만)
    asset_sha256s는 None. hook_key는 이 시점의 `ChannelPostVersion.hook_key` 값을
    그대로 카피 — 발행 뒤 그 컬럼을 고쳐도 이미 기록된 이 evidence는 안 바뀐다."""
    if publication_kind != "channel_publication":
        return None, None

    publication = await db.get(ChannelPublication, publication_id)
    if publication is None:
        return None, None

    version = await db.get(ChannelPostVersion, publication.version_id)
    hook_key = version.hook_key if version is not None else None

    video = (await db.execute(
        select(ChannelPostVideo).where(ChannelPostVideo.version_id == publication.version_id)
    )).scalar_one_or_none()

    images = (await db.execute(
        select(ChannelPostImage)
        .where(ChannelPostImage.version_id == publication.version_id)
        .order_by(ChannelPostImage.position.asc())
    )).scalars().all()

    sha256s: list[str] = []
    if video is not None:
        sha256s.append(video.original_sha256)
    sha256s.extend(image.original_sha256 for image in images)

    return sha256s or None, hook_key


async def batch_fetch_channel_post_asset_evidence_sources(
    db: AsyncSession, *, version_ids: list[uuid.UUID],
) -> tuple[
    dict[uuid.UUID, str | None], dict[uuid.UUID, list[ChannelPostImage]], dict[uuid.UUID, ChannelPostVideo],
]:
    """story #3656(페드루 PO CHANGES, 2026-09-07) — `list_insights_board`가 페이지
    전체(최대 `limit`행)의 소재/훅을 «행마다» 조회하면(_resolve_channel_publication_
    asset_evidence 재사용) channel_publication 행 하나당 최대 3쿼리가 붙어 N+1이
    된다(PO 실측: 페이지 상한 200행 기준 최악 600쿼리, "보드가 못 견딘다"). 이
    함수가 그 3쿼리(hook_key·video·image, 전부 version_id IN (...))를 페이지의
    모든 version_id에 대해 **한 번씩만** 태우고 `_assemble_channel_post_asset_
    evidence`(아래, 순수 조립)가 행마다 이 결과에서 조립한다 — 쿼리 수가 페이지
    행 수와 무관하게 상수(3)로 고정된다.

    단건 호출부(`_record_insight_evidence`, 워커 tick이 캡처된 스냅샷 하나씩
    처리 — 애초에 N+1이 아니다)는 `_resolve_channel_publication_asset_evidence`
    그대로 쓴다 — 이 배치 함수로 안 바꾼다(그 자리는 배치화할 "여러 행"이 없다)."""
    if not version_ids:
        return {}, {}, {}

    versions = (await db.execute(
        select(ChannelPostVersion).where(ChannelPostVersion.id.in_(version_ids))
    )).scalars().all()
    hook_key_by_version = {v.id: v.hook_key for v in versions}

    videos = (await db.execute(
        select(ChannelPostVideo).where(ChannelPostVideo.version_id.in_(version_ids))
    )).scalars().all()
    video_by_version = {v.version_id: v for v in videos}

    images = (await db.execute(
        select(ChannelPostImage)
        .where(ChannelPostImage.version_id.in_(version_ids))
        .order_by(ChannelPostImage.position.asc())
    )).scalars().all()
    images_by_version: dict[uuid.UUID, list[ChannelPostImage]] = {}
    for image in images:
        images_by_version.setdefault(image.version_id, []).append(image)

    return hook_key_by_version, images_by_version, video_by_version


def assemble_channel_post_asset_evidence(
    version_id: uuid.UUID | None,
    *,
    hook_key_by_version: dict[uuid.UUID, str | None],
    images_by_version: dict[uuid.UUID, list[ChannelPostImage]],
    video_by_version: dict[uuid.UUID, ChannelPostVideo],
) -> tuple[list[str] | None, str | None]:
    """순수 함수(DB 왕복 0) — `batch_fetch_channel_post_asset_evidence_sources`가
    낸 dict 셋에서 특정 `version_id` 하나의 (asset_sha256s, hook_key)를 조립한다.
    `_resolve_channel_publication_asset_evidence`와 정확히 같은 규칙(영상+커버
    우선, 없으면 이미지 position 순) — 같은 로직을 두 번 짓지 않고 dict 조회로만
    바꿔치기했다. `version_id`가 None이면(site_post류, 애초에 소재 개념이 없는
    행) 조회 없이 바로 `(None, None)`."""
    if version_id is None:
        return None, None
    hook_key = hook_key_by_version.get(version_id)
    sha256s: list[str] = []
    video = video_by_version.get(version_id)
    if video is not None:
        sha256s.append(video.original_sha256)
    sha256s.extend(image.original_sha256 for image in images_by_version.get(version_id, []))
    return sha256s or None, hook_key


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

    # story #3645 — 이 evidence 시점의 소재 계보·hook_key를 고정한다(publish 뒤 draft
    # 쪽 이미지나 hook_key가 바뀌어도 이미 기록된 이 evidence는 안 바뀐다 — 카피지
    # 참조가 아니다).
    asset_sha256s, hook_key = await _resolve_channel_publication_asset_evidence(
        db, publication_kind=snapshot.publication_kind, publication_id=snapshot.publication_id,
    )

    db.add(Evidence(
        id=uuid.uuid4(), org_id=snapshot.org_id, work_item_id=snapshot.work_item_id,
        work_item_type="story", type="metric", ref=str(snapshot.id), source=snapshot.channel,
        note=note, created_by=None,
        payload={
            **n, "captured_at": snapshot.captured_at.isoformat() if snapshot.captured_at else None,
            "source": snapshot.channel, "snapshot_id": str(snapshot.id), "recorded_by": "platform",
            "asset_sha256s": asset_sha256s, "hook_key": hook_key,
        },
    ))
