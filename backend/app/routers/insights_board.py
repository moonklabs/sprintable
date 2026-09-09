"""story #3502(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 성과 보드 API. GET은
publishing_metrics.py·insight_snapshots.py와 동형 권한 축(org 멤버 누구나 — 휴먼·
에이전트 모두, write 없음). POST(후속 작업 생성)는 campaigns.py::_require_human과
동형 — 휴먼 전용(에이전트는 표를 보고 제안만 할 뿐 스토리를 직접 못 만든다)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.insights_board import (
    FollowUpInvalidKindError,
    FollowUpPublicationNotFoundError,
    InsightsBoardInvalidSortError,
    InsightsBoardInvalidWindowError,
    create_publication_follow_up,
    list_insights_board,
)
from app.services.insight_snapshots import InsightFetchError
from app.services.measured_metrics import compute_measured_metrics
from app.services.member_resolver import resolve_member
from app.services.publication_reconciliation import reconcile_publication

router = APIRouter(prefix="/api/v2/organizations", tags=["insights-board"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """campaigns.py::_require_human과 동형 — 추가 role 제한 없음(org 멤버인 휴먼이면
    누구나), 에이전트는 403."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "FOLLOW_UP_CREATE_HUMAN_ONLY",
                "message": "후속 작업 생성은 휴먼 멤버만 가능합니다(에이전트는 조회만).",
            },
        )
    return resolved


class InsightSnapshotBucketView(BaseModel):
    status: str
    normalized: dict[str, int | None] | None
    captured_at: datetime | None


class InsightsBoardRow(BaseModel):
    publication_id: uuid.UUID
    kind: Literal["site_post", "channel_publication"]
    channel: str
    work_item_id: uuid.UUID
    title: str
    published_at: datetime
    external_url: str | None
    connection_id: uuid.UUID | None
    d1: InsightSnapshotBucketView | None
    d7: InsightSnapshotBucketView | None
    # story #3516 — null="site_post(댓글 개념 없음)"·정수="channel_publication의 지금
    # 댓글 수"(미수집·0건 둘 다 0 — 정밀 구분은 댓글 목록 API 몫).
    comments_count: int | None = None
    # story #3516 조각②(페드루 PO REQUIRED, 유나양·민 레군 그라운딩) — comments_count
    # =0의 뜻을 가르는 신호 셋. site_post 행은 셋 다 null/false.
    channel_post_draft_id: uuid.UUID | None = None
    comments_last_collected_at: datetime | None = None
    comments_supported: bool = False
    # story #3656(Phase2·FE+BE, 페드루 PO 確定 2026-09-07) — 3645(#4002)의
    # _resolve_channel_publication_asset_evidence를 list_insights_board가 재사용해
    # 「지금」 값을 싣는다(evidence 조인 아님 — version 행 불변 전제로 보드의
    # 「지금」과 evidence의 「스냅샷 시점」이 같다, BE PO 確定). site_post·소재
    # 0건·hook_key 미기입은 각각 null.
    asset_sha256s: list[str] | None = None
    hook_key: str | None = None


class InsightsBoardResponse(BaseModel):
    rows: list[InsightsBoardRow]
    has_more: bool
    next_cursor: str | None
    # story #3746(3734 §4-C) — 초안 1개 보관이 언어별 발행 행 N개를 한꺼번에 숨길 수
    # 있다(work_item_id 조인, lang은 그 유니크 밖). include_deleted=True(「보관됨 보기」)
    # 뷰에서는 무의미해 null.
    hidden_count: int | None = None


class MeasuredMetricValue(BaseModel):
    value: float | None
    numerator: int
    denominator: int
    reason_code: str | None


class MismatchCountValue(BaseModel):
    """story #3620 CHANGES(2026-09-07, 페드루 PO·유나 낱말 판정) — 「불일치 수」는
    스토리 정의 3 그대로 수(count)다. MeasuredMetricValue의 분모/분자 형은 비율
    지표 전용이라 여기엔 안 맞는다(억지로 끼워 맞추면 "3/12"류 분수로 잘못 읽힌다)."""
    value: int | None
    reason_code: str | None


class MeasuredMetricsResponse(BaseModel):
    utm_attribution_rate: MeasuredMetricValue
    comment_miss_rate: MeasuredMetricValue
    follow_up_creation_rate: MeasuredMetricValue
    # story #3620(additive) — 「채널 원본 지표와 evidence 대조」 4열.
    reconciliation_coverage_rate: MeasuredMetricValue
    reconciliation_mismatch_count: MismatchCountValue
    computed_at: datetime


