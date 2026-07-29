"""story #2269(C-11) AC0-2 축A + AC1 — story description/acceptance_criteria의 대괄호 없는
`#<번호>`(«맨 번호» 원석, 사람이 손으로 쓰는 대부분의 참조 모양)를 저장 시 entity_references에
form='mention'으로 관찰 수집한다(doc `c11-2269-ac0-findings` AC0-2 축A/축B 구분 참조 — 이
테스트는 축A, 원문 rewrite 없음).

핵심 판정:
  AC0-3(세는 정의): `extract_bare_number_candidates` — word-boundary, 코드블록/인라인 코드
    제외, 중복 제거(순수 함수, DB 없음).
  AC1-project-scope(AC0-2에서 지목한 진짜 위험): `story_number`는 project_id 유일(org 유일
    아님) — 다른 project의 같은 번호 story는 «해소되면 안 된다»(교차 프로젝트 오연결 방지).
  AC1-존재하지 않는 번호: 조용히 스킵(다른 추출기와 동형 malformed-tolerance).
  AC1-대괄호+맨번호 동일 대상: 두 문법이 같은 story를 가리키면 참조 행은 하나(3튜플 set diff).
  AC1-재조정: 맨 번호를 지우면 참조도 사라진다(#2301과 동일 diff 계약을 상속).
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
    _refs,
    _session_factory,
    _setup_app_human,
    _token,
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


# ─── AC0-3: 순수 추출 함수(DB 없음) ──────────────────────────────────────────


def test_extract_bare_number_candidates_word_boundary_and_dedupe():
    from app.services.mention_parser import extract_bare_number_candidates

    result = extract_bare_number_candidates(
        "이건 #2258 참조고 #2258 또 나오고 #99 도 있는지라. ##2260은 아니고 foo#2261도 아님."
    )
    assert result == [2258, 99]  # 중복 제거 + ##·foo# 오탐 배제, 순서 보존


def test_extract_bare_number_candidates_excludes_fenced_code_block():
    from app.services.mention_parser import extract_bare_number_candidates

    content = "실참조 #100.\n```\n예시: #200 은 코드블록 안이라 참조 아님\n```\n또 실참조 #300."
    assert extract_bare_number_candidates(content) == [100, 300]


def test_extract_bare_number_candidates_excludes_inline_code_span():
    from app.services.mention_parser import extract_bare_number_candidates

    assert extract_bare_number_candidates("본문 #100, 코드 `#200 예시`, 다시 #300") == [100, 300]


def test_extract_bare_number_candidates_empty_content():
    from app.services.mention_parser import extract_bare_number_candidates

    assert extract_bare_number_candidates("") == []
    assert extract_bare_number_candidates(None) == []  # type: ignore[arg-type]


# ─── AC1: write-path 통합(실PG) ──────────────────────────────────────────────


async def test_bare_number_referencing_story_in_same_project_creates_reference():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 4242
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "이건 #4242 를 가리키는지라 (맨 번호, 대괄호 없음)"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                refs = await _refs(s, org.id, story.id, source_field="description")
                assert len(refs) == 1
                assert refs[0].target_type == "story"
                assert refs[0].target_id == target.id
                assert refs[0].form == "mention"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_bare_number_matching_story_number_in_different_project_is_not_resolved():
    """AC0-2가 지목한 진짜 위험: story_number는 project_id 유일이지 org 유일이 아니다 — 다른
    project의 같은 번호 story가 잘못 해소되면 교차 프로젝트 오연결이 된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, name="A")
            project_b = await _make_project(s, org.id, name="B")
            caller_id, caller_user_id = await _make_human_member(s, org.id, project_a.id)
            # ⛔같은 org, 다른 project(B)에 같은 번호(4242)의 story가 존재.
            other_project_story = await _make_story(s, org.id, project_b.id, title="OtherProjectTarget")
            other_project_story.story_number = 4242
            await s.commit()
            story = await _make_story(s, org.id, project_a.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "이건 #4242 참조지만 project A에서 쓰인 것이라"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                refs = await _refs(s, org.id, story.id, source_field="description")
                assert refs == [], (
                    "다른 project의 story_number가 잘못 해소됐다(교차 프로젝트 오연결)"
                )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_bare_number_with_no_matching_story_is_silently_skipped():
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
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "존재하지 않는 #999999 참조인지라"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                refs = await _refs(s, org.id, story.id, source_field="description")
                assert refs == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_bracket_syntax_and_bare_number_to_same_story_dedupe_to_one_reference():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 5151
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={
                    "description": (
                        _token("Target", "story", target.id) + " 그리고 같은 대상을 #5151 로도 가리키는지라"
                    ),
                },
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                refs = await _refs(s, org.id, story.id, source_field="description")
                assert len(refs) == 1, "대괄호 문법과 맨 번호가 같은 대상을 가리키면 참조는 하나여야 한다"
                assert refs[0].target_id == target.id
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_removing_bare_number_from_description_removes_its_reference():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_story(s, org.id, project.id, title="Target")
            target.story_number = 6161
            await s.commit()
            story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            seed = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": "#6161 참조가 있는지라"},
            )
            assert seed.status_code == 200, seed.text
            async with Session() as s:
                before = await _refs(s, org.id, story.id, source_field="description")
                assert len(before) == 1

            resp = await client.patch(f"/api/v2/stories/{story.id}", json={"description": "참조를 지운지라"})
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                after = await _refs(s, org.id, story.id, source_field="description")
                assert after == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
