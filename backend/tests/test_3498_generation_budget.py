"""story #3498(Phase2·마케팅운영, 페드루 PO 決定 2026-09-05) — 생성 비용 한도(크레딧
게이트). 블루프린트 v3 §2 「생성 비용 한도」·§PO-3 댄 걸린 자리 4·10.

세팅 헬퍼는 test_3471_org_content_rules_lint.py와 동형(중복 재발명 금지) — org·agent·
human·connection·content-rules PUT 시딩은 그대로 재사용하고, 이 스토리 전용(evidence
cost 시딩·estimated_cost_minor submit)만 새로 추가한다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _put_generation_budget(session, *, org_id, limit_minor, currency="KRW", period="month"):
    """content-rules 라우터를 안 거치고 직접(HTTP 검증은 AC1 테스트가 별도로 잰다) —
    이 파일의 나머지 테스트는 "budget이 이미 설정돼 있다"는 전제에서 시작한다."""
    from app.services.content_rules import put_org_content_rules

    return await put_org_content_rules(
        session, org_id=org_id,
        rules={"generation_budget": {"limit_minor": limit_minor, "currency": currency, "period": period}},
        updated_by_member_id=uuid.uuid4(),
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


async def _create_site_post_draft_submit(
    client, *, org_id, story_id, estimated_cost_minor=None, slug="post-1",
):
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/site-posts/drafts",
        json={
            "work_item_id": str(story_id), "title": "제목", "slug": slug, "lang": "ko",
            "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
        },
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = r_draft.json()["draft_id"]
    body = {} if estimated_cost_minor is None else {"estimated_cost_minor": estimated_cost_minor}
    r_submit = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json=body)
    return draft_id, r_submit


async def _create_channel_post_draft_submit(
    client, *, org_id, story_id, connection_id, estimated_cost_minor=None, text="채널 포스트 본문입니다.",
):
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": text},
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = r_draft.json()["draft_id"]
    body = {} if estimated_cost_minor is None else {"estimated_cost_minor": estimated_cost_minor}
    r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json=body)
    return draft_id, r_submit


async def _grant_project_access(session, *, project_id, member_id):
    """evidence.py::_assert_work_item_access가 최종적으로 부르는 has_project_access의
    agent 분기(project_auth.py::_project_access_predicate)는 team_member_branch가
    TeamMember.type=="human" 전용이라 에이전트를 안 본다 — 에이전트는 이 명시 grant
    (ProjectAccess.member_id, permission="granted")로만 통과한다(test_e_verify_v0_
    s1_evidence_realdb.py의 확립된 시딩과 동형)."""
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
    실측(2026-09-05) — 실 alembic-migrated DB(realdb류 테스트)에서는 `team_members`가
    `members`(+project_access) 위의 VIEW라 Member 하나만 심어도 양쪽에서 다 보이지만,
    이 파일은 destructive_schema(`Base.metadata.create_all`)라 `team_members`가 그
    VIEW 대신 독립된 빈 테이블로 만들어진다 — Member만 심으면 resolve_member의
    TeamMember 조회가 0행(`Team member not found`, 400). 그래서 여기선 **같은 id로
    Member+TeamMember 둘 다** 명시적으로 심는다(같은 신원의 두 그림자, 이 create_all
    한정 우회 — 실 DB에서는 자동으로 성립하는 것을 여기서만 손으로 맞춘다)."""
    from app.models.member import Member
    from app.models.team import TeamMember
    import uuid as _uuid

    member_id = _uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name=name, is_active=True))
    session.add(TeamMember(id=member_id, org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True))
    await session.commit()
    await _grant_project_access(session, project_id=project_id, member_id=member_id)
    return member_id


