"""story #3809(Phase3·3-7, 페드루 PO 確定 2026-09-11 17:12Z) — 「고급 보고 첫
출시」 조각 하나: 조직 단위 비용 원장(광고비·생성 비용·X 비용) 첫 API. 블루프린트
§7 「X 비용과 광고비 조직 대시보드 분리 표시」의 실물.

세 축을 한 응답에 모으되 계산·SSOT는 각자 기존 모듈 그대로 재사용한다(신규 기전
발명 0):
- 광고비(ads): `ads_spend_snapshots.py`(story #3806) — 승인된 ads_boost 게이트의
  봉인 예산·캡처 지출·상한 도달(PR11의 `AdsBoostRun.cap_reached_at`).
- 생성 비용(generation): `generation_budget.py`(story #3498) —
  `compute_generation_budget_status`를 그대로 호출(월 합산 계산 재구현 0).
- X 비용: 이 스토리 시점 코드 0(그라운딩 ②에서 이미 확認) — 「미측정」을 0으로
  지어내지 않고 `null`로 예약만 한다(향후 실 원장이 생기면 이 자리에 채운다).

「승인 예산 합·캡처 지출 합·잔여」는 **같은 게이트 집합**(status=="approved")으로
맞춰 계산한다 — 그래야 `remaining = budget_sum - captured_sum`이 그 집합 안에서
정합한다(다른 집합을 섞으면 지어낸 잔여가 된다). paid 일 시계열은 별도 cut(org
전체 역사 — 게이트 현재 상태와 무관하게 「그날 실제로 캡처된 지출」을 그대로
보여준다, 트렌드 조회는 예산 정합이 아니라 사실 나열이 목적)."""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ads_boost_run import AdsBoostRun
from app.models.gate import Gate
from app.models.insight_snapshot import InsightSnapshot
from app.services.ads_spend_snapshots import _ADS_BOOST_GATE_TYPE, _PAID_SOURCE, paid_snapshots_only
from app.services.generation_budget import compute_generation_budget_status


async def get_org_ads_cost_summary(db: AsyncSession, *, org_id: uuid.UUID) -> dict:
    """승인된(status=="approved") ads_boost 게이트 집합 기준 예산·지출·상한. 그
    집합이 비어 있으면(승인된 boost가 org에 0건) 전부 0/None — 지어내지 않는다."""
    gates = (await db.execute(
        select(Gate).where(
            Gate.org_id == org_id, Gate.gate_type == _ADS_BOOST_GATE_TYPE, Gate.status == "approved",
        )
    )).scalars().all()

    sealed_budget_minor_sum = sum(g.sealed_ads_budget_minor or 0 for g in gates)

    publication_ids = [uuid.UUID(g.scope_key) for g in gates if g.scope_key]
    captured_spend_minor_sum = 0
    if publication_ids:
        # story #3806 가드(test_3806_organic_snapshots_only_guard.py) 처방(페드루
        # PO 지적 2026-09-11 17:44Z) — 손으로 InsightSnapshot을 직접 필터하지 않고
        # `paid_snapshots_only()`(채널 기반, 캡처 여부 무관하게 항상 정확)를 그대로
        # 쓴다. `status=="captured"`를 같이 걸어 "이미 캡처된 것"만 합산.
        snapshots = (await db.execute(
            paid_snapshots_only(select(InsightSnapshot).where(
                InsightSnapshot.org_id == org_id, InsightSnapshot.publication_id.in_(publication_ids),
                InsightSnapshot.status == "captured",
            ))
        )).scalars().all()
        captured_spend_minor_sum = sum((s.normalized or {}).get("spend") or 0 for s in snapshots)

    gate_ids = [g.id for g in gates]
    cap_reached_count = 0
    if gate_ids:
        runs = (await db.execute(
            select(AdsBoostRun).where(AdsBoostRun.gate_id.in_(gate_ids), AdsBoostRun.cap_reached_at.isnot(None))
        )).scalars().all()
        cap_reached_count = len(runs)

    return {
        "approved_boost_count": len(gates),
        "sealed_budget_minor": sealed_budget_minor_sum,
        "captured_spend_minor": captured_spend_minor_sum,
        "remaining_minor": sealed_budget_minor_sum - captured_spend_minor_sum,
        "cap_reached_count": cap_reached_count,
    }


async def get_org_paid_spend_daily_series(db: AsyncSession, *, org_id: uuid.UUID) -> list[dict]:
    """org 전체 캡처된 paid 지출을 날짜(캡처일 UTC)별로 합산 — 예산 정합용이 아닌
    트렌드 열람용이라 게이트 현재 status와 무관하게 「그날 실제로 캡처된」 사실을
    그대로 낸다(과거 지출은 게이트가 그 뒤 재오픈/종료돼도 안 사라진다). due_at이
    아니라 `captured_at`으로 가른다 — due_at은 +1d/+7d 스케줄링 anchor일 뿐 실제
    수집 시각이 아니다(ads_spend_snapshots.py 모듈 docstring과 동형 구분)."""
    rows = (await db.execute(
        paid_snapshots_only(select(InsightSnapshot.captured_at, InsightSnapshot.normalized).where(
            InsightSnapshot.org_id == org_id,
            InsightSnapshot.status == "captured", InsightSnapshot.captured_at.isnot(None),
        ))
    )).all()

    by_day: dict[str, int] = defaultdict(int)
    for captured_at, normalized in rows:
        day = captured_at.date().isoformat()
        by_day[day] += (normalized or {}).get("spend") or 0

    # 이 함수가 이미 `source == _PAID_SOURCE`로만 걸러 왔으니 매 항목의 값은
    # 자명하게 "paid"다 — classify_insight_source()를 가짜 채널 인자로 부르는
    # 대신 그 상수를 직접 쓴다(그 함수는 원채널→분류가 필요한 자리 전용).
    return [
        {"date": day, "spend_minor": spend, "source": _PAID_SOURCE}
        for day, spend in sorted(by_day.items())
    ]


async def get_org_cost_summary(db: AsyncSession, *, org_id: uuid.UUID, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    ads = await get_org_ads_cost_summary(db, org_id=org_id)
    generation = await compute_generation_budget_status(db, org_id=org_id, now=now)
    daily_series = await get_org_paid_spend_daily_series(db, org_id=org_id)

    return {
        "ads": ads,
        # story #3498 규칙이 org에 없으면 None("규칙 없음"과 "0 지출"을 뭉개지
        # 않는다 — compute_generation_budget_status 자신의 계약 그대로).
        "generation_cost_spent_minor": generation["spent_minor"] if generation is not None else None,
        "generation_cost_period_start": generation["period_start"] if generation is not None else None,
        "generation_cost_period_end": generation["period_end"] if generation is not None else None,
        # story #3809 그라운딩②(2026-09-11) — X 비용 원장 자체가 이 시점 코드에
        # 없다(실측 확認). "0"으로 지어내지 않고 미측정을 null로 예약만 한다.
        "x_cost_spent_minor": None,
        "paid_spend_daily_series": daily_series,
    }
