"""story #4268 — 광고 부스트 시작 명령이 재시도돼도 캠페인 · 광고 세트 · 광고를 다시 만들지 않는다.

- AC1: 생성 성공 → ACTIVE 전환 실패 → 사람 재시도 → 생성 호출 0 · 같은 campaign_id로 ACTIVE.
- AC2: 만든 id는 ACTIVE 전에 커밋 — 뒤에서 DB 오류로 워커 트랜잭션이 롤백돼도 남는다.
- AC3: 생성 중간 실패(캠페인만 만들어짐 등) → 부분 id가 남고 재시도가 이어서 만든다(어댑터 · 워커).
"""
from __future__ import annotations

import os

import httpx
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
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _run(Session, gate_id):
    from sqlalchemy import select

    from app.models.ads_boost_run import AdsBoostRun

    async with Session() as s:
        return (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one_or_none()


async def _start_command(Session, org_id, gate_id, owner_id):
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import request_ads_boost_start

    async with Session() as s:
        await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id, initiated_by="human")
    async with Session() as s:
        return (await s.execute(select(PublicationCommand.id).where(
            PublicationCommand.org_id == org_id, PublicationCommand.content_kind == "ads_boost",
        ))).scalar_one()


async def _tick(Session):
    from app.services.publication_command import process_due_publication_commands

    async with Session() as s:
        return await process_due_publication_commands(s)


async def _retry(Session, org_id, command_id):
    from app.services.publication_command import retry_dead_letter_command

    async with Session() as s:
        assert await retry_dead_letter_command(s, org_id=org_id, command_id=command_id) is not None
        await s.commit()


def _spy_sandbox_create(monkeypatch, *, first_raises=None):
    """sandbox 생성 함수를 감싸 호출(과 넘어온 existing)을 센다. first_raises가 있으면 첫 호출만 그 예외."""
    import app.services.ads_sandbox_campaign as sandbox

    real = sandbox.create_boost_campaign
    calls: list[dict] = []

    async def spy(client, **kwargs):
        calls.append(dict(kwargs.get("existing") or {}))
        if first_raises is not None and len(calls) == 1:
            raise first_raises
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "create_boost_campaign", spy)
    return calls