async def _approve_gate_directly(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


# ─── AC1: content-rules PUT/GET slot ─────────────────────────────────────────


@pytest.mark.anyio
async def test_put_generation_budget_reflected_in_get():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={
                    "rules": {"generation_budget": {"limit_minor": 100000, "currency": "KRW", "period": "month"}},
                    "expected_version": 0,
                },
            )
            assert r_put.status_code == 200, r_put.text
            assert r_put.json()["rules"]["generation_budget"] == {
                "limit_minor": 100000, "currency": "KRW", "period": "month",
            }

            r_get = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
        assert r_get.json()["rules"]["generation_budget"]["limit_minor"] == 100000
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_generation_budget_unknown_field_returns_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"generation_budget": {"limit_minor": 1000, "unknown_field": "x"}}, "expected_version": 0},
            )
        assert r_put.status_code == 422, r_put.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC2: submit-time 거부 ────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_submit_site_post_over_budget_rejected_422_with_four_values():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=1000)
            await _seed_generation_cost_evidence(s, org_id=org_id, work_item_id=story_id, cost_minor=700)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            _draft_id, r_submit = await _create_site_post_draft_submit(
                client, org_id=org_id, story_id=story_id, estimated_cost_minor=500,  # remaining=300 < 500
            )
        assert r_submit.status_code == 422, r_submit.text
        error = r_submit.json()["error"]
        assert error["code"] == "GENERATION_BUDGET_EXCEEDED"
        assert error["limit_minor"] == 1000
        assert error["spent_minor"] == 700
        assert error["estimated_cost_minor"] == 500
        assert error["remaining_minor"] == 300
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_site_post_within_budget_passes():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=1000)
            await _seed_generation_cost_evidence(s, org_id=org_id, work_item_id=story_id, cost_minor=300)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            _draft_id, r_submit = await _create_site_post_draft_submit(
                client, org_id=org_id, story_id=story_id, estimated_cost_minor=700,  # remaining=700 == 700
            )
        assert r_submit.status_code == 200, r_submit.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_site_post_no_estimated_cost_skips_check_even_when_over_budget():
    """AC2 "미설정이면 통과" — 이미 초과 상태여도 estimated_cost_minor를 아예 안
    실으면 검사 자체를 안 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=100)
            await _seed_generation_cost_evidence(s, org_id=org_id, work_item_id=story_id, cost_minor=9999)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            _draft_id, r_submit = await _create_site_post_draft_submit(
                client, org_id=org_id, story_id=story_id, estimated_cost_minor=None,
            )
        assert r_submit.status_code == 200, r_submit.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_generation_budget_limit_zero_means_suspended():
    """PO 確定 "정지 = limit_minor 0" — 지출이 0이어도 0보다 큰 어떤 추정치도 거부."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=0)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            _draft_id, r_submit = await _create_site_post_draft_submit(
                client, org_id=org_id, story_id=story_id, estimated_cost_minor=1,
            )
        assert r_submit.status_code == 422, r_submit.text
        assert r_submit.json()["error"]["code"] == "GENERATION_BUDGET_EXCEEDED"
        assert r_submit.json()["error"]["remaining_minor"] == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_channel_post_over_budget_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=100)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            _draft_id, r_submit = await _create_channel_post_draft_submit(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
                estimated_cost_minor=101,
            )
        assert r_submit.status_code == 422, r_submit.text
        assert r_submit.json()["error"]["code"] == "GENERATION_BUDGET_EXCEEDED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC3: 승인 뒤 estimated_cost_minor 변경 → budget_changed 재승인 ───────────────


