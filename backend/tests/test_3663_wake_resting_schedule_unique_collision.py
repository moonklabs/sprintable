"""story #3663(Phase2·마케팅운영·라이브 결함·dev 배포 51) — `wake_resting_comment_
schedules`(story #3612의 「깨우는 손」)가 한 publication의 쉬는(connection_inactive)
행 «전부»에 같은 `func.now()`를 줘서 (publication_id, due_at) 유니크를 결정적으로
깼다(facebook_sandbox 「다시 연결」 콜백 500·error_id 08f867ac). `_COLLECTION_OFFSETS`
(+1h·+1d·+7d)별로 행이 여러 개인 publication이 오래 쉬면 재현 100%.

세팅 헬퍼는 test_3612_connection_notactive_precheck_norecord.py·
test_3547_facebook_page_connection.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import sqlalchemy

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication
from tests.test_3373_channel_connections_auth import _seed_human, _client_for, _setup_org_scoped_app
from tests.test_3547_facebook_page_connection import _register_facebook_sandbox_app_credentials

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
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    monkeypatch.setattr(config_module.settings, "channel_oauth_state_secret", "test-channel-oauth-state-secret")

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


async def _seed_resting_row(session, *, org_id, publication_id, channel, external_id, due_at):
    from app.models.channel_post_comment import CommentCollectionSchedule

    row = CommentCollectionSchedule(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_id=external_id, due_at=due_at, status="connection_inactive",
        error_code="CHANNEL_CONNECTION_NOT_ACTIVE",
    )
    session.add(row)
    await session.commit()
    return row


async def _seed_row_with_status(session, *, org_id, publication_id, channel, external_id, due_at, status):
    from app.models.channel_post_comment import CommentCollectionSchedule

    row = CommentCollectionSchedule(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_id=external_id, due_at=due_at, status=status,
    )
    session.add(row)
    await session.commit()
    return row


@pytest.mark.anyio
async def test_ac1_wakes_n2_resting_rows_without_unique_violation():
    """AC1 — 한 publication에 `_COLLECTION_OFFSETS` 3개 오프셋 행이 전부
    connection_inactive로 seed됐을 때(라이브 재현), wake는 예외 0·3행 모두
    pending·due_at 서로 다름을 낸다(예전엔 UniqueViolationError)."""
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import wake_resting_comment_schedules

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook_sandbox", status="expired")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook_sandbox", external_id="media-1",
            )
            anchor = datetime.now(timezone.utc) - timedelta(days=10)
            for offset in (timedelta(hours=1), timedelta(days=1), timedelta(days=7)):
                await _seed_resting_row(
                    s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                    external_id="media-1", due_at=anchor + offset,
                )

            woken = await wake_resting_comment_schedules(s, connection_id=conn.id)
            await s.commit()
            assert woken == 3

            rows = (await s.execute(
                sqlalchemy.select(CommentCollectionSchedule).where(
                    CommentCollectionSchedule.publication_id == pub.id,
                ).order_by(CommentCollectionSchedule.due_at.asc())
            )).scalars().all()
            assert len(rows) == 3
            assert all(r.status == "pending" for r in rows)
            due_ats = [r.due_at for r in rows]
            assert len(set(due_ats)) == 3, "due_at이 서로 달라야 유니크 충돌이 없다"
            now = datetime.now(timezone.utc)
            assert all(d <= now + timedelta(seconds=5) for d in due_ats), "지난 행은 지금 이후로 되돌아온다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_new_offset_avoids_collision_with_preserved_future_due_at(monkeypatch):
    """CHANGES(카디르 QA real PG 재현, PO 페드루 처방 2026-09-08) — 마이크로초
    오프셋이 "새로 배정하는 값들끼리만" 겹치지 않던 결함의 정확한 반례: 같은
    publication에 과거 행 2개(now-2s·now-1s)와 보존될 미래 행 1개(now+1µs)가
    있으면, 옛 코드는 두 번째 과거 행에 정확히 now+1µs를 줘 보존 행과 충돌했다
    (real PG UniqueViolationError). now를 고정해 이 정확한 배열을 재현한다."""
    from app.models.channel_post_comment import CommentCollectionSchedule
    import app.services.channel_post_comments as channel_post_comments_module
    from app.services.channel_post_comments import wake_resting_comment_schedules

    fixed_now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001 — datetime.now 시그니처 그대로.
            return fixed_now

    monkeypatch.setattr(channel_post_comments_module, "datetime", _FixedDatetime)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook_sandbox", status="expired")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook_sandbox", external_id="media-1",
            )
            past_row_a = await _seed_resting_row(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                external_id="media-1", due_at=fixed_now - timedelta(seconds=2),
            )
            past_row_b = await _seed_resting_row(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                external_id="media-1", due_at=fixed_now - timedelta(seconds=1),
            )
            preserved_future_due_at = fixed_now + timedelta(microseconds=1)
            future_row = await _seed_resting_row(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                external_id="media-1", due_at=preserved_future_due_at,
            )

            woken = await wake_resting_comment_schedules(s, connection_id=conn.id)
            await s.commit()  # 옛 코드였다면 이 commit이 IntegrityError를 냈다.
            assert woken == 3

            refreshed_future = await s.get(CommentCollectionSchedule, future_row.id)
            assert refreshed_future.due_at == preserved_future_due_at, "보존 예정 미래 행은 앞당기지 않는다"

            rows = (await s.execute(
                sqlalchemy.select(CommentCollectionSchedule).where(
                    CommentCollectionSchedule.publication_id == pub.id,
                )
            )).scalars().all()
            assert len(rows) == 3
            assert all(r.status == "pending" for r in rows)
            due_ats = [r.due_at for r in rows]
            assert len(set(due_ats)) == 3, "새로 배정된 값이 보존된 미래 값과 겹치면 안 된다"
            assert {row.id for row in (past_row_a, past_row_b, future_row)} == {r.id for r in rows}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_new_offset_avoids_collision_with_other_status_row_same_publication(monkeypatch):
    """CHANGES(3차, 카디르 QA real PG 재현, PO 페드루 처방 2026-09-08) —
    `uq_comment_collection_schedule_publication_due_at`는 status 무관 테이블
    전체에 걸린다. 2차 처방(회피집합=이번 배치의 보존 미래 행)은 같은
    publication의 «다른 상태»(pending 등) 행이 이미 쥔 due_at은 못 본다 — 그
    행이 정확히 새로 배정될 첫 후보(now+0µs)를 쥐고 있으면 여전히 충돌한다."""
    from app.models.channel_post_comment import CommentCollectionSchedule
    import app.services.channel_post_comments as channel_post_comments_module
    from app.services.channel_post_comments import wake_resting_comment_schedules

    fixed_now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return fixed_now

    monkeypatch.setattr(channel_post_comments_module, "datetime", _FixedDatetime)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook_sandbox", status="expired")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook_sandbox", external_id="media-1",
            )
            # 다른 상태(pending) 행이 정확히 새 배정 후보(now+0µs)를 이미 쥐고 있다
            # — 이 publication의 다른 발행 오프셋 행(예: +7d)이 아직 안 쉬고 있는
            # 정상적인 상황을 흉내(3663 시나리오의 흔한 실물 배열).
            pending_row = await _seed_row_with_status(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                external_id="media-1", due_at=fixed_now, status="pending",
            )
            resting_row = await _seed_resting_row(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                external_id="media-1", due_at=fixed_now - timedelta(hours=1),
            )

            woken = await wake_resting_comment_schedules(s, connection_id=conn.id)
            await s.commit()  # 옛(2·3차) 코드였다면 이 commit이 IntegrityError를 냈다.
            assert woken == 1

            refreshed_pending = await s.get(CommentCollectionSchedule, pending_row.id)
            refreshed_resting = await s.get(CommentCollectionSchedule, resting_row.id)
            assert refreshed_pending.due_at == fixed_now, "다른 상태 행의 기존 due_at은 건드리지 않는다"
            assert refreshed_resting.status == "pending"
            assert refreshed_resting.due_at != refreshed_pending.due_at, "새 값이 다른 상태 행의 due_at과 겹치면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_future_due_at_not_pulled_forward():
    """AC2 — 아직 미래인 due_at을 가진 connection_inactive 행은 앞당기지 않는다
    (원 due_at 유지). 이미 지난 행만 새 시각을 받는다."""
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import wake_resting_comment_schedules

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook_sandbox", status="expired")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook_sandbox", external_id="media-1",
            )
            past_due_at = datetime.now(timezone.utc) - timedelta(hours=2)
            future_due_at = datetime.now(timezone.utc) + timedelta(days=3)
            past_row = await _seed_resting_row(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                external_id="media-1", due_at=past_due_at,
            )
            future_row = await _seed_resting_row(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                external_id="media-1", due_at=future_due_at,
            )

            woken = await wake_resting_comment_schedules(s, connection_id=conn.id)
            await s.commit()
            assert woken == 2

            refreshed_past = await s.get(CommentCollectionSchedule, past_row.id)
            refreshed_future = await s.get(CommentCollectionSchedule, future_row.id)
            assert refreshed_past.status == "pending"
            assert refreshed_past.due_at <= datetime.now(timezone.utc)
            assert refreshed_future.status == "pending"
            assert refreshed_future.due_at == future_due_at, "미래 due_at은 앞당기면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac3_reconnect_callback_with_and_without_target_connection_id_returns_200():
    """AC3 — facebook_sandbox 재연결 콜백이 target_connection_id 有/無 두 경로
    모두 200을 낸다(회귀 전엔 쉬는 행 N≥2인 publication에서 결정적 500).
    facebook_sandbox_oauth.py는 실 HTTP 없이 인프로세스 결정적으로 답한다
    (test_3547 상단 딱지와 동형 — 목 없이 진짜 authorize→callback 라우터를 태운다)."""
    from app.main import app
    from app.models.channel_post_comment import CommentCollectionSchedule

    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            # app_id 접미 ":pages-1" — facebook_sandbox_oauth.list_pages가 「Sandbox Page 1」
            # 단일 후보만 돌려주는 갈래(2+개면 pending_selection이라 wake 경로를 안 탄다).
            await _register_facebook_sandbox_app_credentials(
                s, org_id=org_id, updated_by=owner_id, app_id="sandbox-app-id:pages-1",
            )
            # account_id를 list_pages의 고정 page_id와 맞춰야 upsert가 이 행을 그대로
            # 갱신(재연결)한다 — 다른 account_id면 새 행이 생겨 wake 대상이 안 된다.
            conn = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="facebook_sandbox", account_id="sandbox-page-1",
                status="expired", credential_kind="oauth", refresh_mode="reissue_from_access_token",
                encrypted_access_token=encrypt_channel_credential("plain-token"),
            )
            s.add(conn)
            await s.commit()
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook_sandbox", external_id="media-1",
            )
            anchor = datetime.now(timezone.utc) - timedelta(days=10)
            for offset in (timedelta(hours=1), timedelta(days=1), timedelta(days=7)):
                await _seed_resting_row(
                    s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox",
                    external_id="media-1", due_at=anchor + offset,
                )
            connection_id = conn.id
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        # 경로 ① target_connection_id 有(재연결 의도) — 위에서 쉬게 seed한 연결을 지목.
        async with _client_for(app) as client:
            r_auth = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook_sandbox/authorize",
                json={"target_connection_id": str(connection_id)},
            )
        assert r_auth.status_code == 200, r_auth.text
        state = r_auth.json()["state"]
        async with _client_for(app) as client:
            r_cb = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook_sandbox/callback",
                json={"code": "auth-code", "state": state},
            )
        assert r_cb.status_code == 200, r_cb.text

        async with Session() as s:
            rows = (await s.execute(
                sqlalchemy.select(CommentCollectionSchedule).where(
                    CommentCollectionSchedule.publication_id == pub.id,
                )
            )).scalars().all()
            assert len(rows) == 3
            assert all(r.status == "pending" for r in rows), "재연결 뒤 쉬던 행은 전부 pending으로 돌아온다"

        # 경로 ② target_connection_id 無(신규/일반 authorize) — 같은 계정으로 다시
        # upsert되며 같은 publication의 스케줄이 (이미 pending이라) 재차 무해해야 한다.
        async with _client_for(app) as client:
            r_auth2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook_sandbox/authorize",
            )
        assert r_auth2.status_code == 200, r_auth2.text
        state2 = r_auth2.json()["state"]
        async with _client_for(app) as client:
            r_cb2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook_sandbox/callback",
                json={"code": "auth-code", "state": state2},
            )
        assert r_cb2.status_code == 200, r_cb2.text
    finally:
        await engine.dispose()
