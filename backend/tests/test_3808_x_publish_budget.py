"""story #3808(Phase3·3-3 PR3, 페드루 PO 確定 2026-09-11) — X 종량 API 지출 월 상한.
AC 담당 파일 — 4단:
① `x_publish_budget.py` 단위 — unit_cost 규칙값 우선/코드 기본값 폴백·예산 체크.
② 「다른 지갑」 격리 — generation_cost 지출이 api_usage_cost 잔량을 안 갉아먹고
  그 반대도 마찬가지(그라운딩 정정의 핵심 재현).
③ evidence 멱등(publication_id+sequence) — 재기록 시도해도 행 1개.
④ 실 호출부 통합 — `publish_channel_post_draft`가 x_sandbox에서 예산 초과 시
  발행을 막고, 성공 시 evidence를 남긴다.
⑤ x_sandbox_publish.py `[sandbox:api-budget-exceeded]` 마커(provider-측 거부
  축, 우리 조직 상한과는 다른 축)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_agent,
    _seed_connection,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

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


async def _put_rules(session, *, org_id, rules: dict):
    from app.services.content_rules import put_org_content_rules

    return await put_org_content_rules(
        session, org_id=org_id, rules=rules, updated_by_member_id=uuid.uuid4(), expected_version=0,
    )


async def _seed_cost_evidence(session, *, org_id, work_item_id, kind, cost_minor, **extra_payload):
    from app.models.evidence import Evidence

    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        type="metric", ref="test-seed", source="platform",
        payload={"kind": kind, "cost_minor": cost_minor, **extra_payload},
    )
    session.add(ev)
    await session.commit()
    return ev.id


# ─── ① x_publish_budget.py 단위 ───────────────────────────────────────────────

def test_get_api_usage_unit_cost_minor_prefers_rule_value_over_default():
    from app.services.x_publish_budget import get_api_usage_unit_cost_minor

    assert get_api_usage_unit_cost_minor({"api_usage_budget": {"unit_cost_minor": 999}}) == 999


def test_get_api_usage_unit_cost_minor_falls_back_to_code_default_when_absent():
    from app.services.x_publish_budget import _DEFAULT_UNIT_COST_MINOR, get_api_usage_unit_cost_minor

    assert get_api_usage_unit_cost_minor(None) == _DEFAULT_UNIT_COST_MINOR
    assert get_api_usage_unit_cost_minor({}) == _DEFAULT_UNIT_COST_MINOR
    assert get_api_usage_unit_cost_minor({"api_usage_budget": {}}) == _DEFAULT_UNIT_COST_MINOR


@pytest.mark.anyio
async def test_check_api_usage_budget_or_raise_no_rule_means_no_check():
    """규칙 자체가 없으면(«규칙 없음») 통과 — compute_generation_budget_status의
    None 계약을 그대로 물려받는다."""
    from app.services.x_publish_budget import check_api_usage_budget_or_raise

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
        async with Session() as s:
            await check_api_usage_budget_or_raise(s, org_id=org_id, estimated_cost_minor=999_999)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_check_api_usage_budget_or_raise_exceeds_raises_with_correct_rule_key():
    from app.services.generation_budget import GenerationBudgetExceededError
    from app.services.x_publish_budget import check_api_usage_budget_or_raise

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            await _put_rules(s, org_id=org_id, rules={
                "api_usage_budget": {"limit_minor": 10, "currency": "KRW", "period": "month"},
            })
        async with Session() as s:
            with pytest.raises(GenerationBudgetExceededError) as exc_info:
                await check_api_usage_budget_or_raise(s, org_id=org_id, estimated_cost_minor=20)
        assert exc_info.value.rule_key == "api_usage_budget"
        assert "api_usage_budget exceeded" in str(exc_info.value)
    finally:
        await engine.dispose()


# ─── ② 「다른 지갑」 격리 — generation_cost와 api_usage_cost는 서로 안 갉아먹는다 ────

@pytest.mark.anyio
async def test_generation_and_api_usage_budgets_are_isolated_wallets():
    from app.services.generation_budget import GenerationBudgetExceededError, check_generation_budget_or_raise
    from app.services.x_publish_budget import check_api_usage_budget_or_raise

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            await _put_rules(s, org_id=org_id, rules={
                "generation_budget": {"limit_minor": 100, "currency": "KRW", "period": "month"},
                "api_usage_budget": {"limit_minor": 100, "currency": "KRW", "period": "month"},
            })
            # generation_cost 지갑만 90 소진 — api_usage_cost 지갑은 안 건드려야 한다.
            await _seed_cost_evidence(s, org_id=org_id, work_item_id=story_id, kind="generation_cost", cost_minor=90)

        async with Session() as s:
            # generation 지갑은 거의 다 썼으니 15 요청은 거부돼야 한다.
            with pytest.raises(GenerationBudgetExceededError) as exc_info:
                await check_generation_budget_or_raise(s, org_id=org_id, estimated_cost_minor=15)
            assert exc_info.value.rule_key == "generation_budget"

        async with Session() as s:
            # api_usage 지갑은 그 90 소진과 무관하게 100 그대로 — 90 요청도 통과해야 한다.
            await check_api_usage_budget_or_raise(s, org_id=org_id, estimated_cost_minor=90)
    finally:
        await engine.dispose()


# ─── ③ evidence 멱등(publication_id+sequence) ─────────────────────────────────

@pytest.mark.anyio
async def test_record_api_usage_cost_evidence_idempotent_by_publication_and_sequence():
    from sqlalchemy import select
    from app.models.evidence import Evidence
    from app.services.x_publish_budget import API_USAGE_COST_KIND, record_api_usage_cost_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
        publication_id = uuid.uuid4()

        async with Session() as s:
            await record_api_usage_cost_evidence(
                s, org_id=org_id, work_item_id=story_id, publication_id=publication_id,
                sequence=1, cost_minor=20,
            )
        async with Session() as s:
            # ⭐재시도·재발행 시나리오 — 같은 (publication_id, sequence)로 다시 호출.
            await record_api_usage_cost_evidence(
                s, org_id=org_id, work_item_id=story_id, publication_id=publication_id,
                sequence=1, cost_minor=20,
            )

        async with Session() as s:
            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == API_USAGE_COST_KIND,
                )
            )).scalars().all()
        assert len(rows) == 1, f"멱등이어야 하는데 {len(rows)}건 기록됨"

        # 양성대조 — 다른 sequence는 별개 행으로 남아야 한다(과소계상 방지).
        async with Session() as s:
            await record_api_usage_cost_evidence(
                s, org_id=org_id, work_item_id=story_id, publication_id=publication_id,
                sequence=2, cost_minor=20,
            )
        async with Session() as s:
            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == API_USAGE_COST_KIND,
                )
            )).scalars().all()
        assert len(rows) == 2
    finally:
        await engine.dispose()


# ─── ④ 실 호출부 통합 — publish_channel_post_draft(x_sandbox) ─────────────────

async def _seed_and_approve_x_draft(session, *, org_id, project_id, human_id, connection_id):
    from app.services.channel_posts import create_channel_post_draft_version, submit_channel_post_draft
    from app.models.gate import Gate
    from sqlalchemy import select

    story_id = await _seed_story(session, org_id, project_id)
    version, _channel, _images = await create_channel_post_draft_version(
        session, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
        text="X 예산 통합 테스트", link_url=None, author_member_id=human_id, author_kind="human",
    )
    draft_id = version.draft_id
    gate, _ = await submit_channel_post_draft(
        session, org_id=org_id, draft_id=draft_id, version_id=version.id, requester_member_id=human_id,
    )
    gate_row = (await session.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
    gate_row.status = "approved"
    gate_row.resolver_id = uuid.uuid4()
    gate_row.resolved_at = datetime.now(timezone.utc)
    await session.commit()
    return draft_id


@pytest.mark.anyio
async def test_publish_blocked_when_api_usage_budget_exceeded():
    from app.services.channel_connection import upsert_channel_connection
    from app.services.channel_posts import publish_channel_post_draft
    from app.services.generation_budget import GenerationBudgetExceededError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            _agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            connection = await upsert_channel_connection(
                s, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-budget-1",
                account_label="sandbox_x_user", credential_kind="oauth",
                access_token="sandbox-x-access:app-1", refresh_token="sandbox-x-refresh:app-1:g0",
                token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
                scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=human_id,
            )
            # 한도(10)가 기본 단가(20)보다 작아 항상 거부되게 — 실 규칙 우선 확認 겸함.
            await _put_rules(s, org_id=org_id, rules={
                "api_usage_budget": {"limit_minor": 10, "currency": "KRW", "period": "month"},
            })
            draft_id = await _seed_and_approve_x_draft(
                s, org_id=org_id, project_id=project_id, human_id=human_id, connection_id=connection.id,
            )

        async with Session() as s:
            with pytest.raises(GenerationBudgetExceededError) as exc_info:
                await publish_channel_post_draft(s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id)
        assert exc_info.value.rule_key == "api_usage_budget"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_succeeds_and_records_api_usage_cost_evidence():
    from sqlalchemy import select
    from app.models.evidence import Evidence
    from app.services.channel_connection import upsert_channel_connection
    from app.services.channel_posts import publish_channel_post_draft
    from app.services.x_publish_budget import API_USAGE_COST_KIND

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            _agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            connection = await upsert_channel_connection(
                s, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-budget-2",
                account_label="sandbox_x_user", credential_kind="oauth",
                access_token="sandbox-x-access:app-2", refresh_token="sandbox-x-refresh:app-2:g0",
                token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
                scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=human_id,
            )
            # 규칙 미설정 — 코드 기본값(20)으로 폴백해도 무한(규칙 없음=검사 skip)이라 통과.
            draft_id = await _seed_and_approve_x_draft(
                s, org_id=org_id, project_id=project_id, human_id=human_id, connection_id=connection.id,
            )

        async with Session() as s:
            row = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
            )
        assert row.status == "published"

        async with Session() as s:
            ev_rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == API_USAGE_COST_KIND,
                )
            )).scalars().all()
        assert len(ev_rows) == 1
        assert ev_rows[0].payload["publication_id"] == str(row.id)
        assert ev_rows[0].payload["sequence"] == row.sequence == 1
        from app.services.x_publish_budget import _DEFAULT_UNIT_COST_MINOR
        assert ev_rows[0].payload["cost_minor"] == _DEFAULT_UNIT_COST_MINOR
    finally:
        await engine.dispose()


# ─── ⑤ x_sandbox_publish.py [sandbox:api-budget-exceeded] 마커 ────────────────

@pytest.mark.anyio
async def test_x_sandbox_api_budget_exceeded_marker_is_deterministic():
    """provider-측 거부 축(x_publish_budget.py의 우리 조직 상한과는 다른 축) —
    ads_sandbox_campaign.py::_BUDGET_EXCEEDED_MARKER와 동형 계약 재현."""
    from app.services.threads_publish import ThreadsPublishError
    from app.services.x_sandbox_publish import create_container

    with pytest.raises(ThreadsPublishError) as exc_info:
        await create_container(
            httpx.AsyncClient(), access_token="at", threads_user_id="u",
            text="본문 [sandbox:api-budget-exceeded] 끝",
        )
    assert exc_info.value.code == "SANDBOX_X_API_BUDGET_EXCEEDED"
    assert exc_info.value.status_code == 402
    assert "[sandbox:api-budget-exceeded]" in exc_info.value.message
