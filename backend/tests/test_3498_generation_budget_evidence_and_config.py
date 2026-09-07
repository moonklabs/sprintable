"""story #3498(Phase2·마케팅운영, 페드루 PO 決定 2026-09-05) 조각②·③ — evidence
생성비용 payload 검증(조각⑤)·GET /generation-budget(조각①)·GenerationBudgetRule
PUT 3종 검증. story #3619(CI·소형, 페드루 PO 確定 2026-09-07)로 test_3498_
generation_budget.py에서 분리했다 — 2026-09-07 #3971 run 34089668525 shard 4에서
이 파일(당시 25테스트 하나) 격리실행이 100s(등재 42s 대비)로 60초 러너 정규화
가드를 넘겨 shard를 빨갛게 했다. 재현 시도(같은 스크립트, rerun 34090xxx대)에서는
40.30s로 떨어져 재현 자체가 러너 경합에 크게 좌우됨을 확認 — #3604(test_3502)와
같은 클래스지만, 그때와 달리 이 파일엔 app.main import 유무로 갈리는 명확한 두
그룹이 없다(로컬 --durations 실측 — 23개 실DB 테스트가 각 0.32~0.47s로 균등,
단일 병목 없음. 첫 테스트만 app.main 최초 import 비용을 안고 2.36s, 그 외 22개는
고르다). 대신 파일이 이미 갖고 있던 8개 절 구분(AC1~AC5·조각①·조각⑤·PUT 3종)
경계를 그대로 써서 절반으로 갈랐다 — 원 파일에 남는 AC1~AC5(11테스트)와 이 파일
(조각①+조각⑤+PUT 3종, 11테스트)로, 테스트를 절 중간에서 자르지 않는다.

세팅 헬퍼는 test_3471_org_content_rules_lint.py에서 그대로 재사용(test_3502_
insights_board_endpoints.py 분리 선례와 동형 관례)하고, 이 스토리 전용 로컬
헬퍼(_put_generation_budget·_seed_generation_cost_evidence·_grant_project_access·
_seed_evidence_agent)는 원 파일과 이 파일 양쪽에 각각 그대로 둔다(원 파일 쪽도
AC5가 이 헬퍼들을 계속 쓴다 — 새 크로스임포트 관계를 만들지 않고, #3502 분리
선례처럼 작은 헬퍼는 두 파일에 각자 둔다)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_agent,
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


async def _put_generation_budget(session, *, org_id, limit_minor, currency="KRW", period="month"):
    """content-rules 라우터를 안 거치고 직접 — 원 파일 test_3498_generation_
    budget.py와 동일 정의(그 파일 docstring 참조, 이 파일이 사용하는 절만 이쪽에도
    그대로 둔다)."""
    from app.services.content_rules import put_org_content_rules

    return await put_org_content_rules(
        session, org_id=org_id,
        rules={"generation_budget": {"limit_minor": limit_minor, "currency": currency, "period": period}},
        updated_by_member_id=uuid.uuid4(), expected_version=0,
    )


async def _seed_generation_cost_evidence(
    session, *, org_id, work_item_id, cost_minor, created_at=None, created_by=None,
):
    from app.models.evidence import Evidence

    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        type="metric", ref="agent-generation", source="openai", created_by=created_by,
        payload={"kind": "generation_cost", "cost_minor": cost_minor, "currency": "KRW", "provider": "openai"},
    )
    session.add(ev)
    await session.commit()
    if created_at is not None:
        from sqlalchemy import update
        await session.execute(update(Evidence).where(Evidence.id == ev.id).values(created_at=created_at))
        await session.commit()
    return ev


async def _grant_project_access(session, *, project_id, member_id):
    """evidence.py::_assert_work_item_access가 최종적으로 부르는 has_project_access의
    agent 분기(project_auth.py::_project_access_predicate)는 team_member_branch가
    TeamMember.type=="human" 전용이라 에이전트를 안 본다 — 에이전트는 이 명시 grant
    (ProjectAccess.member_id, permission="granted")로만 통과한다."""
    from app.models.project_access import ProjectAccess
    import uuid as _uuid

    grant = ProjectAccess(
        id=_uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted", role="member",
    )
    session.add(grant)
    await session.commit()


async def _seed_evidence_agent(session, org_id, project_id, *, name="Evidence Agent"):
    """evidence.py 경로 전용 — create_evidence()가 resolve_member()(레거시 경로,
    member_ssot_resolver_shadow 기본 False)와 has_project_access를 **둘 다** 부른다.
    이 파일은 destructive_schema(Base.metadata.create_all)라 team_members가 members
    위 VIEW 대신 독립된 빈 테이블 — Member+TeamMember 둘 다 같은 id로 명시 시딩."""
    from app.models.member import Member
    from app.models.team import TeamMember
    import uuid as _uuid

    member_id = _uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name=name, is_active=True))
    session.add(TeamMember(id=member_id, org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True))
    await session.commit()
    await _grant_project_access(session, project_id=project_id, member_id=member_id)
    return member_id


# ─── 조각①(미르코 FE 3500 그라운딩) — GET /generation-budget ────────────────────


@pytest.mark.anyio
async def test_get_generation_budget_endpoint_reflects_limit_and_spent():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=1000)
            await _seed_generation_cost_evidence(s, org_id=org_id, work_item_id=story_id, cost_minor=300)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/generation-budget")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["limit_minor"] == 1000
        assert body["currency"] == "KRW"
        assert body["period"] == "month"
        assert body["spent_minor"] == 300
        assert body["remaining_minor"] == 700
        assert body["period_start"] is not None and body["period_end"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_generation_budget_endpoint_all_null_when_rule_absent():
    """«규칙 없음»(limit_minor 자체가 null)과 «0 한도»(limit_minor=0)를 구분 —
    규칙 자체가 없으면 전부 null, 지어내지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/generation-budget")
        assert r.status_code == 200, r.text
        assert r.json() == {
            "limit_minor": None, "currency": None, "period": None,
            "period_start": None, "period_end": None, "spent_minor": None, "remaining_minor": None,
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 조각⑤(페드루 PO REQUIRED, PR#3847 리뷰) — payload 검증·recorded_by 강제 ───────


@pytest.mark.anyio
async def test_create_evidence_generation_cost_negative_cost_minor_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            agent_id = await _seed_evidence_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "metric", "ref": "self-report",
                "payload": {"kind": "generation_cost", "cost_minor": -1, "currency": "KRW"},
            })
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_evidence_generation_cost_non_int_cost_minor_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            agent_id = await _seed_evidence_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "metric", "ref": "self-report",
                "payload": {"kind": "generation_cost", "cost_minor": "500", "currency": "KRW"},
            })
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_evidence_generation_cost_currency_mismatch_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            agent_id = await _seed_evidence_agent(s, org_id, project_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=100000, currency="KRW")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "metric", "ref": "self-report",
                "payload": {"kind": "generation_cost", "cost_minor": 500, "currency": "USD"},
            })
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "EVIDENCE_PAYLOAD_INVALID"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_evidence_generation_cost_currency_check_skipped_when_no_policy():
    """정책 자체가 없으면(«규칙 없음») 비교 대상이 없어 통과 — currency 값이 뭐든
    거부 안 함(존재하지 않는 정책과 비교할 수 없다는 원칙, generation_budget.py의
    «규칙 없음=None» 신호와 동형)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            agent_id = await _seed_evidence_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "metric", "ref": "self-report",
                "payload": {"kind": "generation_cost", "cost_minor": 500, "currency": "USD"},
            })
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_evidence_client_recorded_by_ignored_server_overwrites_with_caller_type():
    """페드루 PO REQUIRED② — 클라이언트가 payload.recorded_by="platform"을 실어도
    서버가 caller_type(여기선 "agent")으로 덮어쓴다. "platform" 표식 위조 불가."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            agent_id = await _seed_evidence_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "metric", "ref": "self-report",
                "payload": {"kind": "generation_cost", "cost_minor": 500, "currency": "KRW", "recorded_by": "platform"},
            })
        assert r.status_code == 201, r.text
        assert r.json()["payload"]["recorded_by"] == "agent", "클라이언트 recorded_by 위조가 안 막혔다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_evidence_non_generation_cost_payload_still_gets_recorded_by_overwritten():
    """recorded_by 강제는 generation_cost에 국한되지 않는다 — payload가 있는 모든
    evidence에 적용(위조 차단 축은 kind 무관)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            agent_id = await _seed_evidence_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "metric", "ref": "self-report",
                "payload": {"note": "무관한 payload", "recorded_by": "platform"},
            })
        assert r.status_code == 201, r.text
        assert r.json()["payload"]["recorded_by"] == "agent"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── GenerationBudgetRule PUT 3종 검증 ───────────────────────────────────────


@pytest.mark.anyio
async def test_put_generation_budget_negative_limit_minor_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"generation_budget": {"limit_minor": -1}}, "expected_version": 0},
            )
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_put_generation_budget_unsupported_currency_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"generation_budget": {"limit_minor": 1000, "currency": "JPY"}}, "expected_version": 0},
            )
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_put_generation_budget_unsupported_period_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"generation_budget": {"limit_minor": 1000, "period": "week"}}, "expected_version": 0},
            )
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