@pytest.mark.anyio
async def test_a_retry_after_activation_failed_does_not_create_the_campaign_again(monkeypatch):
    """AC1 — 뮤테이션: 워커의 «셋이 다 있으면 생성 건너뜀» 조건을 빼면 생성이 두 번 불려 RED."""
    import app.services.ads_sandbox_campaign as sandbox
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    calls = _spy_sandbox_create(monkeypatch)
    activations: list[str] = []

    async def flaky_status(client, *, campaign_id, access_token, status):
        activations.append(campaign_id)
        if len(activations) == 1:
            raise MetaAdsCampaignError("META_ADS_CAMPAIGN_STATUS_UPDATE_FAILED", "ACTIVE 전환 실패(주입)")

    monkeypatch.setattr(sandbox, "set_campaign_status", flaky_status)
    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        command_id = await _start_command(Session, org_id, gate_id, owner_id)
        counts = await _tick(Session)
        assert counts["dead_letter"] == 1, counts
        first = await _run(Session, gate_id)
        assert first.campaign_id and first.adset_id and first.ad_id, "만든 id가 실패 뒤에도 남아야 한다"

        await _retry(Session, org_id, command_id)
        counts = await _tick(Session)
        assert counts["completed"] == 1, counts
        assert len(calls) == 1, f"재시도가 캠페인을 다시 만들었다: {calls}"
        after = await _run(Session, gate_id)
        assert (after.campaign_id, after.status) == (first.campaign_id, "running")
        assert activations == [first.campaign_id, first.campaign_id]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_created_ids_survive_a_rollback_after_activation(monkeypatch):
    """AC2 — ACTIVE 뒤(지출 스냅샷 예약)에서 DB 오류로 워커 트랜잭션이 통째로 롤백돼도 만든 id는 남는다(ACTIVE 전에 커밋).
    뮤테이션: 그 커밋을 빼면 campaign_id가 None으로 RED(그 상태의 재시도는 이미 ACTIVE인 캠페인 옆에 또 만든다)."""
    import app.services.ads_spend_snapshots as snapshots
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    async def db_error(db, **_kwargs):
        from sqlalchemy import text

        await db.execute(text("SELECT 1/0"))

    monkeypatch.setattr(snapshots, "schedule_ads_spend_snapshots", db_error)
    # 4272(develop) — «공급자에 나갔는가»는 provider_client의 쓰기 요청 훅이 표시한다. sandbox 어댑터는 HTTP를 안 쓰니, 실제 Meta 어댑터의
    # ACTIVE 전환(POST)처럼 표시를 남기게 감싼다 — 그래야 «쓰기 뒤의 미분류 예외 = needs_check»(사람 확인 뒤 재시도)라는 운영 갈래를 잰다.
    import app.services.ads_sandbox_campaign as sandbox
    from app.services.provider_call_mark import mark_provider_call

    real_status = sandbox.set_campaign_status

    async def status_as_a_provider_write(client, **kwargs):
        mark_provider_call()
        return await real_status(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", status_as_a_provider_write)
    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        command_id = await _start_command(Session, org_id, gate_id, owner_id)
        counts = await _tick(Session)
        assert counts["error"] == 1, counts
        run = await _run(Session, gate_id)
        assert run is not None and run.campaign_id and run.adset_id and run.ad_id

        # 4272 — 미분류 예외 건은 needs_check dead_letter로 선다 → 사람 재시도가 남은 id로 이어 간다(생성 0).
        from app.models.publication_command import PublicationCommand

        async with Session() as s:
            command = await s.get(PublicationCommand, command_id)
            assert (command.status, command.failure_kind) == ("dead_letter", "needs_check")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_partial_creation_is_resumed_by_the_retry(monkeypatch):
    """AC3(워커) — 캠페인만 만들어진 채 광고 세트 생성이 실패 → 부분 id가 실행 행에 남고, 재시도는 그 id를 넘겨 이어서 만든다."""
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    partial_error = MetaAdsCampaignError(
        "META_ADS_ADSET_CREATE_FAILED", "adset 실패(주입)", partial={"campaign_id": "existing-campaign-1"},
    )
    calls = _spy_sandbox_create(monkeypatch, first_raises=partial_error)
    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        command_id = await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert (run.campaign_id, run.adset_id, run.ad_id) == ("existing-campaign-1", None, None)

        await _retry(Session, org_id, command_id)
        await _tick(Session)
        assert calls[1] == {"campaign_id": "existing-campaign-1", "adset_id": None, "ad_id": None}
    finally:
        await engine.dispose()


# ── AC3(어댑터) — 실 Meta 어댑터의 이어 만들기 · 부분 id(HTTP 목) ────────────────────────────────────────────


def _mock_client(responses: dict[str, httpx.Response], hits: list[str]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        kind = request.url.path.rsplit("/", 1)[-1]
        hits.append(kind)
        return responses[kind]

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _create(client, existing=None):
    from app.services.meta_ads_campaign import create_boost_campaign

    return await create_boost_campaign(
        client, ad_account_id="1", access_token="t", object_story_id="p_1", budget_minor=1000, currency="KRW",
        starts_at_iso="2026-09-25T00:00:00+00:00", ends_at_iso="2026-09-26T00:00:00+00:00", objective="REACH",
        existing=existing,
    )


@pytest.mark.anyio
async def test_the_meta_adapter_reports_partial_ids_and_resumes_without_recreating():
    from app.services.meta_ads_campaign import MetaAdsCampaignError

    hits: list[str] = []
    failing = _mock_client({
        "campaigns": httpx.Response(200, json={"id": "c1"}),
        "adsets": httpx.Response(500, text="boom"),
    }, hits)
    with pytest.raises(MetaAdsCampaignError) as info:
        await _create(failing)
    assert (info.value.code, info.value.partial) == ("META_ADS_ADSET_CREATE_FAILED", {"campaign_id": "c1"})
    assert hits == ["campaigns", "adsets"]

    hits.clear()
    resuming = _mock_client({
        "adsets": httpx.Response(200, json={"id": "s1"}),
        "ads": httpx.Response(200, json={"id": "a1"}),
    }, hits)
    result = await _create(resuming, existing=info.value.partial)
    assert result == {"campaign_id": "c1", "adset_id": "s1", "ad_id": "a1"}
    assert hits == ["adsets", "ads"], "이어 만들기가 캠페인을 다시 만들었다"

    hits.clear()
    done = _mock_client({}, hits)
    assert await _create(done, existing=result) == result
    assert hits == []
