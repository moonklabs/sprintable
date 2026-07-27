"""CI-gated 회귀가드 — standups.add_feedback가 body.project_id(persist 대상)에 has_project_access를
강제하는지 직접 검증. 이 클래스(body-claimed↔resource-actual 불일치)는 ratchet 스캐너가 못 잡는다
(resolve_member 호출을 "가드"로 오인) → consumer test로 CI에 영속화. realdb 아님(mock)이라 CI
backend-test에서 실행된다. 가드 제거/우회 시 즉시 RED.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ENTRY_PID = uuid.uuid4()   # entry가 속한 project(resolve_member가 검증하는 값)
BODY_PID = uuid.uuid4()    # body가 주장하는 persist 대상 project(가드가 검증해야 하는 값)
ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _override(app):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        yield AsyncMock()  # 세션은 patch된 resolve_member/entry_repo/has_project_access가 대신 처리

    async def _auth():
        return AuthContext(user_id=str(USER_ID), email="c@test", claims={"app_metadata": {"org_id": str(ORG_ID)}})

    async def _org():
        return ORG_ID

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_add_feedback_denies_when_no_access_to_body_project_id():
    """body.project_id 접근권이 없으면(has_project_access=False) 403 — 가드가 write-target을 막는다."""
    from app.main import app

    entry = MagicMock()
    entry.project_id = ENTRY_PID
    member = MagicMock()
    member.id = uuid.uuid4()

    _override(app)
    try:
        with patch("app.routers.standups.StandupEntryRepository.get", new_callable=AsyncMock, return_value=entry), \
             patch("app.routers.standups.resolve_member", new_callable=AsyncMock, return_value=member), \
             patch("app.routers.standups.has_project_access", new_callable=AsyncMock, return_value=False) as mhpa:
            async with _client(app) as c:
                resp = await c.post(f"/api/v2/standups/{uuid.uuid4()}/feedback", json={
                    "org_id": str(ORG_ID), "project_id": str(BODY_PID),
                    "feedback_by_id": str(uuid.uuid4()), "review_type": "comment", "feedback_text": "fb",
                })
            assert resp.status_code == 403, resp.text
            # ⭐가드가 entry.project_id가 아니라 body.project_id(persist 대상)로 검증했는지 확認 —
            # body-claimed↔resource-actual 불일치 방지의 핵심.
            assert mhpa.await_count >= 1
            called_project_id = mhpa.await_args.args[2]  # (session, user_id, project_id, org_id)
            assert called_project_id == BODY_PID, "has_project_access가 body.project_id로 호출되지 않음"
            # over-block 방지(접근권 有 → 201)는 realdb 스위트
            # (test_valid_project_id_feedback_created_201 / _org_level_entry_accessible_project_still_201)가
            # 실 PG로 커버 — 이 mock 가드는 "body.project_id 강제" 회귀 검출에 집중.
    finally:
        app.dependency_overrides.clear()
