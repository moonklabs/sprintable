"""story #2355(오르테가 판정 2026-07-31, 스레드 7256d5cc) — 사람이 «후보가 아예 없던»
story↔story 연결을 처음 만드는 write 경로. 기존 declare/relation-kind/reject 셋 다 기존
candidate_id가 있어야만 쓴다(디디 코드 직독) — 이 스토리가 그 candidate_id 자체를 새로
만드는 경로를 연다.

⛔`entity_references`가 아니라 후보 표(`reference_semantic_candidates`)에 `status='declared'`
행을 바로 넣는다(디디 판정·PO 확定, AC7 — entity_references의 relation CHECK는 ('none',
'created_from')뿐이라 spawned/followed/superseded를 구조적으로 못 받는다).

AC 번호는 story #2355 본문 그대로 대응한다.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_2301_story_body_mentions_realdb import (
    _REAL_DB_URL,
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _make_story,
    _session_factory,
    _setup_app_human,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _candidate_row(session, org_id, source_id, target_id):
    from sqlalchemy import select
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate as RSC
    return (await session.execute(
        select(RSC).where(
            RSC.org_id == org_id, RSC.source_type == "story", RSC.source_id == source_id,
            RSC.target_type == "story", RSC.target_id == target_id,
        )
    )).scalar_one_or_none()


async def _make_goal(session, org_id, project_id, title="Epic"):
    from app.models.pm import Goal
    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(goal)
    await session.commit()
    return goal


# ─── AC1/AC2: 새 연결이 estimated 경유 없이 바로 declared로 생긴다 ───────────

async def test_declare_new_creates_declared_row_directly():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id)},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["status"] == "declared"
            assert body["declared_by"] is not None
            assert body["declared_at"] is not None

            async with Session() as s:
                row = await _candidate_row(s, org.id, source.id, target.id)
                assert row is not None
                assert row.status == "declared"
                assert row.declared_by == caller_id
                assert row.declared_at is not None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC3: relation_kind 비운 채로 만들 수 있고, 그 뒤 relation-kind 엔드포인트로 채울 수 있다 ───

async def test_declare_new_without_relation_kind_then_set_it_later():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id)},
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["relation_kind"] is None
            candidate_id = resp.json()["id"]

            resp2 = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates/{candidate_id}/relation-kind",
                json={"relation_kind": "followed"},
            )
            assert resp2.status_code == 200, resp2.text
            assert resp2.json()["relation_kind"] == "followed"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC4: 포트가 쓰는 3종은 허용, 나머지 3종(+미지정 값)은 400 ───────────────

@pytest.mark.parametrize("relation_kind", ["spawned", "followed", "superseded"])
async def test_declare_new_accepts_port_relation_kinds(relation_kind):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id), "relation_kind": relation_kind},
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["relation_kind"] == relation_kind
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.parametrize("relation_kind", ["cited_as_evidence", "similar_case", "explicitly_unrelated", "bogus"])
async def test_declare_new_rejects_non_port_relation_kinds(relation_kind):
    """⛔나열 안 된 값을 조용히 통과시키지 않는다(오르테가 지시) — CHECK가 6종을 허용해도
    이 write 경로는 FE 포트가 실제로 그리는 3종만 명시로 받는다. 저장은 되나 안 그려지는
    값(cited_as_evidence·similar_case·explicitly_unrelated)과 완전 미지정 값(bogus) 모두
    이 경로에서는 거부돼야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id), "relation_kind": relation_kind},
            )
            assert resp.status_code == 400, resp.text

            async with Session() as s:
                row = await _candidate_row(s, org.id, source.id, target.id)
                assert row is None, "거부된 요청이 행을 남겼다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC5: 기계 스캔이 나중에 같은 쌍을 estimated로 던져도 declared 행을 안 건드린다 ───

