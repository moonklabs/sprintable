"""story #3806(Phase3·3-2 PR3 워커 fix, 페드루 PO 確定 2026-09-11) — 워커
(`publication_command.py::_process_one_command`)의 content_kind=="ads_boost"
분기 회귀. 착수 前 실측 결함: 이 분기가 없어 ads_boost 커맨드가 channel_post
전용 기본 분기로 떨어져 매번 CHANNEL_POST_DRAFT_NOT_FOUND로 오분류·Meta API
호출 0이었다(PR 4 착수 직전 grep으로 발견). 세팅 헬퍼는 test_3806_ads_boost_
execution.py를 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3806_ads_boost_execution import _setup_approved_gate

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

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


async def _get_run(session, gate_id: uuid.UUID):
    from app.models.ads_boost_run import AdsBoostRun
    from sqlalchemy import select

    return (await session.execute(
        select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id)
    )).scalar_one_or_none()


@pytest.mark.anyio
async def test_boost_start_command_completes_and_creates_run():
    """결함 회귀의 핵심 표본 — 오분기였다면 이 커맨드는 completed가 아니라
    CHANNEL_POST_DRAFT_NOT_FOUND로 즉시 실패했어야 한다."""
    from app.services.ads_boost_execution import request_ads_boost_start
    from app.services.publication_command import process_due_publication_commands
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        async with Session() as s:
            await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            run = await _get_run(s, gate_id)
            assert run is not None
            assert run.status == "running"
            assert run.campaign_id is not None and run.campaign_id.startswith("sandbox-campaign-")
            assert run.adset_id is not None
            assert run.ad_id is not None
            assert run.started_at is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_then_resume_updates_run_status():
    from app.services.ads_boost_execution import request_ads_boost_pause, request_ads_boost_resume, request_ads_boost_start
    from app.services.publication_command import process_due_publication_commands
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        async with Session() as s:
            await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts
        async with Session() as s:
            run = await _get_run(s, gate_id)
            assert run.status == "paused"
            assert run.paused_at is not None

        async with Session() as s:
            await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts
        async with Session() as s:
            run = await _get_run(s, gate_id)
            assert run.status == "running"
            assert run.paused_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_delayed_marker_leaves_run_pause_pending():
    from app.services.ads_boost_execution import request_ads_boost_pause, request_ads_boost_start
    from app.services.publication_command import process_due_publication_commands
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), objective="POST_ENGAGEMENT [sandbox:pause-delayed]",
    )
    try:
        async with Session() as s:
            await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            await process_due_publication_commands(s)

        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts  # 명령 자체는 접수 성공(제공자 호출 200)

        async with Session() as s:
            run = await _get_run(s, gate_id)
            assert run.status == "pause_pending", "마커가 있으면 즉시 paused로 못 박으면 안 된다"
            assert run.paused_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_budget_exceeded_marker_fails_without_creating_run_ids():
    from app.services.ads_boost_execution import request_ads_boost_start
    from app.services.publication_command import process_due_publication_commands
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), objective="POST_ENGAGEMENT [sandbox:budget-exceeded]",
    )
    try:
        async with Session() as s:
            await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 0, counts
        # classify_failure_kind가 META_ADS_CAMPAIGN_CREATE_FAILED를 모르므로(매핑표
        # 밖) needs_check로 fail-closed → apply_command_failure가 즉시 dead_letter
        # (재시도해도 같은 결과이므로 백오프 큐에 안 넣는다, publication_command.py
        # 707번째 줄 주석 그대로).
        assert counts["dead_letter"] == 1, counts

        async with Session() as s:
            run = await _get_run(s, gate_id)
            assert run is not None
            assert run.campaign_id is None, "실패한 생성 시도가 campaign_id를 남기면 안 된다"
            assert run.last_error is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_without_start_at_provider_fails_gracefully():
    """run.campaign_id가 아직 없는(=boost_start가 provider에 한 번도 안 닿은) 상태로
    pause 커맨드가 워커에 집히면 크래시가 아니라 정상 실패 분류로 떨어져야 한다 —
    PR3 라우터 레이어의 「미시작 거부」(AdsBoostNotStartedError, publication_command
    존재 여부만 봄)와는 다른 축이다: 이건 그 command는 있지만(즉 라우터 체크는
    통과) provider 응답이 아직 없는 경우. process_due_publication_commands는 같은
    배치 안에서 boost_start를 pause보다 먼저(created_at asc) 처리해 버리므로, 이
    조건을 재현하려면 pause 커맨드 자체를 워커 경로 밖(직접 INSERT)에서 만든다."""
    import uuid as _uuid
    from datetime import datetime, timezone

    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            cmd = PublicationCommand(
                id=_uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=gate.sealed_ads_connection_id,
                approved_version=gate.sealed_ads_boost_version_id, operation="pause", toggle_seq=1,
                content_kind="ads_boost", status="pending", requested_by_member_id=owner_id,
            )
            s.add(cmd)
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 0, counts
        assert counts["dead_letter"] == 1, counts

        async with Session() as s:
            run = await _get_run(s, gate_id)
            assert run is not None
            assert run.status == "pending", "실패한 pause가 run.status를 건드리면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_reopened_before_worker_pickup_blocks_execution():
    """요청 시점엔 approved였지만 워커가 집기 前에 재오픈(다른 재승인 트리거)되면
    커맨드는 provider를 호출하지 않고 blocked_unapproved로 즉시 종결돼야 한다
    (site_posts.py의 게이트 재검증 관례와 동형)."""
    from app.models.gate import Gate, set_gate_status
    from datetime import datetime, timezone
    from sqlalchemy import select

    from app.services.ads_boost_execution import request_ads_boost_start
    from app.services.publication_command import process_due_publication_commands
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        async with Session() as s:
            await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["blocked_unapproved"] == 1, counts
    finally:
        await engine.dispose()