@pytest.mark.anyio
async def test_budget_only_change_after_approval_reopens_gate_for_reapproval_channel_post():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=100000)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, r_submit = await _create_channel_post_draft_submit(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
                estimated_cost_minor=100,
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            # 본문·예약은 그대로, estimated_cost_minor만 변경 — budget_changed 하나만.
            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"estimated_cost_minor": 200},
            )
            assert r_resubmit.status_code == 200, r_resubmit.text
            assert r_resubmit.json()["gate_id"] == str(gate_id), "같은 게이트 행을 재사용해야 한다"
            assert r_resubmit.json()["status"] == "pending"

            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            # reapproval_required는 "시스템이 조용히 되돌렸다"는 신호(test_3414의
            # 확립된 계약) — 이건 사람/에이전트가 명시적으로 재상신한 경로라 False로
            # 복귀하는 게 기존 설계 그대로(submit()의 재상신은 항상 False로 리셋,
            # content/schedule/media 축과 동형).
            assert gate.reapproval_required is False
            assert gate.sealed_estimated_cost_minor == 200, "재봉인이 최신 추정치로 갱신돼야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_identical_including_budget_is_still_noop_channel_post():
    """회귀 0 확認 — estimated_cost_minor까지 포함해 아무것도 안 바뀐 재상신은
    여전히 no-op(short-circuit, budget 축 추가가 기존 관례를 안 깬다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, r_submit = await _create_channel_post_draft_submit(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
                estimated_cost_minor=100,
            )
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"estimated_cost_minor": 100},
            )
            assert r_resubmit.status_code == 200, r_resubmit.text
            assert r_resubmit.json()["status"] == "approved", "아무것도 안 바뀌었으면 approved 그대로여야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC4: 발행 직전 재검사 ────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_publish_rejected_when_spent_increased_after_approval_zero_adapter_calls_site_post(monkeypatch):
    from app.main import app
    import app.services.hosted_site_publish as hosted_site_publish

    call_log: list[str] = []
    _original_publish = hosted_site_publish.publish

    async def _spy_publish(*args, **kwargs):
        call_log.append("called")
        return await _original_publish(*args, **kwargs)

    monkeypatch.setattr(hosted_site_publish, "publish", _spy_publish)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=1000)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, r_submit = await _create_site_post_draft_submit(
                client, org_id=org_id, story_id=story_id, estimated_cost_minor=1000,  # 승인 시점엔 잔량 딱 맞음
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            # 승인 뒤 다른 지출이 잔량을 갉아먹었다(예: 다른 draft가 먼저 발행돼 evidence 누적).
            await _seed_generation_cost_evidence(s, org_id=org_id, work_item_id=story_id, cost_minor=1)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 422, r_pub.text
        assert r_pub.json()["error"]["code"] == "GENERATION_BUDGET_EXCEEDED"
        assert call_log == [], "예산 초과인데 hosted_site_publish.publish()가 호출됐다(adapter 호출 0 위반)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC5: evidence 지출 합산 + 기간 경계 ──────────────────────────────────────


@pytest.mark.anyio
async def test_evidence_generation_cost_counted_within_period_boundary():
    from app.services.generation_budget import compute_generation_budget_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            await _put_generation_budget(s, org_id=org_id, limit_minor=10000)

            now = datetime(2026, 9, 15, tzinfo=timezone.utc)
            month_start = datetime(2026, 9, 1, tzinfo=timezone.utc)
            # 이번 달 안 — 잡혀야 한다.
            await _seed_generation_cost_evidence(
                s, org_id=org_id, work_item_id=story_id, cost_minor=500, created_at=now,
            )
            # 이번 달 경계 정확히 그 순간(포함) — 잡혀야 한다.
            await _seed_generation_cost_evidence(
                s, org_id=org_id, work_item_id=story_id, cost_minor=300, created_at=month_start,
            )
            # 지난 달(달력 경계 밖) — 안 잡혀야 한다.
            await _seed_generation_cost_evidence(
                s, org_id=org_id, work_item_id=story_id, cost_minor=9999,
                created_at=month_start - timedelta(seconds=1),
            )
            # type이 metric이 아님 — 안 잡혀야 한다(카테고리 밖).
            from app.models.evidence import Evidence
            other = Evidence(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                type="pr", ref="https://example.com/pr/1", payload={"kind": "generation_cost", "cost_minor": 9999},
            )
            s.add(other)
            await s.commit()

            status = await compute_generation_budget_status(s, org_id=org_id, now=now)
        assert status["spent_minor"] == 800, status
        assert status["remaining_minor"] == 10000 - 800
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_compute_generation_budget_status_none_when_rule_absent():
    """«규칙 없음»과 «0 한도»를 가르는 신호 — 규칙 자체가 없으면 None."""
    from app.services.generation_budget import compute_generation_budget_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            status = await compute_generation_budget_status(s, org_id=org_id)
        assert status is None
    finally:
        await engine.dispose()


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
