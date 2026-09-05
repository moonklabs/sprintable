"""story #3502(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 성과 보드 API. 블루프린트
v3 §2 「대시보드·보고서」 MVP "채널·게시물 표". hosted_site(SitePost)와 외부 채널
(ChannelPublication) — 서로 컬럼 모양이 다른 두 테이블을 조직 전체 기준 한 표로 낸다.
이 코드베이스에 «두 이형 테이블을 한 표로»(UNION) 조회하는 선례가 이 스토리 착수
시점에 없었다 — 이 서비스가 그 첫 사례다(PO 確定 (a)).

**정렬·필터·커서·LIMIT은 UNION ALL 서브쿼리 바깥에서 한 번만** — Python에서 두 팔의
결과를 따로 조회해 병합하면 커서 keyset이 두 팔 사이에서 깨진다(한쪽 팔의 다음 페이지
시작점을 다른 쪽 팔의 정렬 위치로 재구성할 방법이 없다 — PO 確定 (a) 그대로).

스냅샷(+1일·+7일) 값은 이 UNION 쿼리에 조인하지 않는다 — 페이지를 먼저 뽑고
publication_id를 모아 `WHERE publication_id IN (...)` 배치 조회 1회 → Python에서
due_at 버킷별로 두 열(`d1`·`d7`)로 피벗한다(PO 決定 — assets.py의 N+1 회피 관례와
동형, 행당 최대 2건이라 배치도 작다). 단 **status 필터**(스냅샷 상태로 행을 거르는
것)만은 이 파이프라인 밖에서 안 되므로 EXISTS 서브쿼리로 SQL 안에 남는다."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import Integer, Text, cast, exists, literal, select, union_all
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.pagination import decode_cursor, decode_metric_cursor, encode_cursor, encode_metric_cursor
from app.models.channel_publication import ChannelPublication
from app.models.gate import Gate
from app.models.insight_snapshot import InsightSnapshot
from app.models.pm import Story
from app.models.site_post import SitePost
from app.services.insight_snapshots import NORMALIZED_KEYS

_WINDOW_DAYS = {"7d": 7, "30d": 30, "90d": 90}  # story 確定(e) — 3475(7d·30d)에 90d 신규 편입.
_SNAPSHOT_OFFSET_DAYS = {"d1": 1, "d7": 7}


class InsightsBoardInvalidWindowError(Exception):
    pass


class InsightsBoardInvalidSortError(Exception):
    def __init__(self, sort: str):
        self.sort = sort
        super().__init__(f"unsupported sort: {sort}")


def _blog_external_url_expr(base_url: str | None):
    """site_posts.py::_blog_post_path(lang, slug)="/{lang}/blog/{slug}"와 같은 규칙을
    SQL 문자열 연결로 재현한다(PO 確定 (a) — "같은 규칙"). base_url 미설정(dev 등)이면
    NULL(지어내지 않는다 — _resolve_public_site_display_url과 동형 판단)."""
    if not base_url:
        return cast(literal(None), Text)
    return literal(base_url) + literal("/") + SitePost.lang + literal("/blog/") + SitePost.slug


def _build_union(*, org_id: uuid.UUID, channel: str | None, since: datetime):
    site_post_arm = select(
        SitePost.id.label("publication_id"),
        literal("site_post").label("kind"),
        literal("hosted_site").label("channel"),
        SitePost.source_story_id.label("work_item_id"),
        SitePost.title.label("title"),
        SitePost.published_at.label("published_at"),
        _blog_external_url_expr(settings.public_site_base_url).label("external_url"),
        cast(literal(None), PG_UUID(as_uuid=True)).label("connection_id"),
    ).where(
        SitePost.org_id == org_id, SitePost.unpublished_at.is_(None), SitePost.published_at >= since,
    )
    if channel is not None and channel != "hosted_site":
        site_post_arm = site_post_arm.where(literal(False))  # 이 팔 자체를 비운다(채널 불일치).

    channel_pub_arm = (
        select(
            ChannelPublication.id.label("publication_id"),
            literal("channel_publication").label("kind"),
            ChannelPublication.channel.label("channel"),
            Gate.work_item_id.label("work_item_id"),
            Story.title.label("title"),
            ChannelPublication.published_at.label("published_at"),
            ChannelPublication.permalink.label("external_url"),
            ChannelPublication.connection_id.label("connection_id"),
        )
        .select_from(ChannelPublication)
        .join(Gate, Gate.id == ChannelPublication.gate_id)
        .join(Story, Story.id == Gate.work_item_id)
        .where(
            ChannelPublication.org_id == org_id, ChannelPublication.status == "published",
            ChannelPublication.published_at.is_not(None), ChannelPublication.published_at >= since,
        )
    )
    if channel is not None:
        if channel == "hosted_site":
            channel_pub_arm = channel_pub_arm.where(literal(False))
        else:
            channel_pub_arm = channel_pub_arm.where(ChannelPublication.channel == channel)

    return union_all(site_post_arm, channel_pub_arm).cte("insights_board_rows")


async def list_insights_board(
    db: AsyncSession, *, org_id: uuid.UUID, window: str = "30d", channel: str | None = None,
    status: str | None = None, sort: str = "published_at", sort_dir: str = "desc",
    cursor: str | None = None, limit: int = 50, now: datetime | None = None,
) -> dict[str, Any]:
    if window not in _WINDOW_DAYS:
        raise InsightsBoardInvalidWindowError(window)
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=_WINDOW_DAYS[window])

    rows_cte = _build_union(org_id=org_id, channel=channel, since=since)
    query = select(rows_cte)

    if status is not None:
        query = query.where(exists(
            select(1).where(
                InsightSnapshot.publication_id == rows_cte.c.publication_id,
                InsightSnapshot.status == status,
            )
        ))

    if sort == "published_at":
        if cursor is not None:
            cursor_published_at, cursor_id = decode_cursor(cursor)
            if sort_dir == "asc":
                query = query.where(
                    (rows_cte.c.published_at > cursor_published_at)
                    | ((rows_cte.c.published_at == cursor_published_at) & (rows_cte.c.publication_id > cursor_id))
                )
            else:
                query = query.where(
                    (rows_cte.c.published_at < cursor_published_at)
                    | ((rows_cte.c.published_at == cursor_published_at) & (rows_cte.c.publication_id < cursor_id))
                )
        order_col = rows_cte.c.published_at.asc() if sort_dir == "asc" else rows_cte.c.published_at.desc()
        id_order = rows_cte.c.publication_id.asc() if sort_dir == "asc" else rows_cte.c.publication_id.desc()
        query = query.order_by(order_col, id_order)
    else:
        metric, _, day_key = sort.rpartition("_")
        if metric not in NORMALIZED_KEYS or day_key not in _SNAPSHOT_OFFSET_DAYS:
            raise InsightsBoardInvalidSortError(sort)
        offset_days = _SNAPSHOT_OFFSET_DAYS[day_key]
        # PO 確定 (c) — (metric NULLS LAST, published_at DESC, id) 3키 컴포지트. 스칼라
        # 서브쿼리 하나로 그 publication의 해당 버킷(+1일 또는 +7일) 정규화값을 뽑는다
        # (스냅샷 표시용 배치 조회와 별개 — 정렬은 SQL이 해야 keyset 커서가 성립한다).
        metric_col = (
            select(cast(InsightSnapshot.normalized[metric].astext, Integer))
            .where(
                InsightSnapshot.publication_id == rows_cte.c.publication_id,
                InsightSnapshot.due_at == rows_cte.c.published_at + timedelta(days=offset_days),
            )
            .correlate(rows_cte)
            .scalar_subquery()
        ).label("metric_value")
        query = query.add_columns(metric_col)
        if cursor is not None:
            cursor_metric, cursor_published_at, cursor_id = decode_metric_cursor(cursor)
            if cursor_metric is None:
                # NULLS LAST 커서 위치 — metric이 NULL인 그룹 안에서만 이어간다.
                query = query.where(
                    metric_col.is_(None)
                    & (
                        (rows_cte.c.published_at < cursor_published_at)
                        | ((rows_cte.c.published_at == cursor_published_at) & (rows_cte.c.publication_id < cursor_id))
                    )
                )
            else:
                query = query.where(
                    metric_col.is_(None)
                    | (metric_col < cursor_metric)
                    | (
                        (metric_col == cursor_metric)
                        & (
                            (rows_cte.c.published_at < cursor_published_at)
                            | ((rows_cte.c.published_at == cursor_published_at) & (rows_cte.c.publication_id < cursor_id))
                        )
                    )
                )
        query = query.order_by(
            metric_col.desc().nulls_last(), rows_cte.c.published_at.desc(), rows_cte.c.publication_id.desc(),
        )

    query = query.limit(limit + 1)
    result = (await db.execute(query)).all()
    has_more = len(result) > limit
    page = result[:limit]

    # 스냅샷 배치 조회(N+1 회피, assets.py 관례 동형) — 페이지 최대 `limit`건이라
    # publication_id도 최대 그만큼, 행당 스냅샷도 최대 2건이라 이 IN 조회 하나로 충분.
    publication_ids = [r.publication_id for r in page]
    snapshots_by_pub: dict[uuid.UUID, list[InsightSnapshot]] = {}
    if publication_ids:
        snap_rows = (await db.execute(
            select(InsightSnapshot).where(InsightSnapshot.publication_id.in_(publication_ids))
        )).scalars().all()
        for snap in snap_rows:
            snapshots_by_pub.setdefault(snap.publication_id, []).append(snap)

    rows_out = []
    for r in page:
        # due_at은 anchor_at(=published_at) + offset로 스케줄됐다(schedule_insight_
        # snapshots) — published_at과의 일수 차이로 +1일/+7일 버킷을 되짚는다.
        d1 = d7 = None
        for snap in snapshots_by_pub.get(r.publication_id, []):
            offset = (snap.due_at - r.published_at).days
            if offset == 1:
                d1 = snap
            elif offset == 7:
                d7 = snap
        rows_out.append({
            "publication_id": r.publication_id, "kind": r.kind, "channel": r.channel,
            "work_item_id": r.work_item_id, "title": r.title, "published_at": r.published_at,
            "external_url": r.external_url, "connection_id": r.connection_id,
            "d1": _snapshot_view(d1), "d7": _snapshot_view(d7),
        })

    next_cursor = None
    if has_more and rows_out:
        last = page[-1]
        if sort == "published_at":
            next_cursor = encode_cursor(last.published_at, last.publication_id)
        else:
            last_metric = getattr(last, "metric_value", None)
            next_cursor = encode_metric_cursor(last_metric, last.published_at, last.publication_id)

    return {"rows": rows_out, "has_more": has_more, "next_cursor": next_cursor}


def _snapshot_view(snap: InsightSnapshot | None) -> dict[str, Any] | None:
    if snap is None:
        return None
    return {"status": snap.status, "normalized": snap.normalized, "captured_at": snap.captured_at}
