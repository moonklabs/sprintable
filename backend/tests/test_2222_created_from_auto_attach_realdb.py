"""story #2222(오르테가 판정 2026-07-31, 스레드 7256d5cc) — 「낳음」 자동 부착 경로. 디디 착수
前 조사 결론: BE(#2267 C-9)는 이미 있고 막힌 자리는 MCP 창구뿐이었다(스키마+forwarding은
develop에 이미 있었음, 이번 발견) — 진짜 갭은 셋:
  ③ AC5 — origin insert 실패가 story 생성 전체를 rollback시키던 결함(SAVEPOINT로 격리, 이
    파일이 그 실측을 realdb로 고정. test_2267_story_origin_realdb.py도 같은 방향으로 갱신됨).
  「되돌리는 길」 — ⚠️2단계로 갈렸다:
    1차(구현 중 실측): `DELETE /api/v2/references/{id}`는 재사용되나 source_type 접근게이트가
      "chat_message" 하나뿐이라 origin_type="story"로 생긴 참조는 404 — #2222가 실제로 주로
      만드는 값이 "story"라 이건 자기 자신의 「되돌리는 길」 AC를 못 채우는 실질 갭이었다.
    2차(오르테가 재판정): "story"는 **이 PR이 소비자를 만들기 시작**하므로 "소비자 없는 것을
      미리 안 짓는다"는 조건이 지금 충족돼 게이트를 연다(#2269 침범이 아니라 자기 뒷정리) —
      단 doc/epic은 아직 소비자가 없어 그대로 #2269 몫(pin 유지).

이 파일은 #2267용 파일(test_2267_story_origin_realdb.py)과 겹치지 않는 것만 증명한다:
  - undo 경로 — chat_message·story 기원 둘 다 됨(재사용+신규 게이트), cross-project 404,
    doc/epic은 여전히 #2269 몫(pin)
  - AC4(라이브 부착 건수가 실제로 0이 아님)를 DB 행으로 직접 확인
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_2267_story_origin_realdb import (
    _REAL_DB_URL,
    _client_for,
    _find_reference,
    _make_human_member,
    _make_org,
    _make_project,
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


# ─── 「되돌리는 길」 — chat_message(기존)·story(이 PR이 새로 염) 둘 다 됨 ─────

async def test_undo_created_from_via_chat_message_origin_works_today():
    """등록된 source_type(chat_message)이면 기존 DELETE가 그대로 재사용된다 — 이건 참."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            from tests.test_2267_story_origin_realdb import _add_message, _make_conversation
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], created_by=member_id)
            msg = await _add_message(s, conv_id, member_id, "이걸 스토리로 만들자")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id), "org_id": str(org.id), "title": "대화에서 만든 것",
                    "origin_type": "chat_message", "origin_id": str(msg.id),
                },
            )
            assert create_resp.status_code == 201, create_resp.text
            story_id = uuid.UUID(create_resp.json()["id"])

            async with Session() as s:
                ref = await _find_reference(
                    s, org_id=org.id, source_type="chat_message", source_id=msg.id, target_id=story_id,
                )
                assert ref is not None
                reference_id = ref.id

            delete_resp = await client.delete(f"/api/v2/references/{reference_id}")
            assert delete_resp.status_code == 204, delete_resp.text

            async with Session() as s:
                gone = await _find_reference(
                    s, org_id=org.id, source_type="chat_message", source_id=msg.id, target_id=story_id,
                )
                assert gone is None
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_undo_created_from_via_story_origin_now_works():
    """⭐2026-07-31 재판정(오르테가) — "story 하나만" 게이트를 이 PR이 연다. 근거: MCP가 실제로
    권하는 «가장 흔한» origin_type이 "story"인데 그걸 못 지우면 유나 확定 ㉣("만드는 것이
    있으면 지우는 것도 있어야 한다")을 정면으로 어긴다 — 그리고 이 PR 자신이 그 소비자를
    만들기 시작하므로 "소비자 없는 것을 미리 안 짓는다"는 조건이 지금 충족된다(#2269 침범이
    아니라 "자기가 연 길의 뒷정리"). doc/epic은 손대지 않는다(아래 pin 테스트가 그 이유)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            from app.models.pm import Story
            parent = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="부모 스토리",
                status="backlog", priority="medium",
            )
            s.add(parent)
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id), "org_id": str(org.id),
                    "title": "부모에서 쪼갠 후속 작업",
                    "origin_type": "story", "origin_id": str(parent.id),
                },
            )
            assert create_resp.status_code == 201, create_resp.text
            story_id = uuid.UUID(create_resp.json()["id"])

            async with Session() as s:
                ref = await _find_reference(
                    s, org_id=org.id, source_type="story", source_id=parent.id, target_id=story_id,
                )
                assert ref is not None
                reference_id = ref.id

            delete_resp = await client.delete(f"/api/v2/references/{reference_id}")
            assert delete_resp.status_code == 204, delete_resp.text

            async with Session() as s:
                gone = await _find_reference(
                    s, org_id=org.id, source_type="story", source_id=parent.id, target_id=story_id,
                )
                assert gone is None, "story-sourced DELETE가 204인데 행이 안 지워졌다"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_undo_created_from_via_story_origin_cross_project_is_404():
    """양쪽-아이템 게이트 — origin story가 caller 접근권 밖 프로젝트면 DELETE가 404(존재
    비노출). 새로 연 `_story_source_access`가 project_id만 보고 접근권을 실제로 강제하는지
    확認한다(insert_reference 자체는 접근권을 안 보므로 — 참조는 생기되, 지우려 할 때 갈린다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, name="A")
            project_b = await _make_project(s, org.id, name="B")
            _, user_id = await _make_human_member(s, org.id, project_b.id)  # caller는 B만 접근권
            from app.models.pm import Story
            parent = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="A의 부모",
                status="backlog", priority="medium",
            )
            s.add(parent)
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project_b.id), "org_id": str(org.id),
                    "title": "B에서 만든 것", "origin_type": "story", "origin_id": str(parent.id),
                },
            )
            assert create_resp.status_code == 201, create_resp.text
            story_id = uuid.UUID(create_resp.json()["id"])

            async with Session() as s:
                ref = await _find_reference(
                    s, org_id=org.id, source_type="story", source_id=parent.id, target_id=story_id,
                )
                assert ref is not None, "cross-project origin이어도 참조 자체는 생겨야 한다"
                reference_id = ref.id

            delete_resp = await client.delete(f"/api/v2/references/{reference_id}")
            assert delete_resp.status_code == 404, (
                "caller가 project_a(origin story의 project) 접근권이 없는데 삭제가 통과했다"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── doc/epic — 여전히 #2269 몫(pin 유지, 오르테가 명시 지시) ──────────────

async def test_undo_created_from_via_doc_or_epic_origin_still_404s_reserved_for_2269():
    """⛔이 pin은 유지한다(오르테가 지시, 2026-07-31) — "story"는 이 PR이 소비자를 만들어서
    게이트를 열지만, doc/epic은 아직 실제 소비자가 없어 #2269 몫 그대로다("소비자 없는 것을
    미리 안 짓는다" 원칙). 이 테스트가 빨개지면 그건 doc이나 epic 중 하나가 이미 열렸다는
    뜻 — 그때 이 테스트를 그 타입만큼 좁혀서 갱신할 것."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            from app.models.doc import Doc
            doc = Doc(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="문서",
                slug=f"doc-{uuid.uuid4().hex[:8]}",
            )
            s.add(doc)
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id), "org_id": str(org.id),
                    "title": "문서에서 만든 것", "origin_type": "doc", "origin_id": str(doc.id),
                },
            )
            assert create_resp.status_code == 201, create_resp.text
            story_id = uuid.UUID(create_resp.json()["id"])

            async with Session() as s:
                ref = await _find_reference(
                    s, org_id=org.id, source_type="doc", source_id=doc.id, target_id=story_id,
                )
                assert ref is not None
                reference_id = ref.id

            delete_resp = await client.delete(f"/api/v2/references/{reference_id}")
            assert delete_resp.status_code == 404, (
                "doc-sourced 삭제가 이미 열렸다 — #2269가 왔다는 뜻. 이 pin을 그 타입만큼 좁혀 갱신할 것"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── AC4 — 라이브 실측: 배선 後 자동 부착 건수가 실제로 0이 아니다(DB 행으로 확인) ───

async def test_ac4_live_attach_count_is_nonzero_after_wiring():
    """「배선했다」고 말로 끝내지 않는다 — 실제 생성 흐름을 두 번 태워 entity_references에
    relation='created_from' 행이 실제로 «누적»되는 것(count가 늘어나는 것)을 DB로 확認한다."""
    from app.main import app
    from sqlalchemy import func, select as sa_select
    from app.models.reference import Reference

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            from app.models.pm import Story
            parent = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="부모",
                status="backlog", priority="medium",
            )
            s.add(parent)
            await s.commit()

        async def _count() -> int:
            async with Session() as s:
                return (
                    await s.execute(
                        sa_select(func.count()).select_from(Reference).where(
                            Reference.org_id == org.id, Reference.relation == "created_from",
                        )
                    )
                ).scalar_one()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            assert await _count() == 0

            r1 = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id), "org_id": str(org.id), "title": "자식1",
                    "origin_type": "story", "origin_id": str(parent.id),
                },
            )
            assert r1.status_code == 201, r1.text
            assert await _count() == 1, "1번째 자동부착 후 count가 0이다 — 배선이 실제로 안 됨"

            r2 = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id), "org_id": str(org.id), "title": "자식2",
                    "origin_type": "story", "origin_id": str(parent.id),
                },
            )
            assert r2.status_code == 201, r2.text
            assert await _count() == 2, "2번째 생성 후 count가 안 늘었다 — 매 생성마다 누적 안 됨"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
