"""story #2268(D단계, E-CONNECT — "판단 칸") — POST/GET /api/v2/judgments 엔드포인트 실PG 검증.

오르테가 AC(2026-07-29, 스레드 7256d5cc) 7개를 그대로 잰다:
  ①Evidence 카운트 오염 없음(judgment 삽입 전후 batch_has_evidence·GET /evidence·
    glance proof_count 변화 0)
  ②철회는 캡을 안 받는다(active는 잘리고 corrections는 전량)
  ③active_omitted_count가 정확한 수
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


# ─── ②③정정(retraction·refinement·method_error) uncapped + active_omitted_count 정확 ──


async def test_corrections_uncapped_active_capped_with_accurate_omitted_count():
    """story #2308(2026-07-29) — 캡 예외가 `TARGET_LINKABLE_KINDS` 전체(retraction·
    refinement·method_error)를 덮는지 증명한다. retraction 하나만 테스트하면 그 회귀가
    다시 들어와도 이 테스트가 못 잡는다 — 셋 다 각각 캡보다 많이 넣어 전량 생존을 본다."""
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

            correction_ids = []
            for kind, target_id in zip(
                ["retraction", "refinement", "method_error"], active_ids[:3], strict=True
            ):
                resp = await client.post(
                    "/api/v2/judgments",
                    json={
                        "scope": "general", "kind": kind, "target_id": target_id,
                        "statement": f"{kind} of {target_id}",
                    },
                )
                assert resp.status_code == 201, resp.text
                correction_ids.append(resp.json()["id"])

            resp = await client.get("/api/v2/judgments", params={"scope": "general", "limit": 2})
            assert resp.status_code == 200, resp.text
            body = resp.json()

            assert len(body["active"]) == 2, body["active"]
            assert {r["id"] for r in body["corrections"]} == set(correction_ids), body["corrections"]
            assert len(body["corrections"]) == 3
            # 셋 다 실제로 섞여 나오는지(하나의 kind로 쏠려 있지 않은지) 확인.
            assert {r["kind"] for r in body["corrections"]} == {
                "retraction", "refinement", "method_error",
            }, body["corrections"]

            assert body["meta"]["active_capped"] is True
            assert body["meta"]["active_cap_basis"] == "recency"
            # active 총량 = 5(judgment) + 0(정정 셋은 active 아님) = 5. 2건 반환 → 3건 누락.
            assert body["meta"]["active_omitted_count"] == 3, body["meta"]
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
            correction_ids = {j["id"] for j in body["corrections"]}
            # story #2308: method_error(r3)는 정정 축이라 corrections에 있다 — active엔
            # judgment 둘(r1·r2)만 남는다. method 필터가 두 축 모두에 걸리는지도 여기서 확인.
            assert active_ids == {r1.json()["id"], r2.json()["id"]}, active_ids
            assert correction_ids == {r3.json()["id"]}, correction_ids
            assert r_other.json()["id"] not in active_ids | correction_ids
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


async def test_meta_kind_without_target_id_now_accepted_201():
    """⛔뒤집힘(2026-07-30, 오르테가 철회): target_id 없는 ㉡을 예전엔 422로 거절했다 —
    지금은 정반대로 201을 확認한다(처음 쓰는 사람이 이전 판정을 몰라도 남길 수 있어야 함)."""
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
            assert resp.status_code == 201, resp.text
            assert resp.json()["target_id"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_source_message_id_round_trips_through_http():
    """신설(2026-07-30) — 채팅 메시지 id를 넘기면 응답에 그대로 실리는지(HTTP 계층)."""
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
            msg_id = str(uuid.uuid4())
            resp = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "judgment", "statement": "stmt",
                    "source_message_id": msg_id,
                },
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["source_message_id"] == msg_id
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
            # target_id는 이제 선택이지만, 이 테스트는 "correction_ids 데코레이션"을 보려는
            # 것이라 실제로 target을 거는 정상 경로로 먼저 ㉠(judgment) 하나를 세운다.
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
            body = listed.json()
            # story #2308: judgment(original)은 active, method_error(correction)는 corrections.
            assert original.json()["id"] in {j["id"] for j in body["active"]}
            assert correction.json()["id"] in {j["id"] for j in body["corrections"]}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── correction_ids 교차참조(2026-07-29, 오르테가 라이브 dogfooding 후속) ──────
#
# "active(유효)"라는 이름만 읽고 철회된 판단을 유효로 오독하는 함정 — active·corrections
# 양쪽 원소가 자신을 target으로 삼는 correction id들을 실어, 한 목록만 읽어도 "이건 그대로
# 믿으면 안 된다"가 보이게 한다. 정정이 다른 정정을 target하는 것(method_error가 흔히 그렇듯)
# 도 정상 모양이라 corrections 원소도 똑같이 decorate한다.


def _find(items, item_id):
    return next(j for j in items if j["id"] == item_id)


async def test_active_item_carries_correction_ids_when_retracted():
    """오르테가가 #2302에서 실제로 재현한 시나리오 그대로 — judgment→retraction 왕복."""
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
            original = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "judgment",
                    "statement": "artifact/asset은 전용 화면 있음 — page.tsx 파일 실재가 근거",
                },
            )
            assert original.status_code == 201, original.text
            retraction = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "retraction", "target_id": original.json()["id"],
                    "statement": "철회 — 파일이 있다는 화면이 있다의 근거가 못 된다(사문 코드)",
                },
            )
            assert retraction.status_code == 201, retraction.text

            resp = await client.get("/api/v2/judgments", params={"scope": "general"})
            assert resp.status_code == 200, resp.text
            body = resp.json()

            active_item = _find(body["active"], original.json()["id"])
            assert active_item["correction_ids"] == [retraction.json()["id"]], active_item
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_correction_item_itself_carries_correction_ids_when_further_corrected():
    """method_error는 «번지는» 정정이라 정정이 정정을 target하는 것이 정상 모양 —
    corrections[] 원소도 active와 동형으로 decorate돼야 한다(오늘 세션에 반복 관측된
    "한쪽만 고쳐지는 비대칭" 재발 방지 — PO 결정: 같은 PR에서 두 목록 다)."""
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
            original = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "judgment",
                    "statement": "4fps 관측 기반 — 렌더 파이프라인이 안정적이라 판단",
                },
            )
            assert original.status_code == 201, original.text
            refinement = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "refinement", "target_id": original.json()["id"],
                    "statement": "저해상도에서만 안정적 — 고해상도는 별도 재측정 필요",
                },
            )
            assert refinement.status_code == 201, refinement.text
            # refinement 자체가 method_error의 target이 되는 경우 — "관측 방법 자체가
            # 틀렸다"는 정정이 이미 나온 정정(refinement)까지 함께 흔든다.
            method_error = await client.post(
                "/api/v2/judgments",
                json={
                    "scope": "general", "kind": "method_error", "target_id": refinement.json()["id"],
                    "statement": "4fps 관측 자체가 틀렸다(15fps로 재측정) — 그 관측 기반 정련도 무효",
                },
            )
            assert method_error.status_code == 201, method_error.text

            resp = await client.get("/api/v2/judgments", params={"scope": "general"})
            assert resp.status_code == 200, resp.text
            body = resp.json()

            refinement_item = _find(body["corrections"], refinement.json()["id"])
            assert refinement_item["correction_ids"] == [method_error.json()["id"]], refinement_item
            # method_error 자신은 아무도 target하지 않았으므로 빈 배열.
            method_error_item = _find(body["corrections"], method_error.json()["id"])
            assert method_error_item["correction_ids"] == [], method_error_item
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_correction_ids_decoration_positively_fires_for_every_targeted_item():
    """⭐오르테가 요청 가드 — «decoration이 빠진 원소가 0인가». map이 비면 조용히 전부
    무표시가 되는 실패 모드가 있다(«돌고 있는데 아무것도 안 재는» 모양) — 그러니 단일
    사례가 아니라 여러 개 동시에 넣어, 매칭돼야 할 게 전부 매칭됐는지(누락 0)와 매칭되면
    안 될 게 실제로 비어있는지(오염 0) 양방향으로 잰다."""
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
            targets = []
            for i in range(4):
                r = await client.post(
                    "/api/v2/judgments",
                    json={"scope": "general", "kind": "judgment", "statement": f"판단 {i}"},
                )
                assert r.status_code == 201, r.text
                targets.append(r.json()["id"])

            # 0·1·2번째만 철회, 3번째는 안 건드림(음성대조).
            retraction_ids = {}
            for idx in (0, 1, 2):
                r = await client.post(
                    "/api/v2/judgments",
                    json={
                        "scope": "general", "kind": "retraction", "target_id": targets[idx],
                        "statement": f"철회 {idx}",
                    },
                )
                assert r.status_code == 201, r.text
                retraction_ids[targets[idx]] = r.json()["id"]

            resp = await client.get("/api/v2/judgments", params={"scope": "general", "limit": 10})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            active_by_id = {j["id"]: j for j in body["active"]}

            for idx in (0, 1, 2):
                item = active_by_id[targets[idx]]
                assert item["correction_ids"] == [retraction_ids[targets[idx]]], (idx, item)
            # 안 건드린 3번째는 correction_ids가 실제로 비어있어야(오염 0).
            assert active_by_id[targets[3]]["correction_ids"] == [], active_by_id[targets[3]]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
