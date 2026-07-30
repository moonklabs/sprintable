"""story #2328(C-11 ㉡층, E-CONNECT) 후속 결함 수정(2026-07-30, 파울로 판정) — dev 420개
스토리 전수스윕에서 `is_reference_candidate=true`가 0/420이었던 사고의 원인 재현·회귀가드.

배경: reconcile_entity_references·generate_and_store_candidates 호출이 update_story()
(PATCH)에만 있었고 create_story()(POST)에는 «한 번도» 없었다 — dev 실사례로 확認(story
#2329는 생성 후 재수정되어 후보 2건, #2330은 생성만 되고 미수정이라 0건). "새 것만(소급
안 함)"이라는 #2328 판정이 "생성 시점마다"를 의도했는데 create가 빠져 "수정 시점마다"로만
구현됐던 것 — 이 파일은 POST(생성) 자체로도 후보가 생기는 것을 실PG로 확認한다.

곁들여 자기참조 제외(파울로 판정, 같은 날 — #2329가 본문에 자기 번호를 적어 자신을
가리키는 후보가 실제로 생긴 것을 계기로)도 이 파일에서 검증한다.
"""
from __future__ import annotations

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


async def _candidates(session, org_id, source_id, source_field=None):
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

    stmt = select(ReferenceSemanticCandidate).where(
        ReferenceSemanticCandidate.org_id == org_id,
        ReferenceSemanticCandidate.source_id == source_id,
    )
    if source_field is not None:
        stmt = stmt.where(ReferenceSemanticCandidate.source_field == source_field)
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def test_creating_story_with_bare_number_description_creates_candidate():
    """핵심 회귀가드 — POST(생성) 자체가 훅을 태운다. 이 테스트가 이 결함의 재발을 잡는다:
    _reconcile_story_references_and_candidates 호출을 create_story에서 빼면 이 테스트가
    빨개진다(수동 뮤테이션 확認 완료, PR 설명 참조)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6001
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id),
                    "org_id": str(org.id),
                    "title": "Source(생성시부터 참조 있음)",
                    "description": "#6001 가드와 같은 성질(동종사례 근거)",
                },
            )
            assert resp.status_code == 201, resp.text
            story_id = resp.json()["id"]

            async with Session() as s:
                cands = await _candidates(s, org.id, story_id, source_field="description")
                assert len(cands) == 1, "POST(생성) 자체로 의미 후보가 생겨야 한다"
                assert cands[0].target_id == target.id
                assert cands[0].relation_kind == "similar_case"
                assert cands[0].status == "estimated"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_creating_story_with_bare_number_acceptance_criteria_creates_candidate():
    """AC 필드도 create 시점에 걷힌다(description과 대칭)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6002
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id),
                    "org_id": str(org.id),
                    "title": "Source(AC에서 생성시 참조)",
                    "acceptance_criteria": "#6002 가드와 같은 성질(동종사례 근거)",
                },
            )
            assert resp.status_code == 201, resp.text
            story_id = resp.json()["id"]

            async with Session() as s:
                cands = await _candidates(s, org.id, story_id, source_field="acceptance_criteria")
                assert len(cands) == 1
                assert cands[0].target_id == target.id
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_story_referencing_own_number_creates_no_self_candidate():
    """자기참조 제외(파울로 판정 2026-07-30, dev 실사례 — story #2329가 실제로 자기참조
    후보를 만들었다). 자신의 story_number를 알아야 자기참조가 가능하므로(생성 시점엔 아직
    모른다), PATCH로 재현한다 — #2329의 실제 발생 경로와 동일."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Self-referencing")
            story.story_number = 6003
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "판정: #6003 닫는다."},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert cands == [], (
                    f"자기참조 후보가 제외되지 않았다 — 사람에게 내밀 값이 없는 행이 생성됨: {cands!r}"
                )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_story_referencing_own_number_and_other_number_keeps_only_other():
    """자기참조 제외가 «다른» 참조까지 같이 지우지 않는다(과잉 필터 아닌지 확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            other = await _make_story(s, org.id, project.id, title="Other")
            other.story_number = 6005
            story = await _make_story(s, org.id, project.id, title="Self+other")
            story.story_number = 6004
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "판정: #6004 닫는다 — #6005 와 같은 성질(동종사례 근거)"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                cands = await _candidates(s, org.id, story.id, source_field="description")
                assert len(cands) == 1
                assert cands[0].target_id == other.id
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
