"""story #2222(오르테가 판정 2026-07-31, 스레드 7256d5cc) — 「낳음」 자동 부착 경로. 디디 착수
前 조사 결론: BE(#2267 C-9)는 이미 있고 막힌 자리는 MCP 창구뿐이었다(스키마+forwarding은
develop에 이미 있었음, 이번 발견) — 진짜 갭은 세 곳:
  ③ AC5 — origin insert 실패가 story 생성 전체를 rollback시키던 결함(SAVEPOINT로 격리, 이
    파일이 그 실측을 realdb로 고정. test_2267_story_origin_realdb.py도 같은 방향으로 갱신됨).
  「되돌리는 길」 — ⚠️착수 前 "새 엔드포인트 불요"라고 답한 것이 **반쪽만 맞았다**(구현 중
    실측으로 갈림): `DELETE /api/v2/references/{id}`는 재사용되나, source_type 접근게이트가
    "chat_message" 하나뿐이라 origin_type="story"(#2222가 실제로 주로 만드는 값)로 생긴
    참조는 지금 이 경로로 못 지운다 — #2269 몫으로 이미 예정된 확장이라 여기서 미리 안 짓고
    "알려진 갭"으로 실패 케이스를 pin한다(아래 두 테스트가 짝).

이 파일은 #2267용 파일(test_2267_story_origin_realdb.py)과 겹치지 않는 것만 증명한다:
  - undo 경로 — chat_message 기원은 되고(재사용 증명) story 기원은 안 됨(알려진 갭 pin)
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


# ─── 「되돌리는 길」 — 재사용 맞으나 반쪽뿐이다(실측으로 갈림) ────────────────
#
# ⚠️착수 前 "새 엔드포인트 불요 — reuse"라고 답했던 것이 **반쪽만 맞았다**(구현 중 실측 발견).
# `DELETE /api/v2/references/{id}`(references.py:198)는 실제로 재사용되나, source_type별
# 접근게이트가 `_SOURCE_TYPE_CONFIG`(references.py:86)에 **"chat_message" 하나만** 등록돼
# 있다 — story-sourced(origin_type="story") 참조는 이 삭제 엔드포인트가 404를 낸다(설정 자체가
# 없어 config가 None). 그리고 그 dict 위 주석이 이걸 **의도적**이라고 명시한다: "doc/story/epic도
# source-capable로 인정하지만 접근 게이트는 아직 안 지었다(#2269 몫으로 예정) — 여기서 미리
# 짓지 않는다(#2260이 고친 '도는 자리 없는 죽은 코드' 클래스 재발 금지)". #2222가 주로 만드는
# origin_type이 "story"(스토리→스토리 낳음)라는 점에서 이건 **#2222 자신의 "되돌리는 길" AC를
# 못 채우는 실질 갭**이다 — #2269와 스코프가 겹치므로 이 파일은 고치지 않고 **선언만** 한다.

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


async def test_undo_created_from_via_story_origin_currently_404s_known_gap():
    """⛔알려진 갭(고치지 않고 선언만) — origin_type="story"(#2222가 실제로 주로 만드는 값)로
    생긴 created_from 참조는 지금 이 경로로 못 지운다. `_SOURCE_TYPE_CONFIG`에 "story"가
    없어서다(#2269 몫으로 이미 예정된 확장 — 여기서 미리 안 짓는다). 이 테스트가 빨개지면
    그건 #2269가 그 확장을 했다는 뜻 — 그때 이 테스트를 지우고 위 테스트처럼 갱신할 것."""
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

            # ⛔지금은 404다 — story가 _SOURCE_TYPE_CONFIG에 없어서(위 설명 참조).
            delete_resp = await client.delete(f"/api/v2/references/{reference_id}")
            assert delete_resp.status_code == 404, (
                "이 테스트가 실패했다 = story-sourced 삭제가 이미 지원된다는 뜻(#2269 반영됨) "
                "— 이 테스트를 지우고 위 chat_message 테스트처럼 성공 케이스로 바꿀 것"
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
