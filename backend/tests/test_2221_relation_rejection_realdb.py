"""story #2221 후속(오르테가 판정, 2026-07-30) — 관계 단위 기각(rejected_relations) 실PG
검증. relation_kind에 6번째 종(superseded)을 더하는 것과 「종 지정」PATCH 엔드포인트는
디디의 PR#2702(0219)가 이미 지어(파울로 판정, 2026-07-30) 이 판에서는 뺐다 — 관계 기각
표 하나로 스코프를 좁힌다.

핵심 판정:
  기각 시 같은 (source,target) 쌍의 candidate 행 «전부»(field 달라도)가 사라진다(관계 단위).
  기각된 쌍은 재저장해도 후보가 다시 안 생긴다(build_candidate_rows 필터).
  기각은 멱등(같은 쌍 두 번 기각해도 에러 아님, 중복 행 없음).
  되살리기(undo) 후엔 rejected_relations에서 사라지지만, candidate가 즉시 부활하진 않는다
    (재저장이 있어야 새로 생긴다 — "새 참조만" 설계 원칙과 동일).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

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


async def _candidates(session, org_id, source_id):
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate
    result = await session.execute(
        select(ReferenceSemanticCandidate).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.source_id == source_id,
        )
    )
    return list(result.scalars().all())


async def _rejected(session, org_id, source_id):
    from app.models.rejected_relation import RejectedRelation
    result = await session.execute(
        select(RejectedRelation).where(
            RejectedRelation.org_id == org_id,
            RejectedRelation.source_id == source_id,
        )
    )
    return list(result.scalars().all())


async def test_reject_removes_all_sibling_candidates_for_same_pair():
    """관계 단위 기각 — description·acceptance_criteria 둘 다에서 같은 target을 가리키는
    후보가 있을 때, «하나만» reject해도 둘 다 사라진다(간선이 아니라 관계, 유나 지적)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6101
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={
                    "description": "#6101 신규 스토리 등재 - 발견분",
                    "acceptance_criteria": "#6101 검수 중 발견",
                },
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                cands_before = await _candidates(s, org.id, story.id)
            assert len(cands_before) == 2, "description·AC 둘 다에서 후보가 생겨야 함"

            reject_resp = await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{cands_before[0].id}/reject",
                json={"reason": "테스트 기각"},
            )
            assert reject_resp.status_code == 200, reject_resp.text

            async with Session() as s:
                cands_after = await _candidates(s, org.id, story.id)
                rejected = await _rejected(s, org.id, story.id)
            assert cands_after == [], "관계 단위 기각인데 형제 후보가 남아 있음"
            assert len(rejected) == 1
            assert rejected[0].reason == "테스트 기각"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_rejected_pair_does_not_reappear_on_resave():
    """기각된 쌍은 같은 산문으로 재저장해도 다시 후보가 안 생긴다(build_candidate_rows 필터)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6102
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#6102 신규 스토리 등재 - 발견분"},
            )
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]
            await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/reject"
            )

            # 다른 필드를 건드려 재저장(같은 #6102 언급은 그대로) — 후보가 다시 생기면 안 됨.
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#6102 신규 스토리 등재 - 발견분 (재저장)"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id)
            assert cands == [], "기각된 쌍이 재저장에서 다시 후보로 생김"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_reject_is_idempotent_no_duplicate_rejection_rows():
    """같은 관계를 두 번 기각해도(예: 다른 field의 candidate로 각각 reject) 에러 없이,
    rejected_relations 행은 하나뿐이다(ON CONFLICT DO NOTHING)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6103
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            await client.patch(
                f"/api/v2/stories/{story.id}",
                json={
                    "description": "#6103 신규 스토리 등재 - 발견분",
                    "acceptance_criteria": "#6103 검수 중 발견",
                },
            )
            candidates = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()
            assert len(candidates) == 2

            r1 = await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidates[0]['id']}/reject"
            )
            assert r1.status_code == 200, r1.text

            async with Session() as s:
                from app.models.reference_semantic_candidate import ReferenceSemanticCandidate
                remaining = (await s.execute(
                    select(ReferenceSemanticCandidate).where(
                        ReferenceSemanticCandidate.org_id == org.id,
                        ReferenceSemanticCandidate.source_id == story.id,
                    )
                )).scalars().all()
            assert remaining == [], "첫 reject에서 이미 형제 후보가 다 지워졌어야 함"

            async with Session() as s:
                rejected = await _rejected(s, org.id, story.id)
            assert len(rejected) == 1, "멱등이어야 하는데 중복 기각 행이 생김"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_undo_removes_rejection_but_candidate_does_not_auto_revive():
    """되살리기 — rejected_relations 행이 사라지지만, candidate는 재저장 전까지 안 돌아온다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6104
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#6104 신규 스토리 등재 - 발견분"},
            )
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]
            await client.post(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}/reject"
            )

            listed = await client.get(f"/api/v2/stories/{story.id}/rejected-relations")
            assert listed.status_code == 200, listed.text
            assert len(listed.json()) == 1
            target_id = listed.json()[0]["target_id"]

            undo_resp = await client.delete(
                f"/api/v2/stories/{story.id}/rejected-relations/{target_id}"
            )
            assert undo_resp.status_code == 200, undo_resp.text

            async with Session() as s:
                rejected_after = await _rejected(s, org.id, story.id)
                cands_after = await _candidates(s, org.id, story.id)
            assert rejected_after == [], "되살렸는데 기각 행이 남아 있음"
            assert cands_after == [], "되살리기만으로 candidate가 즉시 부활함(재저장 없이) — 설계 위반"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_undo_nonexistent_rejection_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.delete(
                f"/api/v2/stories/{story.id}/rejected-relations/{uuid.uuid4()}"
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── PATCH relation_kind — declare와 별개 계약 ────────────────────────────────

async def test_set_relation_kind_only_changes_relation_kind():
    """PATCH relation_kind가 status/declared_by/declared_at을 안 건드리고 relation_kind만
    바꾼다 — declare(status만 바꿈)와 대칭인 별개 액션."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6105
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#6105 직교 무관 언급"},
            )
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]

            patch_resp = await client.patch(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}",
                json={"relation_kind": "superseded"},
            )
            assert patch_resp.status_code == 200, patch_resp.text
            assert patch_resp.json()["relation_kind"] == "superseded"

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id)
            assert len(cands) == 1
            assert cands[0].relation_kind == "superseded"
            assert cands[0].status == "estimated", "PATCH relation_kind가 status를 건드림"
            assert cands[0].declared_by is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_set_relation_kind_rejects_invalid_value_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6106
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#6106 신규 스토리 등재 - 발견분"},
            )
            candidate_id = (
                await client.get(f"/api/v2/stories/{story.id}/reference-candidates")
            ).json()[0]["id"]

            resp = await client.patch(
                f"/api/v2/stories/{story.id}/reference-candidates/{candidate_id}",
                json={"relation_kind": "not_a_real_kind"},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── DB CHECK — superseded 허용 + 잘못된 값은 DB도 막음 ───────────────────────

async def test_db_check_accepts_superseded_bypassing_app_validation():
    """app validator를 안 거치고 ORM으로 직접 relation_kind='superseded'를 넣어도 커밋된다
    (CHECK가 6종을 다 받아들이는지 DB 레벨에서 확認)."""
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            story = await _make_story(s, org.id, project.id, title="Source")

        async with Session() as s:
            row = ReferenceSemanticCandidate(
                id=uuid.uuid4(), org_id=org.id, source_type="story", source_field="description",
                source_id=story.id, target_type="story", target_id=target.id, form="mention",
                relation_kind="superseded", snippet="test", status="estimated",
            )
            s.add(row)
            await s.commit()  # 예외 없이 커밋돼야 함
    finally:
        await engine.dispose()


async def test_db_check_rejects_invalid_relation_kind_bypassing_app_validation():
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            story = await _make_story(s, org.id, project.id, title="Source")

        async with Session() as s:
            row = ReferenceSemanticCandidate(
                id=uuid.uuid4(), org_id=org.id, source_type="story", source_field="description",
                source_id=story.id, target_type="story", target_id=target.id, form="mention",
                relation_kind="not_a_real_kind", snippet="test", status="estimated",
            )
            s.add(row)
            with pytest.raises(IntegrityError, match="ck_reference_semantic_candidates_relation_kind"):
                await s.commit()
    finally:
        await engine.dispose()
