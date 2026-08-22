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
from datetime import datetime, timedelta, timezone
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
async def test_repo_unknown_query_does_not_crash_on_cross_repo_multiple_matches():
    """카디르 QA(story #2932, PR#3359 3라운드, codex 발견) — 이 PR 자신이 도입한 신규
    회귀. repo를 모르는 조회(report-done류 self-report의 실 경로, workflow_report.py:198
    `evaluate_merge_gate(pr_number=N, repo="")`)가, 이 PR이 정당하게 허용한 "같은
    pr_number·다른 repo 2행" 상태를 만나면 repo 필터 없는 단독쿼리가 MultipleResultsFound
    (500)로 죽었다. repo_full_name=None 조회는 repo도 모르는 행(NULL)만 매치해야
    구조적으로 모호성이 없다 — 크래시 없이 None(확신 있는 매치 없음)을 받아야 한다."""
    from app.models.gate import Gate
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            s.add_all([
                Gate(
                    id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                    gate_type="merge", status="pending", pr_number=99, repo_full_name="acme/repo-a",
                ),
                Gate(
                    id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                    gate_type="merge", status="pending", pr_number=99, repo_full_name="acme/repo-b",
                ),
            ])
            await s.commit()
            story_id, org_id = story.id, org.id

        async with Session() as s:
            # 크래시 없이(MultipleResultsFound 0) None을 받아야 한다 — repo를 모르므로
            # repo-a/repo-b 둘 중 어느 것도 "확신 있는 매치"가 아니다.
            found = await find_gate_slot_with_pr_fallback(
                s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", pr_number=99, repo_full_name=None,
            )
            assert found is None, "repo 모름 + cross-repo 다중매치 = 확신 있는 단일 매치 없음(None)이어야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_repo_case_and_whitespace_variants_resolve_to_same_slot():
    """카디르 QA(story #2932 HIGH1, 이 PR 자체 재재verdict) — repo identity 대소문자/공백
    정규화 누락. `Acme/Repo`와 `acme/repo`(대소문자만 다름)·` acme/repo `(공백)가 전부
    같은 실 repo인데 정규화 없이 비교하면 슬롯이 분열한다(DB 유니크 인덱스도 case-
    sensitive라 막지 못함). 기존 SSOT pr_story_link.py::normalize_repo(strip+lower)를
    find_gate_slot_with_pr_fallback이 관통시켜야 한다."""
    from app.models.gate import Gate
    from app.services.gate_service import find_gate_slot_with_pr_fallback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            # 정규화된 형태(lower+strip)로 저장된 기존 행 — create_gate/승격 경로가
            # 실제로 저장하는 형태를 시뮬레이션.
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending", pr_number=77, repo_full_name="acme/repo",
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id
            story_id, org_id = story.id, org.id

        # 대소문자/공백이 섞인 변형들이 전부 같은 행을 찾아야 한다.
        for variant in ("Acme/Repo", "ACME/REPO", " acme/repo ", "AcMe/RePo"):
            async with Session() as s:
                found = await find_gate_slot_with_pr_fallback(
                    s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                    gate_type="merge", pr_number=77, repo_full_name=variant,
                )
                assert found is not None and found.id == gate_id, (
                    f"repo 변형 {variant!r}이 정규화된 기존 슬롯을 찾아야 함"
                )

        # 승격 경로도 정규화된 값을 저장해야 한다(원본 대소문자를 그대로 쓰면 다음 조회가
        # 또 못 찾는다).
        async with Session() as s:
            null_gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", status="pending", pr_number=None,
            )
            s.add(null_gate)
            await s.commit()

        async with Session() as s:
            promoted = await find_gate_slot_with_pr_fallback(
                s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="merge", pr_number=88, repo_full_name="ACME/Other-Repo",
            )
            assert promoted is not None
            assert promoted.repo_full_name == "acme/other-repo", (
                f"승격 저장값이 정규화(lower+strip)돼야 하는데 {promoted.repo_full_name!r}로 남음"
            )
            await s.commit()
    finally:
        await engine.dispose()


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


