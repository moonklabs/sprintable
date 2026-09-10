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
것)만은 이 파이프라인 밖에서 안 되므로 EXISTS 서브쿼리로 SQL 안에 남는다 — 페드루
PO 기록②(PR#3849 리뷰) **의미는 "이 publication의 스냅샷 중 «어느 하나라도» 그
상태와 일치하면 포함"**이다(d1·d7 둘 다 일치해야 하는 게 아니다 — 예: status=
"captured"는 d1만 captured고 d7이 아직 pending이어도 이 행을 낸다).

**title 축(페드루 PO 기록③, FE 정본용)**: site_post 행의 title은 그 게시물 자신의
제목(SitePost.title)이고, channel_publication 행의 title은 컬럼이 없어 Gate→Story
조인으로 얻은 **원 스토리의 제목**이다 — 같은 필드명이지만 두 팔에서 가리키는
대상이 다르다(하나는 "이 글의 제목", 하나는 "이 글이 파생된 작업 항목의 제목")."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from operator import gt as _gt
from operator import lt as _lt
from typing import Any

from sqlalchemy import Integer, Text, cast, exists, func, literal, select, union_all
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.pagination import decode_cursor, decode_metric_cursor, encode_cursor, encode_metric_cursor
from app.models.channel_post_draft import ChannelPostDraft
from app.models.channel_publication import ChannelPublication
from app.models.channel_post_version import ChannelPostVersion
from app.models.gate import Gate
from app.models.insight_snapshot import InsightSnapshot
from app.models.pm import Story
from app.models.publication_command import PublicationCommand
from app.models.site_post import SitePost
from app.models.site_post_draft import SitePostDraft
from app.services.insight_snapshots import (
    NORMALIZED_KEYS,
    assemble_channel_post_asset_evidence,
    batch_fetch_channel_post_asset_evidence_sources,
    label_snapshot_offset,
)

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


