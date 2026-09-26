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
async def test_publish_endpoint_returns_api_usage_budget_exceeded_code_not_generation():
    """⭐story #3808(PR5c, 페드루 PO 確定 2026-09-12 — 라이브 회차 결함 처방) — X
    api_usage_budget 초과가 발행 HTTP 엔드포인트에서 "GENERATION_BUDGET_EXCEEDED"
    (실측, 배포79 라이브 회차 — 축 오라벨 결함)가 아니라 별도 코드로 와야 한다.
    실 라우터(publish_channel_post_draft_endpoint)까지 왕복해 detail.code를 직접
    확認한다(서비스 레이어 단위 테스트만으론 라우터의 하드코딩 문자열 매핑을 못
    잡는다)."""
    from app.main import app
    from app.services.channel_connection import upsert_channel_connection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            connection = await upsert_channel_connection(
                s, org_id=org_id, channel="x_sandbox", account_id="x-sandbox-budget-code-1",
                account_label="sandbox_x_user", credential_kind="oauth",
                access_token="sandbox-x-access:app-1", refresh_token="sandbox-x-refresh:app-1:g0",
                token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
                scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=human_id,
            )
            await _put_rules(s, org_id=org_id, rules={
                "api_usage_budget": {"limit_minor": 10, "currency": "KRW", "period": "month"},
            })
            draft_id = await _seed_and_approve_x_draft(
                s, org_id=org_id, project_id=project_id, human_id=human_id, connection_id=connection.id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r.status_code == 422, r.text
            error = r.json()["error"]
            assert error["code"] == "API_USAGE_BUDGET_EXCEEDED", (
                f"X 상한 초과인데 코드가 {error.get('code')!r} — 축 오라벨 결함 재발"
            )
            assert error["limit_minor"] == 10
        finally:
            app.dependency_overrides.clear()
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


# ─── story #4336(PO 05:24Z 조건 2 · 3) — 요청 때 통과 · 워커에서 걸림 ────────────────────────────────


async def _x_org_with_budget(Session, *, limit_minor: int, drafts: int):
    from app.services.channel_connection import upsert_channel_connection

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        human_id = await _seed_human(s, org_id)
        connection = await upsert_channel_connection(
            s, org_id=org_id, channel="x_sandbox", account_id=f"x-sandbox-4336-{uuid.uuid4().hex[:8]}",
            account_label="sandbox_x_user", credential_kind="oauth",
            access_token="sandbox-x-access:app-4336", refresh_token="sandbox-x-refresh:app-4336:g0",
            token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
            scopes=["tweet.read", "tweet.write", "offline.access"], connected_by=human_id,
        )
        await _put_rules(s, org_id=org_id, rules={
            "api_usage_budget": {"limit_minor": limit_minor, "currency": "KRW", "period": "month"},
        })
        draft_ids = [
            await _seed_and_approve_x_draft(s, org_id=org_id, project_id=project_id, human_id=human_id, connection_id=connection.id)
            for _ in range(drafts)
        ]
    return org_id, human_id, draft_ids


_BUDGET_FIELDS = ("code", "limit_minor", "spent_minor", "estimated_cost_minor", "remaining_minor")


@pytest.mark.anyio
async def test_worker_budget_stop_stores_the_same_body_as_the_publish_now_422():
    """PO 조건 2 — 요청 때 예산이 남아 대기열에 들어갔는데 워커 차례 전에 다른 지출로 모자라졌다: 명령을 멈추고, 즉시 발행 422와
    **같은 본문**(코드 · 한도 · 사용 · 이번 추정 · 남은 금액)을 명령에 남겨 초안 상세가 그대로 내보낸다(화면이 같은 배너).
    뮤테이션: 워커가 `failure_detail`을 적지 않으면 상세의 `command_failure_detail`이 None으로 RED."""
    from app.main import app
    from tests.publish_worker_helpers import draft_detail, run_worker_tick

    engine, Session = await _session_factory()
    try:
        org_id, human_id, (queued, probe) = await _x_org_with_budget(Session, limit_minor=30, drafts=2)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{queued}/publish")
                assert r.status_code == 200 and r.json()["processing"] is True, r.text
                async with Session() as s:  # 그 사이 다른 지출(20) — 남은 10 < 단가 20
                    story_id = uuid.uuid4()
                    from app.services.x_publish_budget import API_USAGE_COST_KIND

                    await _seed_cost_evidence(s, org_id=org_id, work_item_id=story_id, kind=API_USAGE_COST_KIND, cost_minor=20)
                counts = await run_worker_tick(Session)
                assert counts["blocked_unapproved"] == 1, counts
                detail = await draft_detail(client, org_id, queued)
                r_now = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{probe}/publish")
        finally:
            app.dependency_overrides.clear()
        assert r_now.status_code == 422, r_now.text
        expected = {k: r_now.json()["error"][k] for k in _BUDGET_FIELDS}
        assert expected["code"] == "API_USAGE_BUDGET_EXCEEDED"
        assert detail["command_failure_detail"] == expected
        assert (detail["command_status"], detail["command_reason_code"]) == ("blocked_unapproved", "API_USAGE_BUDGET_EXCEEDED")
    finally:
        await engine.dispose()


from tests.test_4336_preflight_error_body_classes import _cases as _preflight_failure_cases  # noqa: E402


@pytest.mark.anyio
@pytest.mark.parametrize("failure", sorted(_preflight_failure_cases()))
async def test_every_preflight_failure_the_worker_meets_stores_the_same_body_as_the_request(failure, monkeypatch):
    """PO P2(09:08Z) — 조건 2를 **모든** preflight 실패로: 요청 때 통과했는데 워커의 같은 검사에서 걸리면(종류 전수 — 봉인 · 승인 ·
    일시 중지 · 연결 · 메타데이터 · 이어쓰기 · 초안 없음 · 예산 · 할당량 · 글자 수) 명령에 남은 본문(초안 상세 `command_failure_detail`)이
    같은 실패를 요청에서 만났을 때의 4xx 본문과 키 · 값 모두 같다(명령 상태 두 칸 빼고).
    뮤테이션: 워커의 한 갈래가 `failure_detail`을 안 적으면 그 종류가 None으로 RED · 라우터 한 갈래가 다른 모양을 내면 그 종류가 RED."""
    from app.main import app
    from app.routers import channel_posts as router_module
    from app.services import channel_posts as service_module
    from tests.publish_worker_helpers import draft_detail, run_worker_tick

    exc = _preflight_failure_cases()[failure]

    async def _raise(*_a, **_k):
        raise exc

    engine, Session = await _session_factory()
    try:
        org_id, human_id, (queued, probe) = await _x_org_with_budget(Session, limit_minor=100000, drafts=2)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{queued}/publish")
                assert r.status_code == 200 and r.json()["processing"] is True, r.text
                monkeypatch.setattr(service_module, "publish_channel_post_draft", _raise)  # 워커 차례의 같은 검사에서 걸림
                await run_worker_tick(Session)
                stored = (await draft_detail(client, org_id, queued))["command_failure_detail"]
                monkeypatch.setattr(router_module, "preflight_channel_post_publish", _raise)  # 요청 때 걸림
                r_now = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{probe}/publish")
        finally:
            app.dependency_overrides.clear()
        assert 400 <= r_now.status_code < 500, (failure, r_now.status_code, r_now.text)
        request_body = {k: v for k, v in r_now.json()["error"].items() if k not in ("command_status", "next_attempt_at")}
        assert stored is not None, failure
        # 응답 봉투(main.py HTTPException 처리)는 dict 본문에 `message`가 없으면 빈 문자열을 채운다 — 같은 규칙을 저장본에 입혀 대조.
        assert {"message": stored.get("message", ""), **stored} == request_body, (failure, stored, request_body)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resuming_a_paused_command_clears_the_stored_body(monkeypatch):
    """PO P2 — 다시 시도(일시 중지 재개 포함 · 같은 `retry_dead_letter_command`)는 새 시도: 지난 멈춤의 본문을 화면에 남기지 않는다
    (워커가 다시 집기 전 1분 동안 «일시 중지» 문장이 대기 중인 글 위에 남던 틈).
    뮤테이션: 재시도 초기화에서 `failure_detail = None`을 빼면 재개 뒤에도 본문이 남아 RED."""
    from app.main import app
    from app.services import channel_posts as service_module
    from app.services.external_publish_pause import ExternalPublishPausedError, _requeue_paused_commands
    from tests.publish_worker_helpers import draft_detail, run_worker_tick

    async def _paused(*_a, **_k):
        raise ExternalPublishPausedError(reason=None)

    engine, Session = await _session_factory()
    try:
        org_id, human_id, (queued,) = await _x_org_with_budget(Session, limit_minor=100000, drafts=1)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{queued}/publish")
                assert r.status_code == 200, r.text
                monkeypatch.setattr(service_module, "publish_channel_post_draft", _paused)
                await run_worker_tick(Session)
                before = await draft_detail(client, org_id, queued)
                async with Session() as s:
                    assert await _requeue_paused_commands(s, org_id=org_id) == 1
                    await s.commit()
                after = await draft_detail(client, org_id, queued)
        finally:
            app.dependency_overrides.clear()
        assert before["command_status"] == "blocked"
        assert before["command_failure_detail"] == {"code": "EXTERNAL_PUBLISH_PAUSED", "message": "EXTERNAL_PUBLISH_PAUSED"}
        assert after["command_status"] == "pending" and after["command_failure_detail"] is None, after
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_two_queued_posts_cannot_both_spend_past_the_budget():
    """PO 조건 3 — 한도(30)가 한 건(20)만 허용하는데 둘이 동시에 요청 검사를 통과해 대기열에 들어갔다: 워커의 재검사가 실제 한도를
    지킨다 — 공급자 게시 1 · 나머지 하나는 조건 2 모양(같은 본문)으로 멈춤.
    뮤테이션: 워커 쪽 예산 재검사(`publish_channel_post_draft`의 check_api_usage_budget_or_raise)를 빼면 게시 2로 RED."""
    from sqlalchemy import select

    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from tests.publish_worker_helpers import draft_detail, run_worker_tick

    engine, Session = await _session_factory()
    try:
        org_id, human_id, drafts = await _x_org_with_budget(Session, limit_minor=30, drafts=2)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        try:
            async with _client_for(app) as client:
                for draft_id in drafts:
                    r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                    assert r.status_code == 200 and r.json()["processing"] is True, r.text
                await run_worker_tick(Session)
                details = [await draft_detail(client, org_id, d) for d in drafts]
        finally:
            app.dependency_overrides.clear()
        async with Session() as s:
            published = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.org_id == org_id, ChannelPublication.status == "published")
            )).scalars().all()
        assert len(published) == 1, f"한도 30 · 단가 20인데 게시 {len(published)}건"
        stopped = [d for d in details if d["command_status"] == "blocked_unapproved"]
        assert len(stopped) == 1
        body = stopped[0]["command_failure_detail"]
        assert body["code"] == "API_USAGE_BUDGET_EXCEEDED"
        assert (body["limit_minor"], body["spent_minor"], body["remaining_minor"]) == (30, 20, 10)
    finally:
        await engine.dispose()
