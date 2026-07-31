"""story #2363([보안·CRITICAL], 오르테가/까심 실측 2026-07-31) — reference-candidate
쓰기 경로 다섯이 «다른 프로젝트»의 연결을 만들고 지우던 IDOR을 실PG로 재현·검증한다.

결함의 모양: 라우터는 URL의 `{id}` story에 대해서만 `_assert_story_project_access`를
부른다. 그런데 실제로 «만지는» 대상(①의 target_id, ②~⑤의 candidate.source_id)은 org_id
로만 걸러졌지 project 접근권을 한 번도 검사받지 않았다 — 검사한 것과 만지는 것이 달랐다.

⛔이 파일이 «각각» 재는 다섯 자리(하나만 재면 나머지 넷이 안 잡힌다, AC1):
  ① POST   /{id}/reference-candidates                (target이 남의 프로젝트)
  ② POST   /{id}/reference-candidates/{cid}/declare        (candidate가 남의 것)
  ③ POST   /{id}/reference-candidates/{cid}/relation-kind  (같음)
  ④ POST   /{id}/reference-candidates/{cid}/reject         (같음)
  ⑤ DELETE /{id}/reference-candidates/{cid}                (같음)

각 자리마다 3중 대조를 함께 잰다(AC2/AC3):
  - cross-project 대상 → 404 (결함이 고쳐졌는가)
  - 같은-project 대상(양성대조) → 여전히 200/201 (기능이 안 죽었는가 — 전부 404로 막아도
    "cross-project가 404"는 통과하고, 그러면 이 라우트가 죽은 채로 그린이 된다)
  - 「없는 id」와 「있지만 접근 못 하는 id」가 같은 응답(존재 비노출, AC3)
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


async def _make_candidate(
    session, org_id, source_id, target_id, *, status="estimated", relation_kind=None,
):
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate as RSC
    c = RSC(
        id=uuid.uuid4(), org_id=org_id, source_type="story", source_field="body",
        source_id=source_id, target_type="story", target_id=target_id, form="mention",
        relation_kind=relation_kind, matched_keyword=None, snippet="",
        status=status, declared_by=None, declared_at=None,
    )
    session.add(c)
    await session.commit()
    return c


async def _setup_two_projects(s, org):
    """caller는 project_a 접근권만 있다. project_b는 caller에게 «남의 프로젝트»다."""
    project_a = await _make_project(s, org.id, name="A")
    project_b = await _make_project(s, org.id, name="B")
    caller_id, caller_user_id = await _make_human_member(s, org.id, project_a.id)
    return project_a, project_b, caller_id, caller_user_id


NONEXISTENT_ID = uuid.UUID("00000000-0000-0000-0000-000000000000")


# ─── ① POST /{id}/reference-candidates — target이 남의 프로젝트 ─────────────


async def test_1_declare_new_target_cross_project_404_and_positive_control():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a, project_b, caller_id, caller_user_id = await _setup_two_projects(s, org)
            source_a = await _make_story(s, org.id, project_a.id, title="Source(A)")
            target_a = await _make_story(s, org.id, project_a.id, title="Target(A, accessible)")
            target_b = await _make_story(s, org.id, project_b.id, title="Target(B, inaccessible)")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            # cross-project target → 404 (결함 고쳐졌는가)
            resp_cross = await client.post(
                f"/api/v2/stories/{source_a.id}/reference-candidates",
                json={"target_id": str(target_b.id)},
            )
            assert resp_cross.status_code == 404, resp_cross.text

            # nonexistent target → 같은 404 (존재 비노출, AC3)
            resp_nonexistent = await client.post(
                f"/api/v2/stories/{source_a.id}/reference-candidates",
                json={"target_id": str(NONEXISTENT_ID)},
            )
            assert resp_nonexistent.status_code == resp_cross.status_code == 404
            assert resp_nonexistent.json() == resp_cross.json(), (
                "「없는 target」과 「접근 못 하는 target」의 응답이 달라 존재가 샌다"
            )

            # 양성대조 — 같은 프로젝트 target은 여전히 201 (AC2)
            resp_ok = await client.post(
                f"/api/v2/stories/{source_a.id}/reference-candidates",
                json={"target_id": str(target_a.id)},
            )
            assert resp_ok.status_code == 201, resp_ok.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ② declare — candidate.source_id가 남의 프로젝트 story ──────────────────


async def test_2_declare_cross_project_source_404_and_positive_control():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a, project_b, caller_id, caller_user_id = await _setup_two_projects(s, org)
            accessible_story = await _make_story(s, org.id, project_a.id, title="Accessible(A)")
            victim_story = await _make_story(s, org.id, project_b.id, title="Victim(B)")
            target = await _make_story(s, org.id, project_b.id, title="Target(B)")
            # candidate는 victim_story(project_b, caller 접근 불가) 소유다.
            victim_candidate = await _make_candidate(s, org.id, victim_story.id, target.id)
            # 양성대조용 — caller가 실제로 접근 가능한 story가 source인 candidate.
            own_target = await _make_story(s, org.id, project_a.id, title="OwnTarget(A)")
            own_candidate = await _make_candidate(s, org.id, accessible_story.id, own_target.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            # URL의 {id}는 caller가 접근 가능한 story(accessible_story)지만, candidate는
            # 남의 project(project_b) story 소유다 — 이전엔 org_id만 걸러 통과했다.
            resp_cross = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{victim_candidate.id}/declare",
            )
            assert resp_cross.status_code == 404, resp_cross.text

            resp_nonexistent = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{NONEXISTENT_ID}/declare",
            )
            assert resp_nonexistent.status_code == resp_cross.status_code == 404
            assert resp_nonexistent.json() == resp_cross.json()

            # 양성대조 — 진짜 자기 candidate는 여전히 declare된다.
            resp_ok = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{own_candidate.id}/declare",
            )
            assert resp_ok.status_code == 200, resp_ok.text
            assert resp_ok.json()["status"] == "declared"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ③ relation-kind — 같은 모양 ─────────────────────────────────────────────


async def test_3_relation_kind_cross_project_source_404_and_positive_control():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a, project_b, caller_id, caller_user_id = await _setup_two_projects(s, org)
            accessible_story = await _make_story(s, org.id, project_a.id, title="Accessible(A)")
            victim_story = await _make_story(s, org.id, project_b.id, title="Victim(B)")
            target = await _make_story(s, org.id, project_b.id, title="Target(B)")
            victim_candidate = await _make_candidate(s, org.id, victim_story.id, target.id)
            own_target = await _make_story(s, org.id, project_a.id, title="OwnTarget(A)")
            own_candidate = await _make_candidate(s, org.id, accessible_story.id, own_target.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp_cross = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{victim_candidate.id}/relation-kind",
                json={"relation_kind": "followed"},
            )
            assert resp_cross.status_code == 404, resp_cross.text

            resp_nonexistent = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{NONEXISTENT_ID}/relation-kind",
                json={"relation_kind": "followed"},
            )
            assert resp_nonexistent.status_code == resp_cross.status_code == 404
            assert resp_nonexistent.json() == resp_cross.json()

            resp_ok = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{own_candidate.id}/relation-kind",
                json={"relation_kind": "followed"},
            )
            assert resp_ok.status_code == 200, resp_ok.text
            assert resp_ok.json()["relation_kind"] == "followed"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ④ reject — 같은 모양 ─────────────────────────────────────────────────────


async def test_4_reject_cross_project_source_404_and_positive_control():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a, project_b, caller_id, caller_user_id = await _setup_two_projects(s, org)
            accessible_story = await _make_story(s, org.id, project_a.id, title="Accessible(A)")
            victim_story = await _make_story(s, org.id, project_b.id, title="Victim(B)")
            target = await _make_story(s, org.id, project_b.id, title="Target(B)")
            victim_candidate = await _make_candidate(s, org.id, victim_story.id, target.id)
            own_target = await _make_story(s, org.id, project_a.id, title="OwnTarget(A)")
            own_candidate = await _make_candidate(s, org.id, accessible_story.id, own_target.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp_cross = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{victim_candidate.id}/reject",
                json={},
            )
            assert resp_cross.status_code == 404, resp_cross.text

            resp_nonexistent = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{NONEXISTENT_ID}/reject",
                json={},
            )
            assert resp_nonexistent.status_code == resp_cross.status_code == 404
            assert resp_nonexistent.json() == resp_cross.json()

            resp_ok = await client.post(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{own_candidate.id}/reject",
                json={},
            )
            assert resp_ok.status_code == 200, resp_ok.text

            # victim_candidate는 여전히 존재해야 한다(공격자 호출이 실제로 아무것도 못 지웠다).
            async with Session() as s:
                from sqlalchemy import select
                from app.models.reference_semantic_candidate import ReferenceSemanticCandidate as RSC
                still_there = (await s.execute(
                    select(RSC).where(RSC.id == victim_candidate.id)
                )).scalar_one_or_none()
                assert still_there is not None, "cross-project reject 호출이 실제로 남의 행을 지웠다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ⑤ DELETE(undeclare) — 같은 모양 ─────────────────────────────────────────


async def test_5_undeclare_cross_project_source_404_and_positive_control():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a, project_b, caller_id, caller_user_id = await _setup_two_projects(s, org)
            accessible_story = await _make_story(s, org.id, project_a.id, title="Accessible(A)")
            victim_story = await _make_story(s, org.id, project_b.id, title="Victim(B)")
            target = await _make_story(s, org.id, project_b.id, title="Target(B)")
            # undeclare는 status='declared'만 지운다 — 양쪽 다 declared로 심는다.
            victim_candidate = await _make_candidate(
                s, org.id, victim_story.id, target.id, status="declared",
            )
            own_target = await _make_story(s, org.id, project_a.id, title="OwnTarget(A)")
            own_candidate = await _make_candidate(
                s, org.id, accessible_story.id, own_target.id, status="declared",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp_cross = await client.delete(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{victim_candidate.id}",
            )
            assert resp_cross.status_code == 404, resp_cross.text

            resp_nonexistent = await client.delete(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{NONEXISTENT_ID}",
            )
            assert resp_nonexistent.status_code == resp_cross.status_code == 404
            assert resp_nonexistent.json() == resp_cross.json()

            resp_ok = await client.delete(
                f"/api/v2/stories/{accessible_story.id}/reference-candidates/{own_candidate.id}",
            )
            assert resp_ok.status_code == 200, resp_ok.text

            async with Session() as s:
                from sqlalchemy import select
                from app.models.reference_semantic_candidate import ReferenceSemanticCandidate as RSC
                still_there = (await s.execute(
                    select(RSC).where(RSC.id == victim_candidate.id)
                )).scalar_one_or_none()
                assert still_there is not None, "cross-project undeclare 호출이 실제로 남의 행을 지웠다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC7: 못 잡는 것 선언 — 이 네 서비스 함수를 부르는 caller가 stories.py 하나뿐인가 ──


def test_only_stories_router_calls_the_four_candidate_service_functions():
    """epic·doc 등 다른 source_type이 declare_candidate 등을 부르는 자리가 있으면 그
    자리도 이번 고침(source_id 필수화)의 영향을 받으므로 반드시 같이 세어야 한다 —
    코드 스캔으로 "그런 자리가 없다"를 직접 확認(AC7)."""
    import ast
    from pathlib import Path

    routers_dir = Path(__file__).parent.parent / "app" / "routers"
    target_funcs = {
        "declare_candidate", "set_candidate_relation_kind",
        "undeclare_candidate", "reject_candidate",
    }
    callers = set()
    for path in routers_dir.glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
                if name in target_funcs:
                    callers.add(path.name)
    assert callers == {"stories.py"}, (
        f"declare/relation-kind/reject/undeclare_candidate를 부르는 라우터가 stories.py "
        f"하나가 아니다: {callers} — 이번 source_id 필수화가 그 자리들도 갱신해야 한다"
    )