def _build_union(*, org_id: uuid.UUID, channel: str | None, since: datetime, include_deleted: bool = False):
    """story #3734 AC3 후속(PO 라이브 판정 2026-09-09 10:16Z) — 보관(soft-delete)은
    초안(`SitePostDraft`/`ChannelPostDraft`)의 `deleted_at`만 찍고 발행 기록
    (`SitePost`/`ChannelPublication`)은 무변(설계대로, #3291 승인 불변화와 정합) —
    그래서 이 보드가 그 사실을 몰랐다. 두 목록 화면과 같은 낱말 「보관됨 보기」를
    그대로 재사용(`include_deleted`, 목록 두 곳과 동일 파라미터명) — `True`면
    보관된 발행분도 포함(집계·감사용), 기본은 제외."""
    site_post_arm = select(
        SitePost.id.label("publication_id"),
        literal("site_post").label("kind"),
        literal("hosted_site").label("channel"),
        SitePost.source_story_id.label("work_item_id"),
        SitePost.title.label("title"),
        SitePost.published_at.label("published_at"),
        _blog_external_url_expr(settings.public_site_base_url).label("external_url"),
        cast(literal(None), PG_UUID(as_uuid=True)).label("connection_id"),
        # story #3516 조각② — site_post는 댓글 개념 자체가 없어(그라운딩, 민 레군·
        # 유나양 확認) 항상 null(별건으로 미룸, 이 스토리 스코프 밖).
        cast(literal(None), PG_UUID(as_uuid=True)).label("channel_post_draft_id"),
        # story #3656 — site_post는 소재/훅 개념 자체가 없어 항상 null(channel_post_
        # draft_id와 동일 이유).
        cast(literal(None), PG_UUID(as_uuid=True)).label("version_id"),
        # story #3766(별건 ⑩) — site_post 발행 흐름은 이 쿼리가 gate를 아예 조인하지
        # 않는다(channel_pub_arm과 달리 site_post_arm엔 Gate 조인이 없다 — site_post
        # 쪽 gate 경로 자체가 이 스토리 스코프 밖, comments_count·channel_post_draft_id
        # 와 동일 이유로 null). command_status도 그래서 항상 null.
        cast(literal(None), PG_UUID(as_uuid=True)).label("gate_id"),
    ).select_from(SitePost)
    # story #3734 AC3 후속 — SitePost에 draft로의 FK가 없다(site_posts.py 서비스와 동형
    # 관례). (org_id, work_item_id, slug)가 site_post_drafts의 unique 제약과 정확히
    # 일치해 그 키로 원 초안을 되찾는다(lang은 그 제약 밖이라 join 키에 안 씀).
    site_post_arm = site_post_arm.outerjoin(
        SitePostDraft,
        (SitePostDraft.org_id == SitePost.org_id)
        & (SitePostDraft.work_item_id == SitePost.source_story_id)
        & (SitePostDraft.slug == SitePost.slug),
    ).where(
        SitePost.org_id == org_id, SitePost.unpublished_at.is_(None), SitePost.published_at >= since,
    )
    if not include_deleted:
        # 매칭되는 초안이 없으면(SitePostDraft.id IS NULL) 보관 여부를 판정할 수 없으니
        # 배제하지 않는다("모른다≠보관됨") — 있는데 deleted_at이 찍힌 경우만 뺀다.
        site_post_arm = site_post_arm.where(
            (SitePostDraft.id.is_(None)) | (SitePostDraft.deleted_at.is_(None))
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
            # story #3516 조각② — 유나양·민 레군 그라운딩으로 channel_publication
            # 행만 좁힌 필드(신규 컬럼 0·마이그 0, version_id→channel_post_versions.
            # draft_id 조인 1회). 보드 「댓글 {n}」 링크가 이 값으로 변형 상세
            # (/content/channel-posts/{draft_id})로 간다.
            ChannelPostVersion.draft_id.label("channel_post_draft_id"),
            # story #3656 — 소재/훅 배치 조회(batch_fetch_channel_post_asset_evidence_
            # sources)의 키. 이미 조인돼 있는 ChannelPublication에서 바로 뽑는다
            # (추가 조인 0 — channel_post_draft_id와 같은 열에서 파생).
            ChannelPublication.version_id.label("version_id"),
            # story #3766(별건 ⑩, 3746 §3 유나 定) — 「사람 차례」 발행 명령 축
            # (command_status)은 gate_id로 PublicationCommand를 되짚는다
            # (channel_posts.py::_channel_post_to_list_item과 동형 관례 — gate당
            # 최신 명령 1건, "최근 생성" 기준). Gate는 위에서 이미 조인돼 있다(title
            # 조회용) — 추가 조인 0, 열만 하나 더 뽑는다.
            Gate.id.label("gate_id"),
        )
        .select_from(ChannelPublication)
        .join(Gate, Gate.id == ChannelPublication.gate_id)
        .join(Story, Story.id == Gate.work_item_id)
        .outerjoin(ChannelPostVersion, ChannelPostVersion.id == ChannelPublication.version_id)
        # story #3734 AC3 후속 — ChannelPostVersion.draft_id는 이미 조인돼 있다(위,
        # channel_post_draft_id 라벨의 출처) — 그 draft_id로 ChannelPostDraft까지
        # 한 단계 더 조인해 deleted_at을 본다.
        .outerjoin(ChannelPostDraft, ChannelPostDraft.id == ChannelPostVersion.draft_id)
        .where(
            ChannelPublication.org_id == org_id, ChannelPublication.status == "published",
            ChannelPublication.published_at.is_not(None), ChannelPublication.published_at >= since,
        )
    )
    if not include_deleted:
        channel_pub_arm = channel_pub_arm.where(
            (ChannelPostDraft.id.is_(None)) | (ChannelPostDraft.deleted_at.is_(None))
        )
    if channel is not None:
        if channel == "hosted_site":
            channel_pub_arm = channel_pub_arm.where(literal(False))
        else:
            channel_pub_arm = channel_pub_arm.where(ChannelPublication.channel == channel)

    return union_all(site_post_arm, channel_pub_arm).cte("insights_board_rows")


