"""E1-S3: /api/v2/hypotheses 라우터 테스트.

S3 고유 가치: ⓐ서비스 오류 code→HTTP status 매핑 ⓑ라우터 가드 2종(인계 — cross-project
링크 금지 §3.7.2 / active 전이 owner·admin §3.1.7) ⓒ엔드포인트 와이어링 + dict-detail 계약.
서비스 로직 자체는 S2(test_hypothesis_service)에서 검증됨 — 여기선 라우터 레이어만.
"""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers import hypotheses as r
from app.schemas.hypothesis import HypothesisDraftRequest, HypothesisResponse
from app.services.hypothesis import HypothesisServiceError
from app.services.member_resolver import ResolvedMember

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
OWNER_ID = uuid.uuid4()
OTHER_ID = uuid.uuid4()
HYP_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _member(mid: uuid.UUID, role: str = "member", mtype: str = "human") -> ResolvedMember:
    return ResolvedMember(id=mid, user_id=uuid.uuid4(), name="t", type=mtype, role=role, org_id=ORG_ID)


# ── ⓐ 오류 매핑 ────────────────────────────────────────────────────────────────

def test_error_status_map_covers_service_codes():
    expected = {
        "HUMAN_OWNER_REQUIRED", "HUMAN_CONFIRM_REQUIRED", "INVALID_CREATE_STATUS",
        "INVALID_STATUS", "INVALID_HYPOTHESIS_TRANSITION", "NO_VALID_FIELDS",
        "HYPOTHESIS_NOT_FOUND", "CROSS_PROJECT_LINK_FORBIDDEN",
    }
    assert expected <= set(r._ERROR_STATUS)


@pytest.mark.parametrize("code,status", [
    ("HUMAN_OWNER_REQUIRED", 400), ("HYPOTHESIS_NOT_FOUND", 404),
    ("INVALID_HYPOTHESIS_TRANSITION", 409), ("HUMAN_CONFIRM_REQUIRED", 403),
    ("INVALID_CREATE_STATUS", 422), ("NO_VALID_FIELDS", 400),
])
def test_raise_maps_code_to_status(code, status):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        r._raise(HypothesisServiceError(code, "msg"))
    assert ei.value.status_code == status
    assert ei.value.detail == {"code": code, "message": "msg"}


def test_raise_unknown_code_defaults_400():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        r._raise(HypothesisServiceError("WHATEVER", "m"))
    assert ei.value.status_code == 400


# ── ⓑ active 전이 권한 가드 (§3.1.7) ──────────────────────────────────────────

def test_active_authorized_owner_ok():
    r._assert_active_authorized(_member(OWNER_ID), OWNER_ID)  # no raise


def test_active_authorized_admin_ok():
    r._assert_active_authorized(_member(OTHER_ID, role="admin"), OWNER_ID)
    r._assert_active_authorized(_member(OTHER_ID, role="owner"), OWNER_ID)


def test_active_unauthorized_non_owner_non_admin():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        r._assert_active_authorized(_member(OTHER_ID, role="member"), OWNER_ID)
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "ACTIVE_TRANSITION_FORBIDDEN"


# ── ⓑ cross-project 링크 가드 (§3.7.2) ────────────────────────────────────────

def _session_returning(rows):
    s = MagicMock()
    result = MagicMock()
    result.all = MagicMock(return_value=rows)
    s.execute = AsyncMock(return_value=result)
    return s


async def test_link_same_project_ok():
    eid = uuid.uuid4()
    s = _session_returning([(eid, PROJECT_ID)])
    await r._assert_targets_same_project(s, PROJECT_ID, [eid], [])  # no raise


async def test_link_cross_project_forbidden():
    from fastapi import HTTPException
    eid = uuid.uuid4()
    s = _session_returning([(eid, uuid.uuid4())])  # 다른 project
    with pytest.raises(HTTPException) as ei:
        await r._assert_targets_same_project(s, PROJECT_ID, [eid], [])
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "CROSS_PROJECT_LINK_FORBIDDEN"


async def test_link_missing_target_forbidden():
    from fastapi import HTTPException
    eid = uuid.uuid4()
    s = _session_returning([])  # 대상 epic 없음(len mismatch)
    with pytest.raises(HTTPException) as ei:
        await r._assert_targets_same_project(s, PROJECT_ID, [eid], [])
    assert ei.value.status_code == 403


