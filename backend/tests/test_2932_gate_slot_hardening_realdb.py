"""story #2932([게이트·후속] PR단위 슬롯 하드닝 3건) — 2893 4-PR 체인 최종 점검(카디르
#3357 verdict)에서 나온 신규 HIGH 3건. 전부 이미 develop에 머지된 A1(PR①)·B3(PR③)의
기존 코드 결함(이 story 자체의 신규 코드 결함이 아님).

HIGH1 — cross-repo identity: 게이트 슬롯 identity(work_item_id·gate_type·pr_number)에
repo가 없어, 다른 repo의 같은 PR번호가 한 스토리에 연결되면 SHA/evidence가 섞일 수 있었다.
HIGH2 — NULL슬롯 승격 동시성: find_gate_slot_with_pr_fallback의 "미상→특정 PR" 승격에
락/CAS가 없어 동시 웹훅 2개가 같은 NULL 슬롯을 서로 다른 PR로 경쟁 승격할 수 있었다.
HIGH3 — B3 fallback 합성: 재평가 API의 legacy 폴백이 존재하지 않는 repo/PR 조합을 합성해
GitHub GET을 날릴 수 있었다.
"""
from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from tests.test_2893_gate_pr_scoped_isolation_realdb import (
    _seed_org_project_story,
    _session_factory,
)

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_cross_repo_same_pr_number_get_independent_gates():
    """HIGH1 핵심 — 같은 스토리에 다른 repo의 동일 pr_number가 링크되면(예: 모노레포
    분리·조직 재구성 등) 두 게이트가 독립 행이어야 한다(슬롯 공유=SHA/evidence 오염)."""
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            story_id, org_id = story.id, org.id

        async with Session() as s:
            gate_a = await find_gate_slot_with_pr_fallback(
                s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", pr_number=42, repo_full_name="acme/repo-a",
            )
            assert gate_a is None, "아직 아무 게이트도 없어야 함(전제)"
        # find_gate_slot_with_pr_fallback 자체는 생성하지 않는다(create_gate가 함) — 여기선
        # 직접 두 repo의 gate row를 만들어 슬롯 독립성만 확認.
        async with Session() as s:
            from app.models.gate import Gate

            g1 = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", status="pending", pr_number=42, repo_full_name="acme/repo-a",
            )
            s.add(g1)
            await s.commit()

        async with Session() as s:
            found_for_b = await find_gate_slot_with_pr_fallback(
                s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", pr_number=42, repo_full_name="acme/repo-b",
            )
            assert found_for_b is None, "다른 repo의 같은 pr_number는 repo-a의 슬롯을 못 봐야 함"

            from app.models.gate import Gate

            g2 = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", status="pending", pr_number=42, repo_full_name="acme/repo-b",
            )
            s.add(g2)
            await s.commit()

        async with Session() as s:
            from app.models.gate import Gate

            rows = (
                await s.execute(select(Gate).where(Gate.work_item_id == story_id))
            ).scalars().all()
            assert len(rows) == 2, "cross-repo 동일 pr_number = 독립 2행이어야 함"
            by_repo = {g.repo_full_name: g for g in rows}
            assert set(by_repo) == {"acme/repo-a", "acme/repo-b"}
            assert all(g.pr_number == 42 for g in rows)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_repo_unknown_legacy_slot_is_promoted_not_orphaned():
    """HIGH1 잔여 — pr_number는 이미 아는데 repo만 몰랐던 legacy/미백필 행이 있으면, repo가
    나중에 밝혀질 때 그 행을 승격 재사용해야 한다(고아화·중복생성 금지 — NULL-슬롯 승격과
    대칭인 축)."""
    from app.models.gate import Gate
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            legacy_gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending", pr_number=55, repo_full_name=None,
            )
            s.add(legacy_gate)
            await s.commit()
            legacy_gate_id = legacy_gate.id
            story_id, org_id = story.id, org.id

        async with Session() as s:
            found = await find_gate_slot_with_pr_fallback(
                s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", pr_number=55, repo_full_name="acme/repo",
            )
            assert found is not None and found.id == legacy_gate_id, "legacy 행을 찾아 승격해야 함(새 행 아님)"
            assert found.repo_full_name == "acme/repo", "승격 — repo_full_name이 채워져야 함"
            await s.commit()

        async with Session() as s:
            rows = (
                await s.execute(select(Gate).where(Gate.work_item_id == story_id))
            ).scalars().all()
            assert len(rows) == 1, "승격이지 신규생성이 아니므로 여전히 1행이어야 함"
            assert rows[0].repo_full_name == "acme/repo"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_null_slot_promotion_concurrency_serializes_no_double_promotion():
    """HIGH2 핵심 — 동시(실 Postgres 트랜잭션 2개) 웹훅이 같은 NULL-슬롯을 서로 다른 PR로
    경쟁 승격하면, SELECT FOR UPDATE가 둘째를 첫째의 커밋까지 블록시켜 직렬화돼야 한다 —
    둘 다 "성공"해 같은 행을 서로 다른 pr_number로 덮어쓰면 안 된다."""
    from app.models.gate import Gate
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            null_gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending", pr_number=None,
            )
            s.add(null_gate)
            await s.commit()
            null_gate_id = null_gate.id
            story_id, org_id = story.id, org.id

        tx1_locked = asyncio.Event()
        tx1_may_commit = asyncio.Event()
        result_holder: dict[str, uuid.UUID | None] = {}

        async def _tx1():
            async with Session() as s1:
                found = await find_gate_slot_with_pr_fallback(
                    s1, org_id=org_id, work_item_id=story_id, work_item_type="story",
                    gate_type="merge", pr_number=801, repo_full_name="acme/repo",
                )
                result_holder["tx1"] = found.id if found else None
                tx1_locked.set()
                await tx1_may_commit.wait()
                await s1.commit()

        async def _tx2():
            await tx1_locked.wait()
            async with Session() as s2:
                found = await find_gate_slot_with_pr_fallback(
                    s2, org_id=org_id, work_item_id=story_id, work_item_type="story",
                    gate_type="merge", pr_number=802, repo_full_name="acme/repo",
                )
                result_holder["tx2"] = found.id if found else None
                await s2.commit()

        async def _release_tx1_after_delay():
            await tx1_locked.wait()
            await asyncio.sleep(0.3)  # tx2가 SELECT FOR UPDATE로 실제 블록할 시간을 준다.
            tx1_may_commit.set()

        await asyncio.gather(_tx1(), _tx2(), _release_tx1_after_delay())

        assert result_holder["tx1"] == null_gate_id, "tx1이 NULL-슬롯을 승격해야 함"
        assert result_holder["tx2"] is None, (
            "tx2는 tx1 커밋 後 재평가에서 이미 승격된 슬롯을 못 보고 None을 받아야 함"
            "(중복 승격 없음 — FOR UPDATE 직렬화의 직접 증거)"
        )

        async with Session() as s:
            rows = (
                await s.execute(select(Gate).where(Gate.work_item_id == story_id))
            ).scalars().all()
            assert len(rows) == 1, "행이 여전히 1개여야 함(승격이지 신규생성 아님)"
            assert rows[0].pr_number == 801, "먼저 커밋한 tx1의 pr_number로 승격됐어야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_b3_reevaluate_does_not_synthesize_fictitious_repo_pr_tuple():
    """HIGH3 핵심 — 게이트에 pr_number는 이미 있는데 repo가 없고(legacy), 스토리의 «가장
    최근» PR 링크가 **다른 PR**의 것이면, 그 링크의 repo를 빌려 존재한 적 없는 (repo, 이
    pr_number) 조합을 합성하면 안 된다 — 조합 실패로 422여야지, 잘못된 조합으로 GitHub GET을
    날리면 안 된다."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from tests.conftest import override_db_and_read

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, story = await _seed_org_project_story(s, with_participation=True)

            from app.models.github_installation import GithubInstallation
            from app.models.project import OrgMember
            from app.models.project_access import ProjectAccess
            from app.models.pull_request_story_link import PullRequestStoryLink
            from app.models.user import User

            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=org.id, installation_id=680900, account_login="moonklabs",
            ))
            # 스토리의 "가장 최근" 링크는 PR#99(다른 PR) — gate 자신은 PR#42에 귀속.
            s.add(PullRequestStoryLink(
                id=uuid.uuid4(), org_id=org.id, story_id=story.id,
                repo_full_name="acme/repo-of-pr-99", pr_number=99,
                link_source="explicit", confidence="high",
            ))
            await s.commit()

            from app.models.gate import Gate
            from app.services.merge_verdict_gate import MERGE_GATE_TYPE

            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending", pr_number=42, repo_full_name=None,
                neutral_facts=None,
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

            caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
            s.add(caller)
            await s.commit()
            caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
            s.add(caller_om)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
                permission="granted", role="member",
            ))
            await s.commit()
            caller_id = caller.id

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(caller_id), email="caller@test", claims={"app_metadata": {}})

        async def _org():
            return org.id

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = _org

        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        get_pr_calls = []

        async def _spy_get_pull_request(installation_id, repo_full_name, pr_number):
            get_pr_calls.append((repo_full_name, pr_number))
            return {"head": {"sha": "sha-x"}, "merged": False}

        try:
            with (
                patch("app.routers.gates.get_installation_token", AsyncMock(return_value="inst-tok")),
                patch("app.routers.gates.get_pull_request", new=_spy_get_pull_request),
                patch(
                    "app.routers.gates.fetch_status_check_rollup",
                    AsyncMock(return_value=("success", None)),
                ),
                patch("app.core.database.async_session_factory", Session),
            ):
                resp = await client.post(f"/api/v2/gates/{gate_id}/reevaluate")
            # 합성 튜플로 GET을 날리느니 422로 정직하게 실패해야 한다 — link의 pr_number(99)가
            # gate의 pr_number(42)와 다르므로 그 링크는 쓰면 안 되고, repo를 못 찾아 422.
            assert resp.status_code == 422, resp.text
            assert get_pr_calls == [], f"합성된 (repo, pr_number) 조합으로 GitHub GET이 나가면 안 됨: {get_pr_calls}"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