@pytest.mark.anyio
async def test_stale_webhook_does_not_repend_already_approved_gate():
    """HIGH2 핵심(완주 조건) — 이미 최신 SHA로 승인된 게이트에 뒤늦게 도착한 옛
    synchronize 배달(pr_updated_at이 이미 관측된 워터마크보다 과거)이 SHA 불일치와
    무관하게 재-pending을 skip해야 한다. GitHub 웹훅은 순서를 보장하지 않으므로 —
    story #2893의 핵심 보증("승인은 그때의 커밋에")을 이 클래스가 직접 지킨다."""
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        watermark = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="approved", pr_number=42,
                repo_full_name="acme/repo", approved_head_sha="sha-latest",
                pr_head_observed_at=watermark,
            )
            s.add(gate)
            await s.commit()
            gate_id, org_id = gate.id, org.id

        stale_delivery = watermark - timedelta(minutes=5)  # 워터마크보다 과거 배달.
        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            repended = await reopen_gate_if_new_sha(
                s, org_id, gate, "sha-from-stale-delivery",
                repo_full_name="acme/repo", pr_number=42, pr_updated_at=stale_delivery,
            )
            await s.commit()
            assert repended is False, "stale 배달은 SHA가 달라도 재-pending을 발생시키면 안 됨"

        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            assert gate.status == "approved", "stale 배달 후에도 승인 상태가 유지돼야 함"
            assert gate.approved_head_sha == "sha-latest", "stale 배달이 최신 승인 SHA를 덮어쓰면 안 됨"
            assert gate.pr_head_observed_at == watermark, "stale 배달은 워터마크를 되돌리면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_genuinely_newer_webhook_still_repends_correctly():
    """회귀 방지 — 진짜로 더 최신인 배달(pr_updated_at이 워터마크보다 미래)은 HIGH2
    가드가 생기기 전과 동일하게 SHA 불일치 시 정상적으로 재-pending해야 한다."""
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        watermark = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="approved", pr_number=42,
                repo_full_name="acme/repo", approved_head_sha="sha-old",
                pr_head_observed_at=watermark,
            )
            s.add(gate)
            await s.commit()
            gate_id, org_id = gate.id, org.id

        newer_delivery = watermark + timedelta(minutes=5)
        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            repended = await reopen_gate_if_new_sha(
                s, org_id, gate, "sha-new",
                repo_full_name="acme/repo", pr_number=42, pr_updated_at=newer_delivery,
            )
            await s.commit()
            assert repended is True, "진짜 신규 배달은 SHA 불일치 시 재-pending해야 함(회귀 금지)"

        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            assert gate.status == "pending"
            assert gate.approved_head_sha is None
            assert gate.pr_head_observed_at == newer_delivery, "재-pending 시 워터마크도 새 배달 시각으로 전진해야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sha_unchanged_but_newer_delivery_advances_watermark_without_status_change():
    """HIGH2 부속 — SHA는 그대로인데(예: 라벨만 바뀐 재전송 등) pr_updated_at만 더
    최신이면, 상태 변화 없이 워터마크만 전진해야 한다(다음 stale 판정의 기준선을
    갱신 — 안 그러면 옛 워터마크에 머물러 미래의 진짜 stale 배달을 못 거른다)."""
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        watermark = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="approved", pr_number=42,
                repo_full_name="acme/repo", approved_head_sha="sha-same",
                pr_head_observed_at=watermark,
            )
            s.add(gate)
            await s.commit()
            gate_id, org_id = gate.id, org.id

        newer_delivery = watermark + timedelta(minutes=1)
        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            repended = await reopen_gate_if_new_sha(
                s, org_id, gate, "sha-same",
                repo_full_name="acme/repo", pr_number=42, pr_updated_at=newer_delivery,
            )
            await s.commit()
            assert repended is False, "SHA가 그대로면 재-pending은 아니어야 함"

        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            assert gate.status == "approved"
            assert gate.approved_head_sha == "sha-same"
            assert gate.pr_head_observed_at == newer_delivery, "워터마크는 상태변화 없이도 전진해야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ui_approval_seeds_pr_head_watermark_realdb():
    """story #2932 완주조건 HIGH2(4라운드, 카디르 자기정정) — 사람 UI 승인 경로
    (`gates.py::transition_gate_endpoint`)가 approved_head_sha를 세우면서 pr_head_observed_at
    워터마크도 함께 씨드해야 한다. 원래는 이 자리가 비어 있어(writer 3곳 중 이 경로만
    누락), 정상 승인 직후에도 워터마크=None으로 남아 다음 stale webhook을 못 걸렀다."""
    from tests.test_2835_gate_approval_publish_self_sufficient_realdb import (
        _client_for,
        _seed_common,
        _setup_app,
    )
    from app.main import app
    from app.models.gate import Gate
    from app.models.github_installation import GithubInstallation
    from app.models.pm import Story
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="UI 승인 워터마크 씨드",
            )
            s.add(story)
            await s.commit()
            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=seeded["org_id"], installation_id=293201, account_login="acme",
            ))
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending",
                approved_head_sha=None, github_check_run_id=1, github_check_run_sha="sha-ui-approve",
                pr_head_observed_at=None,
                neutral_facts={"repo": "acme/ui-approve-repo", "pr_number": 2932},
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            # publish_gate_check(background task)는 「승인」과 별개 writer(gate_github_check.py
            # 자신의 success-발행 경로)라 이 endpoint 자신의 워터마크 로직을 노 no-op으로 만들어도
            # 그 태스크가 대신 워터마크를 씨드해 뮤테이션을 가릴 수 있다 — 이 테스트는 UI 승인
            # 코드 자체를 고립시키려 그 태스크를 통째로 no-op 처리한다.
            with (
                patch("app.routers.gates.publish_gate_check", AsyncMock()),
                patch("app.core.database.async_session_factory", Session),
            ):
                resp = await client.post(
                    f"/api/v2/gates/{gate_id}/transition",
                    json={"status": "approved", "note": "워터마크 씨드 확인", "evidence_viewed": True},
                )
                assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            refetched = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert refetched.status == "approved"
            assert refetched.approved_head_sha == "sha-ui-approve"
            assert refetched.pr_head_observed_at is not None, (
                "UI 승인이 approved_head_sha를 세우면서 pr_head_observed_at 워터마크도 함께 씨드해야 함"
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ui_approval_then_stale_webhook_does_not_repend_realdb():
    """story #2932 완주조건 HIGH2 — 카디르 4라운드가 정확히 지적한 시나리오: 사람이 UI에서
    막 승인한 직후, 그 승인보다 «과거» pr_updated_at을 가진 지연 webhook(다른 SHA)이
    도착해도 spurious 재-pending이 일어나면 안 된다. 이게 원래 처방이 실패하던 «주경로»다."""
    from tests.test_2835_gate_approval_publish_self_sufficient_realdb import (
        _client_for,
        _seed_common,
        _setup_app,
    )
    from app.main import app
    from app.models.gate import Gate
    from app.models.github_installation import GithubInstallation
    from app.models.pm import Story
    from app.services.gate_github_check import reopen_gate_if_new_sha
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="UI 승인 직후 stale webhook",
            )
            s.add(story)
            await s.commit()
            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=seeded["org_id"], installation_id=293202, account_login="acme",
            ))
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending",
                approved_head_sha=None, github_check_run_id=2, github_check_run_sha="sha-primary-path",
                pr_head_observed_at=None,
                neutral_facts={"repo": "acme/primary-path-repo", "pr_number": 2933},
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id
            org_id = seeded["org_id"]

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            # 위 테스트와 동일 이유 — publish_gate_check 배경 태스크의 독립 워터마크-씨드가
            # endpoint 자신의 로직을 가리지 않도록 no-op 처리.
            with (
                patch("app.routers.gates.publish_gate_check", AsyncMock()),
                patch("app.core.database.async_session_factory", Session),
            ):
                resp = await client.post(
                    f"/api/v2/gates/{gate_id}/transition",
                    json={"status": "approved", "note": "주경로 재현", "evidence_viewed": True},
                )
                assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        # 승인 직후 워터마크가 실제로 세팅됐는지 전제 확인.
        async with Session() as s:
            approved_gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert approved_gate.pr_head_observed_at is not None, "전제: UI 승인이 워터마크를 씨드해야 함"
            watermark_at_approval = approved_gate.pr_head_observed_at

        # 승인보다 과거 pr_updated_at을 가진 지연 webhook — 다른(옛) SHA를 실어 도착.
        stale_delivery = watermark_at_approval - timedelta(minutes=10)
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            repended = await reopen_gate_if_new_sha(
                s, org_id, gate, "sha-stale-delayed-delivery",
                repo_full_name="acme/primary-path-repo", pr_number=2933,
                pr_updated_at=stale_delivery,
            )
            await s.commit()
            assert repended is False, (
                "UI 승인 직후 도착한 stale webhook이 spurious 재-pending을 일으키면 안 됨"
                "(카디르 4라운드가 지적한 정확히 이 시나리오)"
            )

        async with Session() as s:
            final_gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert final_gate.status == "approved", "stale webhook 후에도 승인 상태 유지돼야 함"
            assert final_gate.approved_head_sha == "sha-primary-path", "stale webhook이 anchor를 덮으면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_gate_check_success_seeds_pr_head_watermark_realdb():
    """story #2932 완주조건 HIGH2(4라운드) — writer 3곳 중 마지막 하나: `publish_gate_check`
    (background 발행 태스크)가 conclusion=success를 발행할 때도 워터마크를 함께 씨드해야
    한다. ⚠️그라운딩(이 테스트 작성 중 실측): approved/auto_passed 게이트는 이 함수 자신의
    fail-closed 가드(anchor 없으면 발행 자체를 skip — 위쪽 코드)때문에 `approved_head_sha`가
    **이미** 세팅돼 있어야만 이 지점에 도달한다 — 즉 이 write는 "새 anchor 확立"이 아니라
    "기존 anchor 재확인"이다. 그래도 워터마크가 비어 있던 legacy 게이트(이 필드가 생기기 前
    승인된 것 등)가 재발행될 때 씨드 기회를 놓치면 안 되므로, 전제를 "이미 anchor는 있고
    워터마크만 비어 있음"으로 세팅해 검증한다."""
    from app.models.gate import Gate
    from app.models.github_installation import GithubInstallation
    from app.services.gate_github_check import publish_gate_check
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=org.id, installation_id=293401, account_login="acme",
            ))
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="approved", pr_number=2934,
                repo_full_name="acme/publish-writer-repo", approved_head_sha="sha-publish-writer",
                github_check_run_id=None, github_check_run_sha=None,
                pr_head_observed_at=None,
            )
            s.add(gate)
            await s.commit()
            gate_id, org_id = gate.id, org.id

        with (
            patch("app.services.gate_github_check.create_check_run", AsyncMock(return_value={"id": 99})),
            patch("app.core.database.async_session_factory", Session),
        ):
            await publish_gate_check(
                org_id, gate_id,
                head_sha="sha-publish-writer", repo_full_name="acme/publish-writer-repo", pr_number=2934,
            )

        async with Session() as s:
            refetched = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert refetched.approved_head_sha == "sha-publish-writer"
            assert refetched.pr_head_observed_at is not None, (
                "publish_gate_check success 발행이 워터마크를 함께 씨드해야 함(legacy 빈 워터마크 회복)"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_equal_timestamp_different_sha_still_repends():
    """카디르 4라운드(codex 발견) — `<=`(동일 timestamp도 stale)는 서로 다른 두 진짜 배달이
    같은 초 단위 timestamp를 우연히 공유하면 신규 SHA를 stale로 오판했다. `<`로 완화한 뒤엔
    동일 timestamp가 staleness guard를 안 타고 기존 SHA-diff 비교로 넘어가 정상 재-pending
    해야 한다."""
    from app.models.gate import Gate
    from app.services.gate_github_check import reopen_gate_if_new_sha
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        watermark = datetime(2026, 8, 22, 15, 0, 0, tzinfo=timezone.utc)
        async with Session() as s:
            org, _project, story = await _seed_org_project_story(s, with_participation=True)
            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="approved", pr_number=42,
                repo_full_name="acme/repo", approved_head_sha="sha-old-tie",
                pr_head_observed_at=watermark,
            )
            s.add(gate)
            await s.commit()
            gate_id, org_id = gate.id, org.id

        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            repended = await reopen_gate_if_new_sha(
                s, org_id, gate, "sha-new-same-timestamp",
                repo_full_name="acme/repo", pr_number=42, pr_updated_at=watermark,
            )
            await s.commit()
            assert repended is True, (
                "동일 timestamp라도 SHA가 다르면 stale로 오판하지 않고 정상 재-pending해야 함"
            )

        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            assert gate.status == "pending"
            assert gate.approved_head_sha is None
    finally:
        await engine.dispose()
