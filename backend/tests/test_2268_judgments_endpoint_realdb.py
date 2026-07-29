"""story #2268(D단계, E-CONNECT — "판단 칸") — POST/GET /api/v2/judgments 엔드포인트 실PG 검증.

오르테가 AC(2026-07-29, 스레드 7256d5cc) 7개를 그대로 잰다:
  ①Evidence 카운트 오염 없음(judgment 삽입 전후 batch_has_evidence·GET /evidence·
    glance proof_count 변화 0)
  ②철회는 캡을 안 받는다(active는 잘리고 retractions는 전량)
  ③omitted_count가 정확한 수
  ④method 축 역추적(?method=Y로 같은 방법으로 낸 다른 말들이 함께 나옴)
  ⑤scope 위반이 API 층에서 422로 거절(DB CHECK가 아니라 사람이 읽을 메시지로)
  ⑥⛔"PO가 실제로 한 건 쓴다"는 이 PR의 몫이 아니다 — 여기선 그 «메커니즘»만 증명한다
    (scope=general 항목이 실제로 GET /judgments?scope=general로 나오는가). 실사용은 배포
    후 오르테가 본인이 라이브로 한다(AC 원문 그대로).
  ⑦이 판이 못 잡는 것: `app/routers/judgments.py` 모듈 docstring 참조(progress.txt 실삭제·
    "철회를 다시 주장 안 하는가"는 다음 세션에서만 관측 가능).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


# ─── Seeding helpers(test_2266_story_backlinks_realdb.py와 동형 — 이 파일 자체 완결) ──


async def _make_org(session, name="Org"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name="Human")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="backlog")
    session.add(story)
    await session.commit()
    return story


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


# ─── ①Evidence 카운트 오염 없음 ──────────────────────────────────────────────


async def test_judgment_insert_does_not_move_evidence_signals():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            from app.services.evidence_service import batch_has_evidence

            async with Session() as s:
                before_batch = await batch_has_evidence(s, [story.id], "story")

            before_evidence = await client.get(
                "/api/v2/evidence", params={"work_item_id": str(story.id), "work_item_type": "story"},
            )
            before_glance = await client.get("/api/v2/glance/hero", params={"story_id": str(story.id)})
            assert before_evidence.status_code == 200, before_evidence.text
            assert before_glance.status_code == 200, before_glance.text

            resp = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "items", "work_item_ids": [str(story.id)], "kind": "judgment",
                    "statement": "이 스토리는 realdb로 검증됨",
                },
            )
            assert resp.status_code == 201, resp.text

            async with Session() as s:
                after_batch = await batch_has_evidence(s, [story.id], "story")
            after_evidence = await client.get(
                "/api/v2/evidence", params={"work_item_id": str(story.id), "work_item_type": "story"},
            )
            after_glance = await client.get("/api/v2/glance/hero", params={"story_id": str(story.id)})

            assert before_batch == after_batch == set()
            assert before_evidence.json() == after_evidence.json() == []
            assert before_glance.json()["proof_count"] == after_glance.json()["proof_count"] == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ②③철회 uncapped + omitted_count 정확 ────────────────────────────────────


async def test_retractions_uncapped_active_capped_with_accurate_omitted_count():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            active_ids = []
            for i in range(5):
                resp = await client.post(
                    "/api/v2/judgments",
                    json={
                        "scope": "general", "kind": "judgment",
                        "statement": f"active lesson {i}",
                    },
                )
                assert resp.status_code == 201, resp.text
                active_ids.append(resp.json()["id"])

            retraction_ids = []
            for target_id in active_ids[:3]:
                resp = await client.post(
                    "/api/v2/judgments",
                    json={
                        "scope": "general", "kind": "retraction", "target_id": target_id,
                        "statement": f"retract {target_id}",
                    },
                )
                assert resp.status_code == 201, resp.text
                retraction_ids.append(resp.json()["id"])

            resp = await client.get("/api/v2/judgments", params={"scope": "general", "limit": 2})
            assert resp.status_code == 200, resp.text
            body = resp.json()

            assert len(body["active"]) == 2, body["active"]
            assert {r["id"] for r in body["retractions"]} == set(retraction_ids), body["retractions"]
            assert len(body["retractions"]) == 3

            assert body["meta"]["capped"] is True
            assert body["meta"]["cap_basis"] == "recency"
            # active 총량 = 5(judgment) + 3(retraction은 active 아님) = 5. 2건 반환 → 3건 누락.
            assert body["meta"]["omitted_count"] == 3, body["meta"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ④method 축 역추적 ────────────────────────────────────────────────────────


async def test_method_filter_surfaces_all_statements_produced_by_same_method():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            method = f"grep-based-scan-{uuid.uuid4().hex[:8]}"

            r1 = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "judgment", "method": method,
                    "statement": "이 스토리들은 grep으로 훑어 안전하다고 판단",
                },
            )
            assert r1.status_code == 201, r1.text
            r2 = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "judgment", "method": method,
                    "statement": "다른 이슈도 같은 grep 방법으로 판단",
                },
            )
            assert r2.status_code == 201, r2.text
            r3 = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "method_error", "method": method,
                    "target_id": r1.json()["id"],
                    "statement": "grep 스캔이 동적 import를 놓쳤다 — 세는 법이 틀림",
                },
            )
            assert r3.status_code == 201, r3.text

            # 무관한 다른 method — 역추적 결과에 안 섞이는지 확인(양성대조).
            r_other = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "judgment", "method": "different-method",
                    "statement": "다른 방법으로 낸 말",
                },
            )
            assert r_other.status_code == 201, r_other.text

            resp = await client.get("/api/v2/judgments", params={"method": method})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            active_ids = {j["id"] for j in body["active"]}
            assert active_ids == {r1.json()["id"], r2.json()["id"], r3.json()["id"]}
            assert r_other.json()["id"] not in active_ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ⑤scope 위반 API 층 422 거절 ─────────────────────────────────────────────


async def test_items_scope_empty_work_item_ids_rejected_with_422_not_500():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/judgments",
                json={"scope": "items", "work_item_ids": [], "kind": "judgment", "statement": "x"},
            )
            assert resp.status_code == 422, resp.text
            assert "work_item_ids" in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_general_scope_nonempty_work_item_ids_rejected_with_422_not_500():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "work_item_ids": [str(story.id)], "kind": "judgment",
                    "statement": "x",
                },
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_meta_kind_without_target_id_rejected_with_422_not_500():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/judgments",
                json={"scope": "general", "kind": "retraction", "statement": "무엇을 철회하는지 모름"},
            )
            assert resp.status_code == 422, resp.text
            assert "target_id" in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ⑥scope=general 메커니즘 증명(실사용 자체는 오르테가가 라이브로) ───────────


async def test_general_scope_entry_is_pullable_via_scope_filter():
    """⭐AC⑥의 «메커니즘» 절반 — scope=general로 넣은 항목이 scope=general 필터로 실제로
    나오는가. "PO가 실제로 한 건 쓴다"(도는 자리 증명)는 배포 후 오르테가 본인의 라이브
    액션이라 이 PR의 realdb 테스트로 대신할 수 없다(AC 원문이 그렇게 요구한다 — 대체 아님,
    이건 그 전제가 되는 배관이 실제로 도는지만 증명)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            # method_error(㉡)는 target_id 필수이므로 먼저 ㉠(judgment) 하나를 세운다.
            original = await client.post(
                "/api/v2/judgments",
                json={"scope": "general", "kind": "judgment", "statement": "부분 체크로 판단함"},
            )
            assert original.status_code == 201, original.text
            correction = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "method_error", "target_id": original.json()["id"],
                    "statement": "CI 초록 오독 — 부분 체크만 보고 끝났다 판단",
                },
            )
            assert correction.status_code == 201, correction.text

            listed = await client.get("/api/v2/judgments", params={"scope": "general"})
            assert listed.status_code == 200, listed.text
            ids = {j["id"] for j in listed.json()["active"]}
            assert original.json()["id"] in ids
            assert correction.json()["id"] in ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
