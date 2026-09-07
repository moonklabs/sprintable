"""story #3618(BE+FE·실측, 페드루 PO 確定 2026-09-07) — 블루프린트 v3 §7 Phase 2
「실측」 열 3종을 제품이 스스로 센다: UTM 귀속률·댓글 누락률·후속 작업 생성률.
계측 없이는 완료 판정을 PO 손셈으로만 할 수 있었다(AARRR 렌즈 — 「미측정」이 1급
답, 계측 장치가 없으면 그 장치가 스토리).

페드루 PO CHANGES(2026-09-07, 유나 낱말 판정) — 모듈명·엔드포인트를 `phase2_
metrics`/`phase2-metrics`에서 `measured_metrics`/`measured-metrics`로 옮겼다
(이름에 "Phase 2" 같은 블루프린트 내부 단계명을 넣지 않는다 — 단계가 끝나면
이름이 거짓이 되는 클래스). 응답 필드(`utm_attribution_rate` 등)는 그대로
(additive 계약 불변).

세 정의(실물 대조 확定, PR 본문 첫 절과 동일):

1. **UTM 귀속률** = 기간 내 SUM(org_pageview_utm_daily.count WHERE utm_source·
   utm_medium·utm_campaign 셋 다 비어있지 않음) / SUM(org_pageview_daily.count) —
   전자가 후자의 부분집합(`pageview_counter.py::record_pageview`가 모든 hit에
   대해, `record_pageview_utm`이 UTM 있는 hit에 대해서만 호출되는 것이 그라운딩
   실물). 분모 0이면 「—」(NO_PAGEVIEWS).

2. **댓글 누락률** = 기간 내 `channel_post_comment_collection_schedule.status=
   'captured'`이고 `channel_reported_comment_count IS NOT NULL`인 행 중, 발행별
   **가장 최근** 행 하나만(같은 발행을 중복 반영 안 함)을 모아 SUM(max(0,
   channel_reported - stored))/SUM(channel_reported) — pooled 비율(발행마다
   가중치를 그 발행의 실제 댓글 규모로 주는 형, "발행별 비율의 단순평균"보다
   소규모 발행의 노이즈에 덜 흔들린다 — 구현자 확定). `stored`는 현재 시점
   `channel_post_comments`(deleted_at IS NULL) 카운트(그 수집 시점 스냅샷이
   아니라 "지금 저장돼 있는 수" — 이후 삭제 리컨실이 반영된 최신 상태가 더
   정직하다는 판단). 채널이 원본 수를 준 발행이 기간 내 하나도 없으면 「—」
   (NO_COMMENT_DATA).

3. **후속 작업 생성률** = 기간 내 `insight_snapshots.status='captured'`인 행이
   가리키는 **서로 다른** publication_id 집합(분모) 중, 그 발행을 참조하는
   Evidence(`create_publication_follow_up`의 `payload.publication_id` 직접
   매치 **또는** `create_comment_follow_up`의 `payload.comment_id`가 가리키는
   댓글의 publication_id 간접 매치)가 하나라도 있는 것의 비율(분자). 분모 0이면
   「—」(NO_SNAPSHOTS) — 분자 0은 「—」가 아니라 진짜 0(만든 적 없음이 사실,
   AC 명시)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_post_comment import ChannelPostComment
from app.models.channel_post_comment import CommentCollectionSchedule
from app.models.channel_publication_reconciliation import ChannelPublicationReconciliation
from app.models.evidence import Evidence
from app.models.insight_snapshot import InsightSnapshot
from app.models.org_pageview_daily import OrgPageviewDaily
from app.models.org_pageview_utm_daily import OrgPageviewUtmDaily


def _empty_metric(reason_code: str) -> dict[str, Any]:
    return {"value": None, "numerator": 0, "denominator": 0, "reason_code": reason_code}


async def _compute_utm_attribution_rate(db: AsyncSession, *, org_id: uuid.UUID, start_date) -> dict[str, Any]:
    denominator = (await db.execute(
        select(func.coalesce(func.sum(OrgPageviewDaily.count), 0)).where(
            OrgPageviewDaily.org_id == org_id, OrgPageviewDaily.day >= start_date,
        )
    )).scalar_one()
    if denominator == 0:
        return _empty_metric("NO_PAGEVIEWS")

    numerator = (await db.execute(
        select(func.coalesce(func.sum(OrgPageviewUtmDaily.count), 0)).where(
            OrgPageviewUtmDaily.org_id == org_id, OrgPageviewUtmDaily.day >= start_date,
            OrgPageviewUtmDaily.utm_source != "", OrgPageviewUtmDaily.utm_medium != "",
            OrgPageviewUtmDaily.utm_campaign != "",
        )
    )).scalar_one()
    return {
        "value": numerator / denominator, "numerator": int(numerator), "denominator": int(denominator),
        "reason_code": None,
    }


async def _compute_comment_miss_rate(
    db: AsyncSession, *, org_id: uuid.UUID, period_start: datetime,
) -> dict[str, Any]:
    # 발행별 "기간 내 가장 최근" captured 행 하나만 — 같은 발행이 기간 내 여러 번
    # 수집됐어도 중복 반영하지 않는다(DISTINCT ON, publication_id 축).
    latest_per_publication = (
        select(
            CommentCollectionSchedule.publication_id,
            func.max(CommentCollectionSchedule.captured_at).label("latest_captured_at"),
        )
        .where(
            CommentCollectionSchedule.org_id == org_id,
            CommentCollectionSchedule.status == "captured",
            CommentCollectionSchedule.channel_reported_comment_count.is_not(None),
            CommentCollectionSchedule.captured_at >= period_start,
        )
        .group_by(CommentCollectionSchedule.publication_id)
        .subquery()
    )
    rows = (await db.execute(
        select(CommentCollectionSchedule.publication_id, CommentCollectionSchedule.channel_reported_comment_count)
        .join(
            latest_per_publication,
            and_(
                CommentCollectionSchedule.publication_id == latest_per_publication.c.publication_id,
                CommentCollectionSchedule.captured_at == latest_per_publication.c.latest_captured_at,
            ),
        )
        .where(CommentCollectionSchedule.org_id == org_id)
    )).all()

    if not rows:
        return _empty_metric("NO_COMMENT_DATA")

    total_reported = 0
    total_missing = 0
    for publication_id, channel_reported_comment_count in rows:
        if channel_reported_comment_count is None or channel_reported_comment_count <= 0:
            continue
        stored_count = (await db.execute(
            select(func.count()).select_from(ChannelPostComment).where(
                ChannelPostComment.publication_id == publication_id, ChannelPostComment.deleted_at.is_(None),
            )
        )).scalar_one()
        total_reported += channel_reported_comment_count
        total_missing += max(0, channel_reported_comment_count - stored_count)

    if total_reported == 0:
        # 모든 행이 channel_reported_comment_count<=0(채널이 "0건"이라 말한 경우들뿐)
        # — 누락을 잴 분모가 없다(0/0은 "누락 없음"이 아니라 "잴 게 없음").
        return _empty_metric("NO_COMMENT_DATA")

    return {
        "value": total_missing / total_reported, "numerator": total_missing, "denominator": total_reported,
        "reason_code": None,
    }


async def _captured_snapshot_publication_ids(
    db: AsyncSession, *, org_id: uuid.UUID, period_start: datetime,
) -> list[uuid.UUID]:
    """기간 내 captured 스냅샷이 있는 발행 집합 — follow_up_creation_rate·
    reconciliation_coverage_rate 두 지표가 같은 분모를 쓴다(둘 다 "이 기간에 실측
    스냅샷이 잡힌 발행"을 모집단으로 삼는 정의, story #3620이 #3618의 분모를
    재사용)."""
    return (await db.execute(
        select(InsightSnapshot.publication_id).where(
            InsightSnapshot.org_id == org_id, InsightSnapshot.status == "captured",
            InsightSnapshot.captured_at.is_not(None), InsightSnapshot.captured_at >= period_start,
        ).distinct()
    )).scalars().all()


async def _compute_follow_up_creation_rate(
    db: AsyncSession, *, org_id: uuid.UUID, period_start: datetime,
) -> dict[str, Any]:
    publication_ids = await _captured_snapshot_publication_ids(db, org_id=org_id, period_start=period_start)

    denominator = len(publication_ids)
    if denominator == 0:
        return _empty_metric("NO_SNAPSHOTS")

    # comment_id → publication_id 간접 매치를 위한 조회(그 코멘트가 이 org 소속인
    # 발행 중 하나를 가리키는지만 보면 되므로 publication_ids 집합으로 좁힌다).
    comment_id_to_publication = dict((await db.execute(
        select(ChannelPostComment.id, ChannelPostComment.publication_id).where(
            ChannelPostComment.publication_id.in_(publication_ids),
        )
    )).all())

    direct_matches = set((await db.execute(
        select(Evidence.payload["publication_id"].astext).where(
            Evidence.org_id == org_id, Evidence.type == "report",
            Evidence.payload["publication_id"].astext.in_([str(p) for p in publication_ids]),
        )
    )).scalars().all())

    referenced_publication_ids: set[str] = {str(p) for p in direct_matches}
    if comment_id_to_publication:
        comment_ids_referenced = set((await db.execute(
            select(Evidence.payload["comment_id"].astext).where(
                Evidence.org_id == org_id, Evidence.type == "report",
                Evidence.payload["comment_id"].astext.in_([str(c) for c in comment_id_to_publication]),
            )
        )).scalars().all())
        for comment_id_str in comment_ids_referenced:
            try:
                comment_id = uuid.UUID(comment_id_str)
            except ValueError:
                continue
            pub_id = comment_id_to_publication.get(comment_id)
            if pub_id is not None:
                referenced_publication_ids.add(str(pub_id))

    numerator = sum(1 for p in publication_ids if str(p) in referenced_publication_ids)
    return {
        "value": numerator / denominator, "numerator": numerator, "denominator": denominator,
        "reason_code": None,
    }


async def _compute_reconciliation_coverage_rate(
    db: AsyncSession, *, org_id: uuid.UUID, period_start: datetime,
) -> dict[str, Any]:
    """정의 2(story #3620) — 분모는 follow_up_creation_rate와 동형(기간 내 captured
    스냅샷이 있는 발행 집합). 분자는 그중 기간 내 대조 기록(reconciliation)이
    1건이라도 있는 발행 수. 분모 0이면 「—」(NO_SNAPSHOTS, follow_up_creation_rate와
    같은 사유 코드 재사용 — 같은 분모니 같은 미측정 이유)."""
    publication_ids = await _captured_snapshot_publication_ids(db, org_id=org_id, period_start=period_start)
    denominator = len(publication_ids)
    if denominator == 0:
        return _empty_metric("NO_SNAPSHOTS")

    reconciled_publication_ids = set((await db.execute(
        select(ChannelPublicationReconciliation.publication_id).where(
            ChannelPublicationReconciliation.org_id == org_id,
            ChannelPublicationReconciliation.created_at >= period_start,
            ChannelPublicationReconciliation.publication_id.in_(publication_ids),
        ).distinct()
    )).scalars().all())

    numerator = sum(1 for p in publication_ids if p in reconciled_publication_ids)
    return {
        "value": numerator / denominator, "numerator": numerator, "denominator": denominator,
        "reason_code": None,
    }


async def _compute_reconciliation_mismatch_rate(
    db: AsyncSession, *, org_id: uuid.UUID, period_start: datetime,
) -> dict[str, Any]:
    """정의 3(story #3620) — 「불일치 수」를 카드 형(퍼센트) 계약에 맞춰 비율로
    낸다: 분모=기간 내 대조 기록이 1건이라도 있는 발행 수, 분자=그중 하나라도
    mismatch였던 발행 수(has_mismatch 비정규화 컬럼 재사용 — verdicts JSONB
    스캔 0). 분모 0(대조를 아무도 아직 안 눌렀음)이면 「—」(NO_RECONCILIATIONS)
    — 분자 0(눌렀는데 전부 일치)은 「—」가 아니라 진짜 0."""
    rows = (await db.execute(
        select(ChannelPublicationReconciliation.publication_id, ChannelPublicationReconciliation.has_mismatch)
        .where(
            ChannelPublicationReconciliation.org_id == org_id,
            ChannelPublicationReconciliation.created_at >= period_start,
        )
    )).all()

    mismatch_by_publication: dict[uuid.UUID, bool] = {}
    for publication_id, has_mismatch in rows:
        mismatch_by_publication[publication_id] = mismatch_by_publication.get(publication_id, False) or has_mismatch

    denominator = len(mismatch_by_publication)
    if denominator == 0:
        return _empty_metric("NO_RECONCILIATIONS")

    numerator = sum(1 for v in mismatch_by_publication.values() if v)
    return {
        "value": numerator / denominator, "numerator": numerator, "denominator": denominator,
        "reason_code": None,
    }


async def compute_measured_metrics(db: AsyncSession, *, org_id: uuid.UUID, days: int) -> dict[str, Any]:
    """AC1 — days는 7|30(호출부가 검증). 「기간」은 오늘을 포함한 N일(오늘·어제·
    …·N-1일 전) — `pageview_counter.py::get_beacon_status`의 count_7d와 동일
    off-by-one 규약(페드루 PO REQUIRED 2026-09-06, #3895 리뷰 그대로 재사용)."""
    now = datetime.now(timezone.utc)
    start_date = (now - timedelta(days=days - 1)).date()
    period_start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)

    utm = await _compute_utm_attribution_rate(db, org_id=org_id, start_date=start_date)
    comment_miss = await _compute_comment_miss_rate(db, org_id=org_id, period_start=period_start)
    follow_up = await _compute_follow_up_creation_rate(db, org_id=org_id, period_start=period_start)
    reconciliation_coverage = await _compute_reconciliation_coverage_rate(db, org_id=org_id, period_start=period_start)
    reconciliation_mismatch = await _compute_reconciliation_mismatch_rate(db, org_id=org_id, period_start=period_start)

    return {
        "utm_attribution_rate": utm,
        "comment_miss_rate": comment_miss,
        "follow_up_creation_rate": follow_up,
        # story #3620(additive — 기존 3키·응답 형은 불변) — 4번째 실측 열.
        "reconciliation_coverage_rate": reconciliation_coverage,
        "reconciliation_mismatch_rate": reconciliation_mismatch,
        "computed_at": now,
    }
