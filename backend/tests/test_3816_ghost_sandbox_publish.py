"""story #3816(Phase3·3-6 PR2 CHANGES 1, 페드루 PO 지목 2026-09-12) —
`ghost_sandbox_publish.py` 직접 단위 테스트. DB 불요·네트워크 0(client 인자는
시그니처 호환용, 이 모듈이 실제로 쓰지 않는다)."""
from __future__ import annotations

import pytest

from app.services.ghost_publish import GhostPublishError
from app.services.ghost_sandbox_publish import publish, unpublish


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_no_marker_publishes_successfully_with_sandbox_external_id():
    external_id, permalink = await publish(
        None, site_url="https://ghost-sandbox.invalid", admin_api_key="sandbox-dummy-access-token",
        title="일반 글", body_md="본문", summary="요약", tags=[], slug="post-1",
    )
    assert external_id.startswith("sandbox-ghost-")
    assert "jwtretry" not in external_id
    assert permalink == f"https://ghost-sandbox.invalid/p/{external_id}/"


@pytest.mark.anyio
async def test_provider_error_marker_raises_503():
    with pytest.raises(GhostPublishError) as exc_info:
        await publish(
            None, site_url="https://ghost-sandbox.invalid", admin_api_key="sandbox-dummy-access-token",
            title="[sandbox:provider-error]", body_md="본문", summary="요약", tags=[], slug="post-2",
        )
    assert exc_info.value.status_code == 503


@pytest.mark.anyio
async def test_jwt_expired_marker_still_publishes_with_distinct_external_id_prefix():
    """story #3816 CHANGES 1 — ghost_publish.py의 재서명 1회 재시도가 실 사이트에서
    성공하는 모양(첫 401→재서명→성공)을 결정적으로 재현. 최종 상태는 published로
    마커 없음과 같지만, external_id 접두사로 "그 경로가 실행됐다"를 구분한다."""
    external_id, permalink = await publish(
        None, site_url="https://ghost-sandbox.invalid", admin_api_key="sandbox-dummy-access-token",
        title="[sandbox:ghost-jwt-expired]", body_md="본문", summary="요약", tags=[], slug="post-3",
    )
    assert external_id.startswith("sandbox-ghost-jwtretry-")
    assert permalink == f"https://ghost-sandbox.invalid/p/{external_id}/"


@pytest.mark.anyio
async def test_auth_failed_marker_raises_401_for_ghost_auth_failed_promotion():
    """뮤테이션 대상(스토리 본문 明示) — 이 분기를 지우면(또는 무마커 성공
    분기로 흡수되면) 이 테스트가 RED여야 한다. 401은 site_posts.py::
    _blog_publish_error_code가 GHOST_AUTH_FAILED(연결 「다시 연결 필요」)로
    승격하는 유일한 트리거다."""
    with pytest.raises(GhostPublishError) as exc_info:
        await publish(
            None, site_url="https://ghost-sandbox.invalid", admin_api_key="sandbox-dummy-access-token",
            title="[sandbox:ghost-auth-failed]", body_md="본문", summary="요약", tags=[], slug="post-4",
        )
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_unpublish_always_succeeds_idempotent():
    assert await unpublish(
        None, site_url="https://ghost-sandbox.invalid", admin_api_key="sandbox-dummy-access-token",
        external_id="sandbox-ghost-anything",
    ) is None
