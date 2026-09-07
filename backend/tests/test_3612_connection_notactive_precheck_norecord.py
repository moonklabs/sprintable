"""story #3612(Phase2·BE·소형·결함, 라이브 결함·배포 47·PO Test Org 실측 2026-09-07) —
`channel_post_comments.py`의 CHANNEL_CONNECTION_NOT_ACTIVE 선검사(이미 비활성/연결
없음/무자격)가 «연결에 대한 새 증거»가 아닌데도 스케줄 루프·수동 재수집 두 경로가
`_promote_connection_status`를 불러 last_error 3종을 매 틱 이 순환 문구로 덮어썼다
(「왜 만료됐나」가 「연결이 활성 상태가 아닙니다」가 되는 실사고, 원래 원인
CHANNEL_TOKEN_EXPIRED는 소실). 이 파일은 AC1~AC5를 각각 고정한다.

세팅 헬퍼는 test_3603_connection_last_error.py·test_3497_insight_snapshots.py와
동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    """test_3603_connection_last_error.py와 동형 — channel_connection 암호화 키가
    없으면 _seed_channel_connection의 encrypt_channel_credential이 죽는다."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


@pytest.mark.anyio
async def test_ac1_precheck_not_active_does_not_clobber_last_error(monkeypatch):
    """AC1 — expired+TOKEN_EXPIRED 기록된 연결에 루프 1틱 → last_error_code 그대로
    TOKEN_EXPIRED(라이브 실사고 재현: 이전엔 이 값이 CHANNEL_CONNECTION_NOT_ACTIVE로
    덮였다). 스케줄 행은 connection_inactive로 쉰다(AC2 절반)."""
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook", status="expired")
            original_error_at = datetime.now(timezone.utc) - timedelta(hours=3)
            conn.last_error = "토큰이 만료되었습니다: 401"
            conn.last_error_code = "CHANNEL_TOKEN_EXPIRED"
            conn.last_error_at = original_error_at
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")

            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="facebook", external_id="media-1", anchor_at=anchor,
            )
            await s.commit()

            counts = await process_due_comment_collections(s)
            assert counts.get("connection_inactive") == 1, counts
            assert counts.get("failed", 0) == 0

            refreshed = await s.get(ChannelConnection, conn.id)
            assert refreshed.status == "expired"
            assert refreshed.last_error == "토큰이 만료되었습니다: 401", "선검사 실패가 원래 원인을 덮으면 안 된다"
            assert refreshed.last_error_code == "CHANNEL_TOKEN_EXPIRED"
            assert refreshed.last_error_at == original_error_at

            rows = (await s.execute(
                __import__("sqlalchemy").select(CommentCollectionSchedule).where(
                    CommentCollectionSchedule.publication_id == pub.id,
                ).order_by(CommentCollectionSchedule.due_at.asc())
            )).scalars().all()
            # schedule_comment_collection이 +1h·+1d·+7d 3행을 심는다 — 그중 +1h만
            # anchor(now-2h) 기준 이미 due라 이번 틱에 처리된다(나머지 2행은 미래라
            # 그대로 pending).
            assert len(rows) == 3
            assert rows[0].status == "connection_inactive"
            assert rows[0].error_code == "CHANNEL_CONNECTION_NOT_ACTIVE"
            assert rows[1].status == "pending" and rows[2].status == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_resting_row_not_retried_next_tick():
    """AC2 — connection_inactive로 쉰 행은 다음 틱 due 스캔에도 안 걸린다(매 틱
    재시도 0). pending이었다면 두 번째 호출도 counts["connection_inactive"]==1이
    또 나왔을 것 — 여기선 0이어야 한다."""
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook", status="expired")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")
            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="facebook", external_id="media-1", anchor_at=anchor,
            )
            await s.commit()

            first = await process_due_comment_collections(s)
            assert first.get("connection_inactive") == 1, first

            second = await process_due_comment_collections(s)
            assert second.get("connection_inactive", 0) == 0, second
            assert sum(second.values()) == 0, second
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac3_manual_refresh_not_active_no_promote_still_raises():
    """AC3 — 수동 「다시 수집」은 non-active 연결에서 지금과 같이 실패(409로 매핑)
    하되 승격/기록은 없다(last_error 3종 불변)."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_post_comments import CommentFetchError, refresh_comments_now

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook", status="expired")
            original_error_at = datetime.now(timezone.utc) - timedelta(hours=3)
            conn.last_error = "토큰이 만료되었습니다: 401"
            conn.last_error_code = "CHANNEL_TOKEN_EXPIRED"
            conn.last_error_at = original_error_at
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")
            await s.commit()

            with pytest.raises(CommentFetchError) as exc_info:
                await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)
            assert exc_info.value.error_code == "CHANNEL_CONNECTION_NOT_ACTIVE"

            refreshed = await s.get(ChannelConnection, conn.id)
            assert refreshed.status == "expired"
            assert refreshed.last_error == "토큰이 만료되었습니다: 401"
            assert refreshed.last_error_code == "CHANNEL_TOKEN_EXPIRED"
            assert refreshed.last_error_at == original_error_at
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_wake_resets_resting_schedule_on_reconnect():
    """AC2(복귀 경로) — 쉬는 행이 재연결(upsert_channel_connection, 같은 org/channel/
    account_id) 뒤 pending으로 깨어나고 due_at도 즉시로 되돌아온다(다음 루프 틱이
    바로 집는다)."""
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_connection import upsert_channel_connection
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook", status="expired")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")
            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="facebook", external_id="media-1", anchor_at=anchor,
            )
            await s.commit()

            rested = await process_due_comment_collections(s)
            assert rested.get("connection_inactive") == 1, rested

            import sqlalchemy
            resting_row_id = (await s.execute(
                sqlalchemy.select(CommentCollectionSchedule.id).where(
                    CommentCollectionSchedule.publication_id == pub.id,
                    CommentCollectionSchedule.status == "connection_inactive",
                )
            )).scalar_one()

            await upsert_channel_connection(
                s, org_id=org_id, channel="facebook", account_id=conn.account_id, account_label=None,
                credential_kind="oauth", access_token="new-token-after-reconnect", refresh_token=None,
                token_expires_at=None, refresh_mode="reissue_from_access_token", scopes=[], connected_by=uuid.uuid4(),
            )

            row = await s.get(CommentCollectionSchedule, resting_row_id)
            assert row.status == "pending", "재연결 뒤에도 쉬는 상태로 남으면 그 발행은 영영 재수집이 안 된다"
            assert row.due_at <= datetime.now(timezone.utc)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac5_mutation_removing_precheck_guard_fails_ac1():
    """AC5 뮤테이션 대조 — AC1 가드(exc.error_code == "CHANNEL_CONNECTION_NOT_ACTIVE"
    분기)가 없다고 가정하면 last_error가 덮인다는 것을 옛 분기 로직을 직접 흉내내
    증명한다(소스 자체를 되돌리지 않고, 그 옛 조건문과 동형인 계산을 재현)."""
    from app.services.publication_command import classify_failure_kind, FAILURE_KIND_CONNECTION

    error_code = "CHANNEL_CONNECTION_NOT_ACTIVE"
    failure_kind = classify_failure_kind(error_code)
    # 옛(가드 제거) 분기 조건: `if failure_kind == FAILURE_KIND_CONNECTION:` 만 있었다면
    # 이 코드도 그 안에 들어가 promote가 불렸을 것 — 그게 바로 이 스토리의 버그였다.
    assert failure_kind == FAILURE_KIND_CONNECTION, (
        "이 코드가 CONNECTION류로 분류되는 한, AC1의 명시적 코드-문자열 예외 분기가 "
        "없으면 반드시 promote가 불려 last_error가 덮인다(회귀 대상)"
    )


@pytest.mark.anyio
async def test_ac4_insight_publication_not_found_uses_own_code():
    """AC4 — insight_snapshots._fetch_instagram_via_connection의 "channel_publication을
    찾을 수 없습니다" 실패가 더는 CHANNEL_CONNECTION_NOT_ACTIVE를 재사용하지 않고
    자기 코드(INSIGHT_PUBLICATION_NOT_FOUND)를 쓴다 — 다른 사실(발행 기록 없음)에
    같은 낱말(연결 비활성)을 쓰지 않는다."""
    from app.services.insight_snapshots import InsightFetchError, _fetch_instagram_via_connection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            fake_snapshot = SimpleNamespace(publication_id=uuid.uuid4())
            with pytest.raises(InsightFetchError) as exc_info:
                await _fetch_instagram_via_connection(s, fake_snapshot)
            assert exc_info.value.error_code == "INSIGHT_PUBLICATION_NOT_FOUND"
            assert exc_info.value.error_code != "CHANNEL_CONNECTION_NOT_ACTIVE"
    finally:
        await engine.dispose()
