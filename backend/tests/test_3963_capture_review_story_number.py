"""story #3963 — POST /capture-review에 (org_id, story_number) 경로 신설(story_id UUID
직접지정과 양자택일) + role="po" 신설 검증. GitHub Action 호출자는 org 컨텍스트가 없어
story_id(UUID)를 미리 못 구하고, 우리 팀 실 PR 관례가 story_number(`[SID:정수]`)라 이 경로가
필요해졌다(그라운딩 근거는 PR#4364 본문 참조)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_story(story_id=STORY_ID, org_id=ORG_ID):
    s = MagicMock()
    s.id = story_id
    s.org_id = org_id
    return s


async def _post_capture_review(payload: dict, mock_session):
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            return await c.post(
                "/api/v2/internal/verdict/capture-review",
                json=payload,
                headers={"Authorization": "Bearer "},
            )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_capture_review_by_story_number_resolves_and_records():
    """AC — (org_id, story_number)만 줘도 _scoped_story_by_number로 해소해 기록한다."""
    mock_session = AsyncMock()
    mock_session.commit = AsyncMock()

    with patch(
        "app.services.pr_story_link._scoped_story_by_number", new_callable=AsyncMock,
    ) as mock_resolve, patch(
        "app.routers.verdict_capture.capture_review_verdict", new_callable=AsyncMock,
    ) as mock_capture:
        mock_resolve.return_value = _mock_story()
        mock_capture.return_value = {"recorded": True}

        resp = await _post_capture_review(
            {
                "org_id": str(ORG_ID), "story_number": 3963,
                "role": "po", "member_id": str(MEMBER_ID), "result": "pass",
            },
            mock_session,
        )

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["recorded"] is True
    mock_resolve.assert_awaited_once_with(mock_session, ORG_ID, 3963)
    _, call_kwargs = mock_capture.call_args
    assert call_kwargs["story_id"] == STORY_ID
    assert call_kwargs["org_id"] == ORG_ID
    assert call_kwargs["role_key"] == "po"


@pytest.mark.anyio
async def test_capture_review_by_story_number_ambiguous_or_missing_skips():
    """AC — _scoped_story_by_number가 None(0건·2건+ ambiguous 둘 다)이면 story_not_found로 skip
    (추측 없이, resolve_story_for_pr의 close-on-merge 규율과 동형)."""
    mock_session = AsyncMock()

    with patch(
        "app.services.pr_story_link._scoped_story_by_number", new_callable=AsyncMock,
    ) as mock_resolve:
        mock_resolve.return_value = None

        resp = await _post_capture_review(
            {
                "org_id": str(ORG_ID), "story_number": 9999,
                "role": "qa", "member_id": str(MEMBER_ID), "result": "fail",
            },
            mock_session,
        )

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["skipped_reason"] == "story_not_found"


@pytest.mark.anyio
async def test_capture_review_missing_story_ref_422():
    """AC — story_id도 (org_id+story_number)도 없으면 422(INVALID_STORY_REF)."""
    mock_session = AsyncMock()

    resp = await _post_capture_review(
        {"role": "qa", "member_id": str(MEMBER_ID), "result": "pass"},
        mock_session,
    )

    assert resp.json()["error"]["code"] == "INVALID_STORY_REF"


@pytest.mark.anyio
async def test_capture_review_by_story_id_direct_path_unaffected():
    """AC(기존 호출자 무회귀) — story_id 직접 지정 경로는 이번 변경과 무관하게 그대로 동작."""
    mock_session = AsyncMock()
    mock_session.commit = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = _mock_story()
    mock_session.execute = AsyncMock(return_value=mock_result)

    with patch(
        "app.routers.verdict_capture.capture_review_verdict", new_callable=AsyncMock,
    ) as mock_capture:
        mock_capture.return_value = {"recorded": True}

        resp = await _post_capture_review(
            {"story_id": str(STORY_ID), "role": "qa", "member_id": str(MEMBER_ID), "result": "pass"},
            mock_session,
        )

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["recorded"] is True
    _, call_kwargs = mock_capture.call_args
    assert call_kwargs["story_id"] == STORY_ID


@pytest.mark.anyio
async def test_capture_review_role_po_no_longer_rejected():
    """AC — role="po"가 이제 유효(전엔 INVALID_ROLE 422)."""
    mock_session = AsyncMock()
    mock_session.commit = AsyncMock()

    with patch(
        "app.services.pr_story_link._scoped_story_by_number", new_callable=AsyncMock,
    ) as mock_resolve, patch(
        "app.routers.verdict_capture.capture_review_verdict", new_callable=AsyncMock,
    ) as mock_capture:
        mock_resolve.return_value = _mock_story()
        mock_capture.return_value = {"recorded": True}

        resp = await _post_capture_review(
            {"org_id": str(ORG_ID), "story_number": 1, "role": "po", "member_id": str(MEMBER_ID), "result": "fail"},
            mock_session,
        )

    assert resp.status_code == 200, resp.text
    assert "error" not in resp.json() or resp.json().get("error") is None


@pytest.mark.anyio
async def test_capture_review_invalid_role_still_rejected():
    """음성대조 — 유효하지 않은 role은 여전히 422(INVALID_ROLE)."""
    mock_session = AsyncMock()

    resp = await _post_capture_review(
        {"org_id": str(ORG_ID), "story_number": 1, "role": "bogus", "member_id": str(MEMBER_ID)},
        mock_session,
    )

    assert resp.json()["error"]["code"] == "INVALID_ROLE"