async def test_declared_row_survives_later_machine_rescan_of_same_pair():
    from app.main import app
    from app.services.reference_semantic_candidates import CandidateRow, store_semantic_candidates

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id), "relation_kind": "spawned"},
            )
            assert resp.status_code == 201, resp.text
            declared_at_first = resp.json()["declared_at"]
        finally:
            await client.aclose()

        # 기계 재스캔 시뮬레이션 — 같은 자연키로 estimated 재저장을 시도(ON CONFLICT DO NOTHING).
        async with Session() as s:
            n = await store_semantic_candidates(
                s, org_id=org.id, source_type="story", source_field="body", source_id=source.id,
                rows=[CandidateRow(
                    matched_number=0, target_story_id=target.id, snippet="rescan",
                    relation_kind="similar_case", matched_keyword="같은 계열",
                )],
            )
            await s.commit()
            assert n == 0, "기계 재스캔이 declared 행을 조용히 건드렸다(rowcount != 0)"

            row = await _candidate_row(s, org.id, source.id, target.id)
            assert row.status == "declared"
            assert row.relation_kind == "spawned"
            assert row.declared_at.isoformat() == declared_at_first
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC6(역방향): 이미 estimated 행이 있는 쌍에 declare-new → 승격(중복 행 0) ───

async def test_declare_new_on_existing_estimated_pair_promotes_not_duplicates():
    from app.main import app
    from app.services.reference_semantic_candidates import CandidateRow, store_semantic_candidates

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

            await store_semantic_candidates(
                s, org_id=org.id, source_type="story", source_field="body", source_id=source.id,
                rows=[CandidateRow(
                    matched_number=0, target_story_id=target.id, snippet="machine guess",
                    relation_kind="similar_case", matched_keyword="같은 계열",
                )],
            )
            await s.commit()
            pre = await _candidate_row(s, org.id, source.id, target.id)
            assert pre.status == "estimated"
            pre_id = pre.id

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id), "relation_kind": "followed"},
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["id"] == str(pre_id), "새 행이 만들어졌다 — 승격이 아니라 중복"
            assert resp.json()["status"] == "declared"
            # 사람이 이번 호출에서 명시로 준 relation_kind가 과거 기계 추정을 덮는다.
            assert resp.json()["relation_kind"] == "followed"

            async with Session() as s:
                from sqlalchemy import select
                from app.models.reference_semantic_candidate import ReferenceSemanticCandidate as RSC
                rows = (await s.execute(select(RSC).where(
                    RSC.org_id == org.id, RSC.source_id == source.id, RSC.target_id == target.id,
                ))).scalars().all()
                assert len(rows) == 1, f"중복 행 생성: {len(rows)}건"
                assert rows[0].status == "declared"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_declare_new_is_idempotent_and_does_not_clobber_original_signer():
    """이미 declared된 행에 재호출해도 원래 declared_by/declared_at(사람 서명, AC3)가
    지워지지 않는다 — WHERE status='estimated' 가드가 이미 declared인 행은 건드리지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            first = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id), "relation_kind": "spawned"},
            )
            assert first.status_code == 201, first.text
            first_declared_at = first.json()["declared_at"]

            second = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id), "relation_kind": "followed"},
            )
            assert second.status_code == 201, second.text
            # WHERE status='estimated' 가드 — 이미 declared라 두 번째 호출은 no-op(원본 유지).
            assert second.json()["declared_at"] == first_declared_at
            assert second.json()["relation_kind"] == "spawned"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC7: entity_references에는 아무것도 안 쓴다 ────────────────────────────

async def test_declare_new_writes_nothing_to_entity_references():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id), "relation_kind": "spawned"},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.reference import Reference
            rows = (await s.execute(select(Reference).where(
                Reference.org_id == org.id, Reference.source_id == source.id,
                Reference.target_id == target.id,
            ))).scalars().all()
            assert rows == [], "entity_references에 행이 생겼다 — 구조적으로 막혀야 하는 표"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC8: 지우기(undeclare)는 reject와 다르다 — rejected_relations에 기록 안 남음 ───

async def test_undeclare_removes_row_without_recording_rejection():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            create = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id)},
            )
            candidate_id = create.json()["id"]

            delete = await client.delete(
                f"/api/v2/stories/{source.id}/reference-candidates/{candidate_id}",
            )
            assert delete.status_code == 200, delete.text
        finally:
            await client.aclose()

        async with Session() as s:
            row = await _candidate_row(s, org.id, source.id, target.id)
            assert row is None, "지웠는데 행이 남아 있다"

            from sqlalchemy import select
            from app.models.rejected_relation import RejectedRelation
            rejections = (await s.execute(select(RejectedRelation).where(
                RejectedRelation.org_id == org.id, RejectedRelation.source_id == source.id,
                RejectedRelation.target_id == target.id,
            ))).scalars().all()
            assert rejections == [], "지우기가 reject처럼 rejected_relations에 기록을 남겼다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_undeclare_refuses_estimated_row():
    """아직 estimated인(사람이 declare한 적 없는) 행은 이 경로로 못 지운다 — reject가 맞는
    경로다(다음 스캔에서도 걸러야 하므로)."""
    from app.main import app
    from app.services.reference_semantic_candidates import CandidateRow, store_semantic_candidates

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")

            await store_semantic_candidates(
                s, org_id=org.id, source_type="story", source_field="body", source_id=source.id,
                rows=[CandidateRow(
                    matched_number=0, target_story_id=target.id, snippet="s",
                    relation_kind=None, matched_keyword=None,
                )],
            )
            await s.commit()
            candidate = await _candidate_row(s, org.id, source.id, target.id)
            candidate_id = candidate.id

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.delete(
                f"/api/v2/stories/{source.id}/reference-candidates/{candidate_id}",
            )
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            row = await _candidate_row(s, org.id, source.id, target.id)
            assert row is not None, "400 응답인데 행이 지워졌다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC9: source project 접근권 — cross-project는 404 ──────────────────────

async def test_declare_new_cross_project_is_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, name="A")
            project_b = await _make_project(s, org.id, name="B")
            # caller는 project_b에만 접근권이 있다.
            _, caller_user_id = await _make_human_member(s, org.id, project_b.id)
            source = await _make_story(s, org.id, project_a.id, title="Source")  # project_a
            target = await _make_story(s, org.id, project_a.id, title="Target")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id)},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_declare_new_self_link_is_400():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(source.id)},
            )
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_declare_new_target_not_found_is_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(uuid.uuid4())},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC10: 라이브 왕복 — 만든 것이 GET /goals/{id}/reference-candidates에 declared로 나온다 ───

async def test_write_then_read_via_goal_reference_candidates_endpoint():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target = await _make_story(s, org.id, project.id, title="Target")
            from app.models.pm import Story
            from sqlalchemy import update as sa_update
            await s.execute(sa_update(Story).where(Story.id == source.id).values(epic_id=goal.id))
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            write_resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates",
                json={"target_id": str(target.id), "relation_kind": "spawned"},
            )
            assert write_resp.status_code == 201, write_resp.text

            read_resp = await client.get(f"/api/v2/goals/{goal.id}/reference-candidates")
            assert read_resp.status_code == 200, read_resp.text
            rows = read_resp.json()
            match = [r for r in rows if r["target_id"] == str(target.id)]
            assert len(match) == 1
            assert match[0]["status"] == "declared"
            assert match[0]["relation_kind"] == "spawned"
            assert match[0]["source_id"] == str(source.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC11: 회귀 — 기존 declare/relation-kind/reject 세 엔드포인트는 이 PR 전후로 같다 ───

async def test_existing_declare_relation_kind_reject_still_work():
    from app.main import app
    from app.services.reference_semantic_candidates import CandidateRow, store_semantic_candidates

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            target1 = await _make_story(s, org.id, project.id, title="Target1")
            target2 = await _make_story(s, org.id, project.id, title="Target2")

            await store_semantic_candidates(
                s, org_id=org.id, source_type="story", source_field="body", source_id=source.id,
                rows=[
                    CandidateRow(matched_number=0, target_story_id=target1.id, snippet="a",
                                 relation_kind=None, matched_keyword=None),
                    CandidateRow(matched_number=1, target_story_id=target2.id, snippet="b",
                                 relation_kind=None, matched_keyword=None),
                ],
            )
            await s.commit()
            c1 = await _candidate_row(s, org.id, source.id, target1.id)
            c2 = await _candidate_row(s, org.id, source.id, target2.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            declare_resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates/{c1.id}/declare",
            )
            assert declare_resp.status_code == 200, declare_resp.text
            assert declare_resp.json()["status"] == "declared"

            kind_resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates/{c1.id}/relation-kind",
                json={"relation_kind": "spawned"},
            )
            assert kind_resp.status_code == 200, kind_resp.text
            assert kind_resp.json()["relation_kind"] == "spawned"

            reject_resp = await client.post(
                f"/api/v2/stories/{source.id}/reference-candidates/{c2.id}/reject",
                json={"reason": "정리"},
            )
            assert reject_resp.status_code == 200, reject_resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            assert (await _candidate_row(s, org.id, source.id, target2.id)) is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
