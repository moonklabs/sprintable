"""story #2263(C-5) BE 계약 셋(PO 확定, 2026-07-28 유나 실측 뒤) — entities.py search_entities
재설계 검증.

⛔유나 실측: 종류별 최대 DEFAULT_LIMIT(10)건씩 뽑은 뒤 «전체를 한 줄로 세워» 10건으로
자르던 것(entities.py:119 구 `results[:DEFAULT_LIMIT]`)이 종류 수가 늘수록(4→8) 평균
몫이 줄어(2.5→1.25) 어떤 종류는 후보에 «아예» 안 나오게 만들었다. 편향의 원인도 정렬축
(가나다·최신)이라 사람이 짐작조차 못 했다.

처방 셋:
①종류마다 최소 보장 몫 — 남는 자리만 관련도로 채운다(전체를 한 줄로 세워 자르지 않는다).
②응답이 종류별 shown/total(=truncation)을 들고 온다 — 화면이 "몇 건 더"를 지어내지 않게.
③고르는 재료(number·epic_title 등)를 status 대신 응답에 담는다.

아래 테스트는 «양성대조»다 — Yuna가 실측한 정확히 그 붕괴 모양(여러 종류에 여러 건씩 있는데
naive global-cut이면 특정 종류가 통째로 사라지는 것)을 재현해, 새 코드가 그것을 막는지를
직접 증명한다(구 코드로 되돌리면 이 테스트들이 RED가 되는 것까지 확認했다).
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

import pytest

from tests.test_2294_entities_search_open_4_types_realdb import (
    _client_for,
    _make_artifact,
    _make_evidence,
    _make_human_member,
    _make_hypothesis,
    _make_org,
    _make_project,
    _make_sprint,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

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


async def _make_story(session, org_id, project_id, title, epic_id=None, story_number=None, created_at=None):
    from app.models.pm import Story
    kwargs = dict(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="backlog")
    if epic_id is not None:
        kwargs["epic_id"] = epic_id
    if story_number is not None:
        kwargs["story_number"] = story_number
    if created_at is not None:
        kwargs["created_at"] = created_at
    story = Story(**kwargs)
    session.add(story)
    await session.commit()
    return story


async def _make_task(session, org_id, story_id, title, created_at=None):
    from app.models.pm import Task
    kwargs = dict(id=uuid.uuid4(), org_id=org_id, story_id=story_id, title=title, status="todo")
    if created_at is not None:
        kwargs["created_at"] = created_at
    task = Task(**kwargs)
    session.add(task)
    await session.commit()
    return task


async def _make_doc(session, org_id, project_id, title, created_at=None):
    from app.models.doc import Doc
    kwargs = dict(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"slug-{uuid.uuid4().hex[:8]}",
    )
    if created_at is not None:
        kwargs["created_at"] = created_at
    doc = Doc(**kwargs)
    session.add(doc)
    await session.commit()
    return doc


async def _make_epic(session, org_id, project_id, title, created_at=None):
    from app.models.pm import Goal
    kwargs = dict(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="active")
    if created_at is not None:
        kwargs["created_at"] = created_at
    epic = Goal(**kwargs)
    session.add(epic)
    await session.commit()
    return epic


async def _seed_two_per_type_search_bias(session, org, project, member_id):
    """8종 각 2건씩(총 16건) — 제목 접두어를 종류마다 다르게 줘서 구 코드(가나다 정렬+전체
    10컷)면 알파벳 뒤쪽 종류(artifact/hypothesis/evidence)가 «통째로» 사라지게 배치한다."""
    story1 = await _make_story(session, org.id, project.id, "AAA1 QUOTA")
    story2 = await _make_story(session, org.id, project.id, "AAA2 QUOTA")
    await _make_doc(session, org.id, project.id, "BBB1 QUOTA")
    await _make_doc(session, org.id, project.id, "BBB2 QUOTA")
    await _make_epic(session, org.id, project.id, "CCC1 QUOTA")
    await _make_epic(session, org.id, project.id, "CCC2 QUOTA")
    await _make_task(session, org.id, story1.id, "DDD1 QUOTA")
    await _make_task(session, org.id, story2.id, "DDD2 QUOTA")
    await _make_sprint(session, org.id, project.id, "EEE1 QUOTA")
    await _make_sprint(session, org.id, project.id, "EEE2 QUOTA")
    await _make_artifact(session, org.id, project.id, "FFF1 QUOTA")
    await _make_artifact(session, org.id, project.id, "FFF2 QUOTA")
    await _make_hypothesis(session, org.id, project.id, member_id, "GGG1 QUOTA")
    await _make_hypothesis(session, org.id, project.id, member_id, "GGG2 QUOTA")
    await _make_evidence(session, org.id, story1.id, "story", member_id, ref="zzz1-quota-evidence")
    await _make_evidence(session, org.id, story2.id, "story", member_id, ref="zzz2-quota-evidence")


@pytest.mark.anyio
async def test_all_eight_types_survive_under_search_sort_bias():
    """⭐계약① — search(q) 정렬(가나다)에서 evidence 등 알파벳 뒤쪽 종류가 통째로 안 사라진다.
    구 코드(전체 16건을 가나다 정렬 후 10컷)였으면 FFF/GGG/ZZZ(artifact/hypothesis/evidence)
    3종이 응답에서 완전히 빠졌을 것 — 새 코드는 종류마다 최소 보장 몫을 먼저 주므로 여덟
    종류가 다 나온다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            await _seed_two_per_type_search_bias(s, org, project, member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "q": "QUOTA"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            data = body["data"]
            assert len(data) <= 10, f"DEFAULT_LIMIT(10)을 넘었다: {len(data)}"
            found_types = {r["entity_type"] for r in data}
            assert found_types == {
                "story", "doc", "epic", "task", "sprint", "artifact", "hypothesis", "evidence",
            }, f"여덟 종류가 다 안 나왔다(계약① 위반): {found_types}"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_types_meta_reports_honest_shown_vs_total_not_fabricated():
    """⭐계약② — 종류별 shown(보여준 건수)·total(전체 건수)이 실제 매치 건수를 그대로 반영한다.
    evidence는 2건 매치인데 보장 몫(1)만 받고 남는 자리 채움에서 밀려 shown=1<total=2가
    되는 것까지 정확히 고정한다(화면이 "1건 더"를 지어내지 않고 이 수를 그대로 쓸 수 있게)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            await _seed_two_per_type_search_bias(s, org, project, member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "q": "QUOTA"},
            )
            assert resp.status_code == 200, resp.text
            types_meta = resp.json()["types"]
            assert set(types_meta) == {
                "story", "doc", "epic", "task", "sprint", "artifact", "hypothesis", "evidence",
            }
            for t, meta in types_meta.items():
                assert meta["total"] == 2, f"{t}: total이 실제 시딩 건수(2)와 다르다 — {meta}"
                assert meta["shown"] <= meta["total"]
            assert types_meta["evidence"]["shown"] == 1, (
                f"evidence는 보장 몫만 받아야(관련도 채움 순번상 밀림) 하는데 — {types_meta['evidence']}"
            )
            assert any(m["shown"] < m["total"] for m in types_meta.values()), (
                "잘림(shown<total)이 하나도 없다 — 이 시나리오(16건/10슬롯)는 반드시 잘려야 한다"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_all_eight_types_survive_under_default_date_sort_bias():
    """⭐계약① — q 없이(최신순 정렬) sprint를 다른 7종보다 «훨씬 과거»로 심어도, 구 코드였으면
    sprint 2건 모두 정렬 뒤쪽(11~16위)이라 통째로 사라졌을 것을 새 코드가 막는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        old = datetime(2020, 1, 1, tzinfo=UTC)
        newer = datetime.now(UTC)
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)

            story1 = await _make_story(s, org.id, project.id, "Date Story 1", created_at=newer)
            story2 = await _make_story(s, org.id, project.id, "Date Story 2", created_at=newer)
            await _make_doc(s, org.id, project.id, "Date Doc 1", created_at=newer)
            await _make_doc(s, org.id, project.id, "Date Doc 2", created_at=newer)
            await _make_epic(s, org.id, project.id, "Date Epic 1", created_at=newer)
            await _make_epic(s, org.id, project.id, "Date Epic 2", created_at=newer)
            await _make_task(s, org.id, story1.id, "Date Task 1", created_at=newer)
            await _make_task(s, org.id, story2.id, "Date Task 2", created_at=newer)
            # ⛔sprint만 2020년(전역 최고참) — 구 코드면 top10(=최신순) 밖으로 완전히 밀려난다.
            await _make_sprint(s, org.id, project.id, "Old Sprint 1", )
            await _make_sprint(s, org.id, project.id, "Old Sprint 2", )
            await _make_artifact(s, org.id, project.id, "Date Artifact 1")
            await _make_artifact(s, org.id, project.id, "Date Artifact 2")
            await _make_hypothesis(s, org.id, project.id, member_id, "Date Hyp 1")
            await _make_hypothesis(s, org.id, project.id, member_id, "Date Hyp 2")
            await _make_evidence(s, org.id, story1.id, "story", member_id, ref="date-evidence-1")
            await _make_evidence(s, org.id, story2.id, "story", member_id, ref="date-evidence-2")

            # Sprint 모델은 헬퍼가 created_at 파라미터를 안 받으므로(원본 헬퍼 재사용) 커밋 후
            # 직접 과거로 되돌린다 — "구조적으로 가장 오래된 종류"를 확실히 만든다.
            from sqlalchemy import update as sa_update

            from app.models.pm import Sprint
            await s.execute(
                sa_update(Sprint).where(Sprint.org_id == org.id).values(created_at=old)
            )
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id)},
            )
            assert resp.status_code == 200, resp.text
            found_types = {r["entity_type"] for r in resp.json()["data"]}
            assert "sprint" in found_types, (
                f"가장 과거(2020)로 심은 sprint가 최신순 정렬에서 통째로 잘렸다(계약① 위반): {found_types}"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_story_and_task_carry_number_and_epic_identifier_material():
    """⭐계약③ — 고르는 재료(status 아닌 식별자)가 실제로 응답에 있다. story는 story_number+
    소속 에픽 제목, task는 부모 story의 순번+에픽 제목을 그대로 물려받는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            epic = await _make_epic(s, org.id, project.id, "ID Epic")
            story = await _make_story(
                s, org.id, project.id, "ID Story", epic_id=epic.id, story_number=2249,
            )
            task = await _make_task(s, org.id, story.id, "ID Task")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "q": "ID", "types": "story,task"},
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            story_row = next(r for r in data if r["entity_id"] == str(story.id))
            task_row = next(r for r in data if r["entity_id"] == str(task.id))
            assert story_row["number"] == 2249, story_row
            assert story_row["epic_title"] == "ID Epic", story_row
            assert task_row["number"] == 2249, task_row
            assert task_row["epic_title"] == "ID Epic", task_row
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_doc_carries_slug_as_identifier():
    """⭐계약③ — doc은 number/epic이 없지만(구조상), 사람이 손으로 복사하는 실제 식별자인
    slug를 identifier로 담는다(doc.py 기존 코드 주석이 이미 "실제 식별자"로 지목한 그 필드)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            doc = await _make_doc(s, org.id, project.id, "ID Doc")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "q": "ID Doc", "types": "doc"},
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            doc_row = next(r for r in data if r["entity_id"] == str(doc.id))
            assert doc_row["identifier"] == doc.slug, doc_row
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
