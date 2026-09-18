"""story #3620(Phase2·BE+FE·실측·4열, 페드루 PO 確定 2026-09-07) — 「채널 원본
지표와 evidence 대조」. §7 Phase 2 실측 열 3618이 범위 밖으로 남긴 4번째 제품 몫.

세 정의(PR 본문 첫 절과 동일):

1. **대조 1건** = 발행 1개에 대해 "지금" 채널 어댑터를 재조회한 raw/정규화 값
   (`insight_snapshots.py::_fetch_for_snapshot`+`_normalize` 그대로 재사용 — 새
   조회·정규화 로직 0, 예약 스냅샷과 같은 값을 낸다는 게 이 재사용의 요점)과
   그 발행의 "최신 captured 스냅샷"(`get_latest_insight_snapshot`) 정규화 값을
   지표별로 비교한다. 지표는 `insight_snapshots.NORMALIZED_KEYS`의 첫 7개만
   (GA4 inflow_* 3키는 범위 밖 — 채널 어댑터 재조회 경로가 안 건드리는 값).
   판정: **단조증가 5종**(impressions/reach/views/engagements/clicks) — 실측치는
   시간이 지나 줄어들 수 없으므로 `stored<=live`면 match, `stored>live`면
   mismatch(저장값이 원본보다 큰 건 저장이 잘못됐다는 뜻). **정확값 2종**(spend/
   conversions) — 0-tolerance 동등 비교. 둘 중 하나라도 None(스냅샷이 아예 없거나
   그 채널이 그 지표를 선언 안 함)이면 "unmeasured"(해석하지 않는다, AC 명시).
   최신 스냅샷이 아예 없으면 7개 전부 unmeasured로 기록(비교할 저장값 자체가
   없다 — 실패가 아니라 "이번엔 비교 대상이 없었다"는 정직한 기록).

2. **연결 비활성/채널 미지원** = story #3612와 같은 「막는 쪽」 원칙 — 선검사
   실패는 채널에 대한 새 증거가 아니므로 승격도 기록(reconciliation 행)도 대상이
   아니다. `_PRECHECK_ERROR_CODES` 3종(연결 비활성·발행 못 찾음·채널 미지원)은
   그대로 호출자에게 전파(HTTP 409)하고 끝 — `InsightFetchError`를 재사용한다
   (새 예외 타입 0).

3. **사람·에이전트 동형** = `reconcile_publication()` 하나가 유일한 통로. 인증
   컨텍스트 밖(member_id)만 받고, 호출자가 사람인지 에이전트인지 이 함수는
   모른다(AC4 핵심 — 별도 actor_type 분기 0)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_publication_reconciliation import ChannelPublicationReconciliation
from app.models.insight_snapshot import InsightSnapshot
from app.services.insight_snapshots import (
    InsightFetchError,
    _fetch_for_snapshot,
    _normalize,
    _promote_connection_status_for_snapshot,
    get_latest_insight_snapshot,
)

# story #3612와 동형(그라운딩 그대로 재사용) — 이 3종은 채널을 실제로 부르기 前
# 로컬 상태만으로 걸러지는 실패라 "채널에 대한 새 증거"가 아니다. 승격도 기록도
# 대상이 아니고, 호출자에게 그대로 전파한다.
_PRECHECK_ERROR_CODES = frozenset({
    "CHANNEL_CONNECTION_NOT_ACTIVE", "INSIGHT_PUBLICATION_NOT_FOUND", "INSIGHT_CHANNEL_NOT_IMPLEMENTED",
})

# NORMALIZED_KEYS의 첫 7개만(GA4 inflow_* 3키는 범위 밖 — 모듈 docstring 정의 1).
_MONOTONIC_KEYS = ("impressions", "reach", "views", "engagements", "clicks")
_EQUALITY_KEYS = ("spend", "conversions")
RECONCILE_KEYS = _MONOTONIC_KEYS + _EQUALITY_KEYS


def _verdict_for_metric(*, stored: int | None, live: int | None, monotonic: bool) -> str:
    if stored is None or live is None:
        return "unmeasured"
    if monotonic:
        return "match" if stored <= live else "mismatch"
    return "match" if stored == live else "mismatch"


async def reconcile_publication(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, requested_by_member_id: uuid.UUID,
) -> ChannelPublicationReconciliation:
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_adapters import CHANNEL_ADAPTERS
    from app.services.publication_command import FAILURE_KIND_CONNECTION, classify_failure_kind

    pub = (await db.execute(
        select(ChannelPublication).where(
            ChannelPublication.id == publication_id, ChannelPublication.org_id == org_id,
        )
    )).scalar_one_or_none()
    if pub is None:
        raise InsightFetchError(
            error_code="INSIGHT_PUBLICATION_NOT_FOUND",
            message=f"channel_publication을 찾을 수 없습니다: {publication_id}",
        )

    adapter = CHANNEL_ADAPTERS.get(pub.channel)
    declared = adapter.insight_metrics if adapter is not None else ()
    if not declared:
        raise InsightFetchError(
            error_code="INSIGHT_CHANNEL_NOT_IMPLEMENTED",
            message=f"이 채널은 실측 대조를 지원하지 않습니다: {pub.channel}",
        )

    # _fetch_for_snapshot dispatch가 읽는 필드만 채운 transient 객체 — 저장 안 함
    # (db.add() 0회, story #3620 그라운딩: insight_snapshots.py와 완전히 같은
    # dispatch·정규화를 새 로직 없이 재사용하기 위한 파라미터 캐리어일 뿐).
    transient = InsightSnapshot(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, publication_kind="channel_publication",
        work_item_id=uuid.uuid4(), channel=pub.channel, due_at=datetime.now(timezone.utc), status="pending",
    )

    try:
        # story #3620 2차 CHANGES(페드루 2026-09-11) — 이 호출만 live=True. sandbox
        # 계열 3채널은 [sandbox:insight-drift] 마커가 있으면 이 축에서만 드리프트가
        # 걸려(예약 캡처는 항상 원값) captured>live 진짜 mismatch가 라이브에서 선다.
        result = await _fetch_for_snapshot(db, transient, live=True)
    except InsightFetchError as exc:
        if exc.error_code in _PRECHECK_ERROR_CODES:
            raise
        # 여기까지 왔다는 건 실제로 채널을 불렀고 채널이 지금 막 실패를 알려준
        # 것 — #3612 정의 2와 반대(새 증거), 기존 스케줄 tick과 동형으로 승격.
        if classify_failure_kind(exc.error_code) == FAILURE_KIND_CONNECTION:
            await _promote_connection_status_for_snapshot(
                db, transient, error_code=exc.error_code, message=str(exc),
            )
            await db.commit()
        raise

    live_normalized = _normalize(declared_metrics=declared, values=result["values"])

    snapshot = await get_latest_insight_snapshot(db, publication_id=publication_id)
    stored_normalized: dict = (snapshot.normalized or {}) if snapshot is not None else {}

    verdicts = {
        key: _verdict_for_metric(
            stored=stored_normalized.get(key), live=live_normalized.get(key), monotonic=key in _MONOTONIC_KEYS,
        )
        for key in RECONCILE_KEYS
    }
    has_mismatch = any(v == "mismatch" for v in verdicts.values())

    record = ChannelPublicationReconciliation(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id,
        snapshot_id=snapshot.id if snapshot is not None else None,
        live_raw=result["raw"], verdicts=verdicts, has_mismatch=has_mismatch,
        requested_by_member_id=requested_by_member_id,
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return record