async def _count_hidden_by_archive(
    db: AsyncSession, *, org_id: uuid.UUID, channel: str | None, since: datetime,
) -> int:
    """story #3746(3734 §4-C, 유나 실측) — `SitePost` 유니크는 `(org_id, lang, slug)`
    (work_item_id 없음, site_post.py:20)라 초안 하나가 여러 lang의 발행 행에 걸린다
    — 그 초안 하나를 보관하면 join을 타는 모든 lang 행이 한꺼번에 기본 목록에서
    빠진다(#4087). 화면이 "N건 숨김"을 못 말하던 자리 — 포함/제외 COUNT 차이로 낸다.
    상태(status) 필터와는 무관하다(보관 자체가 뜻이라 그 축을 안 섞는다)."""
    excluded_cte = _build_union(org_id=org_id, channel=channel, since=since, include_deleted=False)
    included_cte = _build_union(org_id=org_id, channel=channel, since=since, include_deleted=True)
    excluded_count = (await db.execute(select(func.count()).select_from(excluded_cte))).scalar_one()
    included_count = (await db.execute(select(func.count()).select_from(included_cte))).scalar_one()
    return max(0, included_count - excluded_count)


async def list_insights_board(
    db: AsyncSession, *, org_id: uuid.UUID, window: str = "30d", channel: str | None = None,
    status: str | None = None, sort: str = "published_at", sort_dir: str = "desc",
    cursor: str | None = None, limit: int = 50, now: datetime | None = None,
    work_item_id: uuid.UUID | None = None, include_deleted: bool = False,
) -> dict[str, Any]:
    if window not in _WINDOW_DAYS:
        raise InsightsBoardInvalidWindowError(window)
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=_WINDOW_DAYS[window])

    rows_cte = _build_union(org_id=org_id, channel=channel, since=since, include_deleted=include_deleted)
    query = select(rows_cte)

    # story #bf290f69(Phase2·BE, 페드루 PO 確定 2026-09-08) — story별 성과 대조. 기존
    # channel/status와 동형 narrowing(AND)뿐, 새 인가 축이 아니다(work_item_id는
    # rows_cte 양쪽 팔이 이미 셀렉트해 두고 있었다 — #3516 comments_count 조인용).
    # 다른 파라미터와 그대로 조합 가능(window/channel/status/sort 전부 무변).
    if work_item_id is not None:
        query = query.where(rows_cte.c.work_item_id == work_item_id)

    if status is not None:
        # story #3746(유나 v5, 2026-09-09) — 「수집 대기」는 pending·in_progress 한
        # 통이다(축은 다음 발로 가른다 — 둘 다 "기다린다"). FE는 이 통을 status=pending
        # 하나로 보낸다(별도 파라미터 값 안 만든다) — 여기서 그 값을 둘로 넓힌다.
        status_values = ("pending", "in_progress") if status == "pending" else (status,)
        query = query.where(exists(
            select(1).where(
                InsightSnapshot.publication_id == rows_cte.c.publication_id,
                InsightSnapshot.status.in_(status_values),
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
        # 페드루 PO 실측(2026-09-05, fd57310d4 리뷰) — 이 분기가 sort_dir를 완전히
        # 무시하고 desc로 하드코딩돼 있었다(published_at 분기는 위에서 정확히 갈랐는데
        # 이 분기만 놓침). NULLS LAST는 방향 무관 상수로 유지(PO 決定 (c))하되, 그
        # 안에서의 순서(비교 연산자·ORDER BY 세 키)는 전부 sort_dir로 갈라야 한다 —
        # ORDER BY만 고치고 커서 비교를 desc로 두면 asc 2페이지째가 뒤로 점프한다
        # (세 자리가 한 묶음).
        if cursor is not None:
            cursor_metric, cursor_published_at, cursor_id = decode_metric_cursor(cursor)
            cmp = _lt if sort_dir != "asc" else _gt
            if cursor_metric is None:
                # NULLS LAST 커서 위치 — metric이 NULL인 그룹 안에서만 이어간다(방향
                # 무관 — null 그룹은 asc/desc 어느 쪽이든 항상 맨 뒤).
                query = query.where(
                    metric_col.is_(None)
                    & (
                        cmp(rows_cte.c.published_at, cursor_published_at)
                        | ((rows_cte.c.published_at == cursor_published_at) & cmp(rows_cte.c.publication_id, cursor_id))
                    )
                )
            else:
                query = query.where(
                    metric_col.is_(None)
                    | cmp(metric_col, cursor_metric)
                    | (
                        (metric_col == cursor_metric)
                        & (
                            cmp(rows_cte.c.published_at, cursor_published_at)
                            | ((rows_cte.c.published_at == cursor_published_at) & cmp(rows_cte.c.publication_id, cursor_id))
                        )
                    )
                )
        if sort_dir == "asc":
            query = query.order_by(
                metric_col.asc().nulls_last(), rows_cte.c.published_at.asc(), rows_cte.c.publication_id.asc(),
            )
        else:
            query = query.order_by(
                metric_col.desc().nulls_last(), rows_cte.c.published_at.desc(), rows_cte.c.publication_id.desc(),
            )

    # story #3697(카디르 QA 실결함 + 유나 design 후속 2건, PR#4049, 페드루 PO 確定
    # 2026-09-08) — work_item_id 스코프(한 story의 blog↔social 대조가 목적)에서 flat
    # published_at-desc+단일 LIMIT를 그대로 쓰면 한 kind가 많으면(예: social 51건) 다른
    # kind(blog)가 페이지 밖으로 밀려나 에러 없이 조용히 반쪽만 보인다 — 이 비교뷰의
    # 핵심 목적(양쪽 나란히)이 깨진다.
    #
    # 1차 처방(kind별 상한+has_more)을 유나가 «같은 클래스의 조용한 결손 2건»으로
    # 재차 잡았다:
    # ② 상한 내에서도 잘릴 수 있는데 has_more 하나만으론 "어느 kind가 얼마나 잘렸는지"
    #    화면이 「N건 중 M건」으로 정직하게 못 말한다 — 섹션 수준 배너로만 "일부는 표시
    #    안 됨"을 말하고(유나 § 카피, story-insights-compare-section.tsx), 수는 안 지어
    #    낸다(has_more는 불리언이라 몇 건인지 모른다).
    # ③ 두 kind를 합쳐 재정렬한 결과는 keyset이 아닌데 next_cursor를 내주면 따라간
    #    사람이 틀린 값을 받는다("지금 아무도 안 따라간다"가 계약을 참으로 만들지
    #    않는다) — 이 분기는 next_cursor를 명시적으로 안 낸다(아래).
    #
    # metric 정렬(sort != "published_at") 조합은 이 결함 재현 경로가 아니라(FE
    # 소비처가 항상 published_at 기본값만 씀) 기존 flat 동작을 그대로 둔다.
    if work_item_id is not None and sort == "published_at":
        blog_result = (await db.execute(query.where(rows_cte.c.kind == "site_post").limit(limit + 1))).all()
        social_result = (
            await db.execute(query.where(rows_cte.c.kind == "channel_publication").limit(limit + 1))
        ).all()
        has_more = len(blog_result) > limit or len(social_result) > limit
        combined = blog_result[:limit] + social_result[:limit]
        combined.sort(key=lambda r: (r.published_at, r.publication_id), reverse=(sort_dir != "asc"))
        page = combined
    else:
        query = query.limit(limit + 1)
        result = (await db.execute(query)).all()
        has_more = len(result) > limit
        page = result[:limit]

    # 스냅샷 배치 조회(N+1 회피, assets.py 관례 동형) — 페이지 최대 `limit`건이라
    # publication_id도 최대 그만큼, 행당 스냅샷도 최대 2건이라 이 IN 조회 하나로 충분.
    #
    # story #3746(유나 v5, 2026-09-09) — `superseded`는 여기(원천)에서 기본 배제한다.
    # 화면 넷(보드·상세·MCP 등)이 이 함수가 낸 같은 목록을 부르는데 화면마다 따로
    # 거르면 「동기화」가 아니라 「갈림」이 된다 — 단일화 지점은 이 조회 하나뿐. 재발행이
    # 새 사이클을 열며 회수한 옛 pending/in_progress 행이 여기서 애초에 후보 자체가
    # 안 된다(같은 글의 새 행이 이미 그 자리에 있다 — 사라짐이 아니라 «대체»).
    publication_ids = [r.publication_id for r in page]
    snapshots_by_pub: dict[uuid.UUID, list[InsightSnapshot]] = {}
    if publication_ids:
        snap_rows = (await db.execute(
            select(InsightSnapshot).where(
                InsightSnapshot.publication_id.in_(publication_ids),
                InsightSnapshot.status != "superseded",
            )
        )).scalars().all()
        for snap in snap_rows:
            snapshots_by_pub.setdefault(snap.publication_id, []).append(snap)

    # story #3516 — comments_count 배치(N+1 회피, 위 스냅샷 배치와 동형). site_post
    # 행(kind="site_post")은 애초에 이 스토리 범위 밖(hosted_site 댓글 개념 자체가
    # 없다)이라 null 그대로 — channel_publication 행만 배치 대상.
    from app.services.channel_post_comments import (
        count_comments_by_publication_ids, get_last_collected_at_by_publication_ids,
    )

    channel_pub_ids = [r.publication_id for r in page if r.kind == "channel_publication"]
    comments_count_by_pub = await count_comments_by_publication_ids(db, publication_ids=channel_pub_ids)
    # story #3516 조각②(페드루 PO REQUIRED, 유나양·민 레군 그라운딩) — comments_count
    # =0 하나가 "미수집"·"수집됐는데 0건"·"채널 미제공"을 다 가려 화면이 네 갈래를
    # 못 그린다. 이 두 필드가 그 신호를 판별한다(comments_count의 정의는 그대로 —
    # 이 필드들이 그 0의 뜻을 가른다).
    comments_last_collected_at_by_pub = await get_last_collected_at_by_publication_ids(
        db, publication_ids=channel_pub_ids,
    )
    # story #3766(별건 ⑩, 3746 §3 유나 定) — 발행 명령 상태 배치(N+1 회피, 위 스냅샷·
    # 댓글 배치와 동형). channel_posts.py::list_channel_post_drafts(951-959)와 정확히
    # 같은 패턴 — gate_id로 IN 조회 후 created_at DESC로 gate당 첫 행(=최신)만
    # dict.setdefault로 남긴다. site_post 행은 gate_id가 애초 null(위 UNION 참고)이라
    # 이 배치엔 안 들어가고 command_status도 항상 null — 「발행 명령 축」 자체가
    # site_post 쪽엔 없는 개념이다(이 스토리 스코프 밖, 별건).
    gate_ids = [r.gate_id for r in page if r.gate_id is not None]
    latest_command_by_gate: dict[uuid.UUID, PublicationCommand] = {}
    if gate_ids:
        cmd_rows = (await db.execute(
            select(PublicationCommand)
            .where(PublicationCommand.gate_id.in_(gate_ids))
            .order_by(PublicationCommand.created_at.desc())
        )).scalars().all()
        for c in cmd_rows:
            latest_command_by_gate.setdefault(c.gate_id, c)

    from app.services.channel_adapters import CHANNEL_ADAPTERS

    # story #3656(페드루 PO CHANGES, 2026-09-07) — 소재/훅 배치 조회(N+1 회피, 위
    # 스냅샷·댓글 배치와 동형). 이 UNION 쿼리가 이미 version_id를 실어 오므로
    # (channel_pub_arm, ChannelPublication에서 직접) 추가 조인 0으로 페이지의
    # channel_publication 행 전체 version_id를 모을 수 있다 — 쿼리 수가 페이지
    # 행 수와 무관하게 상수(3)로 고정된다(단건 호출부 _resolve_channel_publication_
    # asset_evidence와 달리 이쪽은 배치 조립 함수를 쓴다, 같은 규칙 재사용).
    version_ids = [r.version_id for r in page if r.kind == "channel_publication" and r.version_id is not None]
    hook_key_by_version, images_by_version, video_by_version = (
        await batch_fetch_channel_post_asset_evidence_sources(db, version_ids=version_ids)
    )

    rows_out = []
    for r in page:
        # due_at은 anchor_at(=published_at) + offset로 스케줄됐다(schedule_insight_
        # snapshots) — published_at과의 일수 차이로 +1일/+7일 버킷을 되짚는다.
        # label_snapshot_offset(insight_snapshots.py) 공유 헬퍼로 뺐다(카디르 발견,
        # PR#4003 — MCP 3651이 이 자리와 별개로 인덱스 기반 라벨링을 갖고 있어 재발행
        # 스냅샷을 오라벨했다, 같은 규칙 한 자리).
        #
        # story #3746(유나 v5, 2026-09-09) — 정밀 근인: label_snapshot_offset이
        # round(초/86400)라 ±12시간이 같은 정수로 접힌다. 재발행 앵커가 12시간
        # 미만으로 움직이면 옛 사이클 행(위에서 이미 superseded는 걸렀지만, captured/
        # failed/unsupported처럼 superseded 전이 대상이 아닌 이력 행은 여전히 후보로
        # 남는다)과 새 행이 같은 라벨로 겹칠 수 있다 — DB 반환 순서에 기대지 않고
        # `due_at`이 더 큰(최신 사이클) 쪽을 결정적으로 우선한다(둘 이상 후보가 실제로
        # 겹치는 경우는 드물지만, 겹칠 때 "어느 쪽이 이기나"가 조회 순서에 달려 있으면
        # 안 된다).
        d1 = d7 = None
        d1_due_at = d7_due_at = None
        for snap in snapshots_by_pub.get(r.publication_id, []):
            label = label_snapshot_offset(due_at=snap.due_at, published_at=r.published_at)
            if label == "1d" and (d1 is None or snap.due_at > d1_due_at):
                d1, d1_due_at = snap, snap.due_at
            elif label == "7d" and (d7 is None or snap.due_at > d7_due_at):
                d7, d7_due_at = snap, snap.due_at
        is_channel_pub = r.kind == "channel_publication"
        adapter = CHANNEL_ADAPTERS.get(r.channel) if is_channel_pub else None
        asset_sha256s, hook_key = assemble_channel_post_asset_evidence(
            r.version_id if is_channel_pub else None,
            hook_key_by_version=hook_key_by_version,
            images_by_version=images_by_version,
            video_by_version=video_by_version,
        )
        rows_out.append({
            "publication_id": r.publication_id, "kind": r.kind, "channel": r.channel,
            "work_item_id": r.work_item_id, "title": r.title, "published_at": r.published_at,
            "external_url": r.external_url, "connection_id": r.connection_id,
            "d1": _snapshot_view(d1), "d7": _snapshot_view(d7),
            # null="이 kind는 댓글 개념이 없다(site_post)"·정수="channel_publication의
            # 지금 안 지워진 댓글 수". 보드는 개요라 «미수집»과 «수집됐는데 0건»을
            # 안 가른다(둘 다 0) — 그 구분은 댓글 목록 API(list_comments_for_publication
            # 의 last_collected_at)의 몫으로 남긴다(정밀도가 필요한 자리는 거기).
            "comments_count": comments_count_by_pub.get(r.publication_id, 0) if is_channel_pub else None,
            # story #3516 조각② — 「댓글 {n}」 링크 목적지(변형 상세). site_post는
            # 별건(민 레군·유나양 그라운딩)이라 항상 null.
            "channel_post_draft_id": r.channel_post_draft_id if is_channel_pub else None,
            # 0의 뜻을 가르는 신호 둘 — comments_count(위)와 정의 재사용, 새 판정 0.
            "comments_last_collected_at": (
                comments_last_collected_at_by_pub.get(r.publication_id) if is_channel_pub else None
            ),
            "comments_supported": bool(adapter is not None and adapter.supports_fetch_replies) if is_channel_pub else False,
            # story #3656 — 소재/훅 묶음(FE group-rows.ts)의 원재료. site_post·소재
            # 0건·hook_key 미기입은 각각 null(소급 백필 없음 — 신규 발행부터만).
            "asset_sha256s": asset_sha256s,
            "hook_key": hook_key,
            # story #3766(별건 ⑩) — 채널 포스트 목록 응답(ChannelPostDraftListItem.
            # command_status)과 같은 이름·같은 뜻(같은 PublicationCommand 행) — 새
            # 낱말 0. site_post 행은 gate_id가 null이라 latest_command_by_gate에
            # 애초 못 들어가 이 조회도 자연히 None.
            "command_status": (
                latest_command_by_gate[r.gate_id].status if r.gate_id in latest_command_by_gate else None
            ),
        })

    # story #3697(유나 § — 「지금 아무도 안 따라간다」가 계약을 참으로 만들지 않는다) —
    # work_item_id 스코프는 두 kind를 각자 조회해 Python에서 합쳐 재정렬한 결과라
    # keyset이 아니다. 그 마지막 행으로 encode_cursor를 내면 "다음 페이지 시작점"으로
    # 읽히는 값이 나오지만, 그 값을 실제로 다음 호출에 넣으면(work_item_id+cursor 조합,
    # 지금 아무도 안 하지만) 커서가 전제하는 keyset 성질(정렬된 단일 스트림의 이어짐)이
    # 성립 안 해 틀린 결과를 준다 — 이 분기는 커서를 아예 안 낸다(has_more만으로
    # "더 있다"는 정직하게 말하고 "이어받는 길"은 비운다).
    is_work_item_scoped_merge = work_item_id is not None and sort == "published_at"
    next_cursor = None
    if has_more and rows_out and not is_work_item_scoped_merge:
        last = page[-1]
        if sort == "published_at":
            next_cursor = encode_cursor(last.published_at, last.publication_id)
        else:
            last_metric = getattr(last, "metric_value", None)
            next_cursor = encode_metric_cursor(last_metric, last.published_at, last.publication_id)

    # story #3746(3734 §4-C) — 기본(제외) 뷰에서만 뜻이 있다. include_deleted=True
    # 뷰(「보관됨 보기」 켠 상태)에서는 이미 다 보이므로 항상 0/무의미(null) — 안 지어낸다.
    hidden_count = None if include_deleted else await _count_hidden_by_archive(
        db, org_id=org_id, channel=channel, since=since,
    )

    return {"rows": rows_out, "has_more": has_more, "next_cursor": next_cursor, "hidden_count": hidden_count}


def _snapshot_view(snap: InsightSnapshot | None) -> dict[str, Any] | None:
    if snap is None:
        return None
    return {"status": snap.status, "normalized": snap.normalized, "captured_at": snap.captured_at}


_FOLLOW_UP_KINDS = frozenset({"republish", "edit", "stop"})
_FOLLOW_UP_TITLE_PREFIX = {"republish": "재발행", "edit": "수정", "stop": "중단"}


class FollowUpPublicationNotFoundError(Exception):
    pass


class FollowUpInvalidKindError(Exception):
    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(f"unsupported follow-up kind: {kind}")


async def _resolve_publication_work_item(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID,
) -> tuple[uuid.UUID, str] | None:
    """publication_id 하나로 site_post·channel_publication 어느 쪽인지 모르는 채
    들어온다(3497 조회 API와 동일 전제) — 순서대로 둘 다 본다. 반환은
    (work_item_id, kind) 또는 None(양쪽 다 없음=타 org/미존재)."""
    site_post = (await db.execute(
        select(SitePost.source_story_id).where(SitePost.id == publication_id, SitePost.org_id == org_id)
    )).scalar_one_or_none()
    if site_post is not None:
        return site_post, "site_post"

    row = (await db.execute(
        select(Gate.work_item_id)
        .select_from(ChannelPublication)
        .join(Gate, Gate.id == ChannelPublication.gate_id)
        .where(ChannelPublication.id == publication_id, ChannelPublication.org_id == org_id)
    )).scalar_one_or_none()
    if row is not None:
        return row, "channel_publication"
    return None


async def create_publication_follow_up(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, kind: str,
    title: str | None, note: str | None, requested_by_member_id: uuid.UUID,
) -> dict[str, Any]:
    """AC2 — 표의 행에서 "재발행/수정/중단" 후속 작업을 만든다. PO 確定 — 그 작업은
    기존 원장의 Story(신규 마케팅 전용 객체 발명 0)다. "중단(stop)"은 예약을
    취소하지 않는다 — 취소 자체는 3467 cancel-scheduled 경로 몫, 여기는 오직
    "중단해야 한다"는 작업 항목만 만든다(발행 상태 무변경)."""
    if kind not in _FOLLOW_UP_KINDS:
        raise FollowUpInvalidKindError(kind)

    resolved = await _resolve_publication_work_item(db, org_id=org_id, publication_id=publication_id)
    if resolved is None:
        raise FollowUpPublicationNotFoundError(publication_id)
    work_item_id, publication_kind = resolved

    story = (await db.execute(
        select(Story).where(Story.id == work_item_id, Story.org_id == org_id)
    )).scalar_one_or_none()
    if story is None:
        raise FollowUpPublicationNotFoundError(publication_id)

    from app.services.insight_snapshots import get_latest_insight_snapshot

    latest = await get_latest_insight_snapshot(db, publication_id=publication_id)
    snapshot_line = (
        f"최근 스냅샷({latest.captured_at.isoformat()}): {latest.normalized}"
        if latest is not None else "최근 스냅샷: 없음"
    )
    body = (
        f"[{_FOLLOW_UP_TITLE_PREFIX[kind]} 후속 작업 — 원문: {story.title}]\n"
        f"publication_id: {publication_id} (kind={publication_kind})\n"
        f"{snapshot_line}"
        + (f"\n\n{note}" if note else "")
    )
    story_title = title or f"[{_FOLLOW_UP_TITLE_PREFIX[kind]}] {story.title}"

    from app.repositories.story import StoryRepository

    new_story = await StoryRepository(db, org_id).create(
        project_id=story.project_id, title=story_title, description=body,
        assignee_id=requested_by_member_id,
    )

    from app.models.evidence import Evidence

    db.add(Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=new_story.id, work_item_type="story",
        type="report", ref=str(new_story.id), source="insights_board",
        note=f"{_FOLLOW_UP_TITLE_PREFIX[kind]} 후속 작업 생성(publication {publication_id})",
        created_by=None,
        payload={
            "kind": "follow_up_created", "follow_up_kind": kind,
            "publication_id": str(publication_id), "story_id": str(new_story.id),
            "recorded_by": "platform",
        },
    ))
    await db.commit()
    await db.refresh(new_story)
    return {"story_id": new_story.id}
