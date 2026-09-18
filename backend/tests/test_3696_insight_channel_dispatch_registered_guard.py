"""story #3696(Phase2·BE·funnel 갭, 디디 e2e 그라운딩 발견 2026-09-08) — 실 사고:
`channel_adapters.py`의 `instagram_sandbox`가 `insight_metrics=("views","reach",
"engagements")`(非빈="이 채널은 insight 수집을 지원한다")를 선언했는데,
`insight_snapshots.py::_fetch_for_snapshot`의 dispatch 분기 목록엔 instagram_sandbox가
없었다("instagram"과 "instagram_sandbox"는 다른 문자열이라 안 걸림) — 매번
INSIGHT_CHANNEL_NOT_IMPLEMENTED로 떨어져 due 스냅샷이 영구 'failed'(재시도 없음)였다.
옆 주석("instagram_sandbox와 달리 facebook_sandbox는...")이 저자가 스스로 «instagram_
sandbox는 이미 있다»고 착각한 자기기만 흔적 — 이게 이 클래스가 위험한 이유(선언과
구현이 갈려도 아무 데도 안 걸린다, 조용한 영구 실패).

⭐AC3(이 스토리의 값) — 「insight_metrics가 非빈인 모든 채널은 _fetch_for_snapshot
dispatch 분기를 가진다」를 구조적으로 대조해 재발을 막는다: 판정은 «어떤 InsightFetchError
가 났는지»다 — INSIGHT_CHANNEL_NOT_IMPLEMENTED(dispatch 자체가 없다는 뜻)가 아니라
다른 에러(또는 성공)가 났으면 실 분기를 탄 것이다. sandbox 계열(SANDBOX_CHANNEL_ENABLED
env-gated)은 이 테스트가 그 env 상태에 흔들리지 않게 실 선언값 그대로 명시 주입한다
(dict 재발명이 아니라 channel_adapters.py 그 값의 사본)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

# channel_adapters.py의 SANDBOX_CHANNEL_ENABLED 게이트 블록 실 선언값 사본(2026-09-08
# 실측) — 이 env가 테스트 프로세스에 없어도 세 sandbox 채널이 항상 커버되게 한다.
_SANDBOX_GATED_INSIGHT_METRICS = {
    "sandbox": ("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"),
    "facebook_sandbox": ("impressions", "reach", "engagements", "clicks", "views"),
    "instagram_sandbox": ("views", "reach", "engagements"),
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _ensure_channel_registered(monkeypatch, adapters_mod, key: str, insight_metrics: tuple[str, ...]) -> None:
    """key가 CHANNEL_ADAPTERS에 없거나(env-gated 미등재) insight_metrics가 실 선언과
    다르면, 실 선언값 그대로 주입한다 — 이미 등재돼 있으면(SANDBOX_CHANNEL_ENABLED=true
    인 프로세스) 손 안 댄다(그 실물을 그대로 쓰는 게 더 정확하다)."""
    existing = adapters_mod.CHANNEL_ADAPTERS.get(key)
    if existing is not None and existing.insight_metrics == insight_metrics:
        return
    cfg = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="x", refresh_mode="manual",
        display_name=key, credential_kind="none", max_text_length=500,
        utm_source=key, utm_medium="test", insight_metrics=insight_metrics,
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, key, cfg)


@pytest.mark.anyio
async def test_every_channel_with_declared_insight_metrics_has_dispatch_branch(monkeypatch):
    """뮤테이션 킬 — instagram_sandbox 분기를 다시 지우면(또는 새 채널이 insight_metrics
    를 선언만 하고 dispatch를 안 넣으면) 이 테스트가 그 channel명을 assert 메시지에
    직접 지목하며 RED로 잡는다."""
    import app.services.channel_adapters as adapters_mod
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import InsightFetchError, _fetch_for_snapshot

    for key, metrics in _SANDBOX_GATED_INSIGHT_METRICS.items():
        _ensure_channel_registered(monkeypatch, adapters_mod, key, metrics)

    declared_channels = [
        key for key, cfg in adapters_mod.CHANNEL_ADAPTERS.items() if cfg.insight_metrics
    ]
    assert set(_SANDBOX_GATED_INSIGHT_METRICS) <= set(declared_channels), (
        "sandbox 계열 주입이 안 먹었다 — 가드 자체가 헛돌고 있다(공허통과 방지)"
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = uuid.uuid4()
            not_implemented: list[str] = []
            for channel in declared_channels:
                snapshot = InsightSnapshot(
                    id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(),
                    publication_id=uuid.uuid4(), publication_kind="channel_publication",
                    channel=channel, due_at=datetime.now(timezone.utc),
                )
                try:
                    await _fetch_for_snapshot(s, snapshot)
                except InsightFetchError as exc:
                    if exc.error_code == "INSIGHT_CHANNEL_NOT_IMPLEMENTED":
                        not_implemented.append(channel)
                except Exception:
                    # 다른 예외(연결 없음 등)도 실 분기를 탔다는 증거 — 이 가드의 관심사가
                    # 아니다(그 분기 내부 정확성은 각 채널 전용 테스트 몫).
                    pass
            assert not_implemented == [], (
                f"insight_metrics 非빈인데 _fetch_for_snapshot dispatch가 없는 채널: {not_implemented}"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_instagram_sandbox_end_to_end_now_captures_not_permanently_failed(monkeypatch):
    """AC1/AC4 회귀 왕복 — instagram_sandbox 발행물의 due 스냅샷이 이제 실제로
    captured된다(고쳐지기 전엔 매번 status='failed'+error_code=
    INSIGHT_CHANNEL_NOT_IMPLEMENTED였다 — test_3497_insight_snapshots.py::
    test_sandbox_end_to_end_captures_all_seven_keys_and_records_evidence와 동형
    패턴). declared_metrics가 3키뿐이라(views/reach/engagements) 나머지 4키는
    null(sandbox 합성값이 7키 다 주더라도 _normalize가 미선언 키를 거른다 —
    story #3696이 아니라 기존 척추 규칙, 회귀 확인만)."""
    import app.services.channel_adapters as adapters_mod
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import (
        NORMALIZED_KEYS, process_due_insight_snapshots, schedule_insight_snapshots,
    )
    from sqlalchemy import select

    _ensure_channel_registered(
        monkeypatch, adapters_mod, "instagram_sandbox", _SANDBOX_GATED_INSIGHT_METRICS["instagram_sandbox"],
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = uuid.uuid4()
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()
            due_soon = datetime.now(timezone.utc) - timedelta(minutes=1)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="channel_publication", channel="instagram_sandbox", external_id=None,
                anchor_at=due_soon - timedelta(days=1),
            )
            await s.commit()

            counts = await process_due_insight_snapshots(s)
            assert counts["captured"] == 1, counts
            assert counts["failed"] == 0, counts

            snapshot = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == publication_id)
            )).scalars().first()
            assert snapshot.status == "captured"
            assert snapshot.error_code is None
            assert set(snapshot.normalized.keys()) == set(NORMALIZED_KEYS)
            for key in ("views", "reach", "engagements"):
                assert snapshot.normalized[key] is not None, f"{key}는 declared_metrics라 값이 있어야 한다"
            for key in ("impressions", "clicks", "spend", "conversions"):
                assert snapshot.normalized[key] is None, f"{key}는 instagram_sandbox 미선언이라 null이어야 한다"
    finally:
        await engine.dispose()