# ── ⓒ draft (§3.9) ────────────────────────────────────────────────────────────

async def test_draft_template_no_persist():
    from app.services.hypothesis import draft_hypothesis
    payload = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type="epic", source_id=uuid.uuid4(),
        context={"title": "신규 온보딩 플로우"}, persist=False,
    )
    out = await draft_hypothesis(MagicMock(), ORG_ID, _member(OWNER_ID), payload)
    assert out.requires_confirmation is True
    assert out.hypothesis is None  # persist=false → row 미생성
    assert "신규 온보딩 플로우" in out.statement
    assert out.source_snapshot["title"] == "신규 온보딩 플로우"
    assert out.metric_definition["source"] == "manual"


async def test_draft_persist_creates_proposed_row():
    from app.services import hypothesis as service
    payload = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type="story", source_id=uuid.uuid4(), persist=True,
    )
    created = _hyp_response()  # create_hypothesis는 실제로 HypothesisResponse를 반환
    with patch.object(service, "create_hypothesis", AsyncMock(return_value=created)) as mock_create:
        out = await service.draft_hypothesis(MagicMock(), ORG_ID, _member(OWNER_ID), payload)
    mock_create.assert_awaited_once()
    created_payload = mock_create.call_args.args[3]
    assert created_payload.status == "proposed"
    assert out.hypothesis is not None and out.hypothesis.status == "proposed"


# ── ⓒ 엔드포인트 와이어링 + dict-detail 계약 ──────────────────────────────────

def _hyp_response() -> HypothesisResponse:
    return HypothesisResponse(
        id=HYP_ID, org_id=ORG_ID, project_id=PROJECT_ID, owner_member_id=OWNER_ID,
        statement="s", metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc), status="proposed",
        human_accounting={}, gate_contract={},
        created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )


@pytest.fixture
def app_with_overrides(mock_session, auth_ctx):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: iter([mock_session])
    app.dependency_overrides[get_current_user] = lambda: auth_ctx
    app.dependency_overrides[get_verified_org_id] = lambda: ORG_ID
    yield app
    app.dependency_overrides.clear()


async def test_create_endpoint_happy_201(app_with_overrides):
    from httpx import ASGITransport, AsyncClient
    body = {
        "project_id": str(PROJECT_ID), "statement": "s",
        "metric_definition": {"metric": "m", "source": "manual", "target": 1, "direction": "up"},
        "measure_after": "2026-07-01T00:00:00+00:00", "owner_member_id": str(OWNER_ID),
    }
    with patch.object(r, "resolve_member", AsyncMock(return_value=_member(OWNER_ID))), \
         patch.object(r.svc, "create_hypothesis", AsyncMock(return_value=_hyp_response())):
        async with AsyncClient(transport=ASGITransport(app=app_with_overrides), base_url="http://t") as c:
            resp = await c.post("/api/v2/hypotheses", json=body)
    assert resp.status_code == 201
    assert resp.json()["id"] == str(HYP_ID)


async def test_create_endpoint_service_error_maps_dict_detail(app_with_overrides):
    from httpx import ASGITransport, AsyncClient
    body = {
        "project_id": str(PROJECT_ID), "statement": "s",
        "metric_definition": {"metric": "m", "source": "manual", "target": 1, "direction": "up"},
        "measure_after": "2026-07-01T00:00:00+00:00",
    }
    err = HypothesisServiceError("HUMAN_OWNER_REQUIRED", "owner must be human")
    with patch.object(r, "resolve_member", AsyncMock(return_value=_member(OWNER_ID, mtype="agent"))), \
         patch.object(r.svc, "create_hypothesis", AsyncMock(side_effect=err)):
        async with AsyncClient(transport=ASGITransport(app=app_with_overrides), base_url="http://t") as c:
            resp = await c.post("/api/v2/hypotheses", json=body)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "HUMAN_OWNER_REQUIRED"


async def test_get_endpoint_not_found_404(app_with_overrides):
    from httpx import ASGITransport, AsyncClient
    err = HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "없음")
    with patch.object(r.svc, "get_hypothesis", AsyncMock(side_effect=err)):
        async with AsyncClient(transport=ASGITransport(app=app_with_overrides), base_url="http://t") as c:
            resp = await c.get(f"/api/v2/hypotheses/{HYP_ID}")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "HYPOTHESIS_NOT_FOUND"