class ReconciliationResponse(BaseModel):
    id: uuid.UUID
    publication_id: uuid.UUID
    snapshot_id: uuid.UUID | None
    live_raw: dict[str, Any]
    verdicts: dict[str, str]
    has_mismatch: bool
    created_at: datetime


@router.get("/{org_id}/insights-board", response_model=InsightsBoardResponse)
async def get_insights_board_endpoint(
    org_id: uuid.UUID,
    window: str = Query(default="30d"),
    channel: str | None = Query(default=None),
    status: str | None = Query(default=None),
    sort: str = Query(default="published_at"),
    sort_dir: str = Query(default="desc"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    # story #bf290f69 — story별 성과 대조(blog+social 발행물을 한 story로 좁혀 보기).
    work_item_id: uuid.UUID | None = Query(default=None),
    include_deleted: bool = Query(
        default=False,
        description="story #3734 AC3 후속(PO 라이브 판정 2026-09-09) — true면 원 초안이 "
        "보관된(deleted_at not null) 발행분도 포함한다. 목록 두 곳(site-posts·"
        "channel-posts drafts)과 같은 파라미터명·같은 뜻 — 기본은 제외.",
    ),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> InsightsBoardResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        result = await list_insights_board(
            db, org_id=org_id, window=window, channel=channel, status=status,
            sort=sort, sort_dir=sort_dir, cursor=cursor, limit=limit,
            work_item_id=work_item_id, include_deleted=include_deleted,
        )
    except InsightsBoardInvalidWindowError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "INSIGHTS_BOARD_INVALID_WINDOW", "message": f"window must be 7d, 30d or 90d: {exc}"},
        ) from exc
    except InsightsBoardInvalidSortError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "INSIGHTS_BOARD_INVALID_SORT", "message": str(exc)},
        ) from exc
    return InsightsBoardResponse(**result)


class CreateFollowUpRequest(BaseModel):
    kind: Literal["republish", "edit", "stop"]
    title: str | None = None
    note: str | None = None


class FollowUpCreateResponse(BaseModel):
    story_id: uuid.UUID


@router.post(
    "/{org_id}/publications/{publication_id}/follow-ups", response_model=FollowUpCreateResponse, status_code=201,
)
async def create_publication_follow_up_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    body: CreateFollowUpRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> FollowUpCreateResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id)

    try:
        result = await create_publication_follow_up(
            db, org_id=org_id, publication_id=publication_id, kind=body.kind,
            title=body.title, note=body.note, requested_by_member_id=resolved.id,
        )
    except FollowUpPublicationNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"publication을 찾을 수 없습니다: {exc}") from exc
    except FollowUpInvalidKindError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "FOLLOW_UP_INVALID_KIND", "message": str(exc)},
        ) from exc
    return FollowUpCreateResponse(**result)


@router.post(
    "/{org_id}/publications/{publication_id}/reconcile", response_model=ReconciliationResponse, status_code=201,
)
async def reconcile_publication_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ReconciliationResponse:
    """story #3620 AC4 — follow-ups와 달리 휴먼 전용 게이트 0(사람·에이전트 동형,
    `_require_human` 안 탄다). 연결 비활성/채널 미지원(정의 2·로컬 선검사)은 409로
    그대로 전파 — 승격도 reconciliation 행도 안 남긴다(#3612 원칙 재사용)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await resolve_member(auth, org_id, db)

    try:
        record = await reconcile_publication(
            db, org_id=org_id, publication_id=publication_id, requested_by_member_id=resolved.id,
        )
    except InsightFetchError as exc:
        raise HTTPException(
            status_code=409, detail={"code": exc.error_code, "message": str(exc)},
        ) from exc
    return ReconciliationResponse(
        id=record.id, publication_id=record.publication_id, snapshot_id=record.snapshot_id,
        live_raw=record.live_raw, verdicts=record.verdicts, has_mismatch=record.has_mismatch,
        created_at=record.created_at,
    )


@router.get("/{org_id}/insights/measured-metrics", response_model=MeasuredMetricsResponse)
async def get_measured_metrics_endpoint(
    org_id: uuid.UUID,
    days: int = Query(default=7),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> MeasuredMetricsResponse:
    """story #3618 — 블루프린트 §7 Phase 2 실측 열 3종. GET(read)이라 인증만(휴먼·
    에이전트 모두, get_insights_board_endpoint와 동형 권한 폭)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if days not in (7, 30):
        raise HTTPException(
            status_code=422,
            detail={"code": "MEASURED_METRICS_INVALID_DAYS", "message": "days는 7 또는 30만 허용합니다."},
        )
    result = await compute_measured_metrics(db, org_id=org_id, days=days)
    return MeasuredMetricsResponse(**result)
