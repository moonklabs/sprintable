"""story #2328(C-11 ㉡층, E-CONNECT) — 의존성 고르기 검색결과에 의미 후보(status=estimated)를
맨 앞으로 재정렬 + "왜 여기 있는지" 실물 근거(is_reference_candidate·matched_snippet)를 싣는다
(유나 규격, 2026-07-29). #2301의 실PG 헬퍼를 그대로 재사용한다(재구현 0).

핵심 판정:
  후보 재정렬: boost_candidates_from 지정 시 후보가 결과 맨 앞에 온다.
  이유 필드: 후보 항목에만 is_reference_candidate=True + matched_snippet(스니펫)이 실린다.
  후보 아닌 항목: is_reference_candidate=False·matched_snippet=None(섞이지 않는다, 유나 규격①).
  거르지 않는다: boost_candidates_from을 줘도 매칭 안 되는 항목이 결과에서 사라지지 않는다.
  q 비어도 동작: q 없이 boost_candidates_from만 줘도 후보가 앞으로 온다(유나 규격②의 전제).
  declared 후보는 안 뜬다: status='declared'로 승격된 후보는 이 재정렬 대상이 아니다
    (estimated만 — declared는 이미 사람이 판단해 실행 관계로 선언된 것이라 "제안"이 아니다).
"""
from __future__ import annotations

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


async def _insert_candidate(session, *, org_id, source_id, target_id, status="estimated", snippet="스니펫"):
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

    session.add(ReferenceSemanticCandidate(
        id=uuid.uuid4(), org_id=org_id, source_type="story", source_field="description",
        source_id=source_id, target_type="story", target_id=target_id, form="mention",
        relation_kind=None, matched_keyword=None, snippet=snippet, status=status,
    ))
    await session.commit()


async def test_candidate_boosted_to_front_with_reason_fields():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            # 후보가 아닌 항목이 이름순으로 먼저 오게 title을 앞세운다("Aaa" < "Zzz-candidate").
            non_candidate = await _make_story(s, org.id, project.id, title="Aaa non-candidate")
            candidate = await _make_story(s, org.id, project.id, title="Zzz-candidate target")
            await _insert_candidate(
                s, org_id=org.id, source_id=source.id, target_id=candidate.id,
                snippet="이건 #123 를 가리키는 스니펫",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/stories",
                params={
                    "project_id": str(project.id), "q": "candidate",
                    "boost_candidates_from": str(source.id),
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            # candidate가 검색어("candidate")에 매치되고, non_candidate는 매치 안 되므로
            # 정렬 판정 자체보다 "이유 필드가 실렸는가"가 이 테스트의 핵심.
            matched = [r for r in body if r["id"] == str(candidate.id)]
            assert len(matched) == 1
            assert matched[0]["is_reference_candidate"] is True
            assert matched[0]["matched_snippet"] == "이건 #123 를 가리키는 스니펫"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_non_candidate_has_false_and_none_not_mixed():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            plain = await _make_story(s, org.id, project.id, title="Plain story")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/stories",
                params={"project_id": str(project.id), "boost_candidates_from": str(source.id)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            row = next(r for r in body if r["id"] == str(plain.id))
            assert row["is_reference_candidate"] is False
            assert row["matched_snippet"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_boost_reorders_but_does_not_filter():
    """유나 규격③ — 매칭 안 되는 항목도 결과에서 사라지지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            candidate = await _make_story(s, org.id, project.id, title="Candidate")
            unrelated_a = await _make_story(s, org.id, project.id, title="Unrelated A")
            unrelated_b = await _make_story(s, org.id, project.id, title="Unrelated B")
            await _insert_candidate(s, org_id=org.id, source_id=source.id, target_id=candidate.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/stories",
                params={"project_id": str(project.id), "boost_candidates_from": str(source.id)},
            )
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert str(candidate.id) in ids
            assert str(unrelated_a.id) in ids
            assert str(unrelated_b.id) in ids
            assert str(source.id) in ids  # source 자기 자신도 목록에서 안 사라진다
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_boost_works_with_empty_q():
    """유나 규격② 전제 — q 없이 boost_candidates_from만 줘도 동작(검색어 치기 前 기본목록)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            candidate = await _make_story(s, org.id, project.id, title="Zzz Candidate")
            await _make_story(s, org.id, project.id, title="Aaa Other")
            await _insert_candidate(s, org_id=org.id, source_id=source.id, target_id=candidate.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/stories",
                params={"project_id": str(project.id), "boost_candidates_from": str(source.id)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            candidate_row = next(r for r in body if r["id"] == str(candidate.id))
            assert candidate_row["is_reference_candidate"] is True
            # "Zzz Candidate"는 제목순으로는 뒤인데 후보라 앞으로 왔는지 확인.
            ids_in_order = [r["id"] for r in body]
            assert ids_in_order.index(str(candidate.id)) < ids_in_order.index(str(source.id))
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_declared_candidate_not_boosted():
    """status='declared'(이미 사람이 승격시킨 것)는 "제안"이 아니므로 재정렬 대상이 아니다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            source = await _make_story(s, org.id, project.id, title="Source")
            declared_target = await _make_story(s, org.id, project.id, title="Declared target")
            await _insert_candidate(
                s, org_id=org.id, source_id=source.id, target_id=declared_target.id,
                status="declared",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/stories",
                params={"project_id": str(project.id), "boost_candidates_from": str(source.id)},
            )
            assert resp.status_code == 200, resp.text
            row = next(r for r in resp.json() if r["id"] == str(declared_target.id))
            assert row["is_reference_candidate"] is False
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_no_boost_param_leaves_fields_at_default():
    """기존 호출부(boost_candidates_from 없음)는 두 필드가 항상 False/None으로 빠진다 —
    회귀 없음(다른 모든 /api/v2/stories 소비처에 영향 없음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            await _make_story(s, org.id, project.id, title="Plain")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/stories", params={"project_id": str(project.id)})
            assert resp.status_code == 200, resp.text
            for row in resp.json():
                assert row["is_reference_candidate"] is False
                assert row["matched_snippet"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
