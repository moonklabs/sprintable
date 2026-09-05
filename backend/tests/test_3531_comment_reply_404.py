"""story #3531(BE·결함·소형, 페드루 PO 確定 2026-09-06) — 댓글 행이 하드 삭제되면
`GET .../comments/{comment_id}/replies/{reply_id}`가 500 — `get_comment_reply_view`
안 `_get_owned_comment`가 던지는 `CommentNotFoundError`를 라우터가 못 잡았다(같은
예외를 create 엔드포인트는 이미 404로 잡는데 GET·submit은 안 잡던 «자리마다 다름»
클래스). 3529(#3883) 리뷰 中 발견 — create와 같은 문장으로 404 통일.

세팅 헬퍼는 test_3516_comment_reply.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _seed_default_role, _seed_human, _seed_org, _session_factory,
)
from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3516_comment_reply import _seed_comment, _seed_full_publication_chain, _submit_and_approve_reply

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


@pytest.fixture(autouse=True)
def _enable_sandbox_adapter(monkeypatch):
    """test_3516_comment_reply.py와 동형 — supports_reply=True로 등재."""
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete,sandbox_manage_replies",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        insight_metrics=("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"),
        supports_fetch_replies=True, supports_reply=True, reply_required_scope="sandbox_manage_replies",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


@pytest.mark.anyio
async def test_get_reply_after_comment_hard_deleted_returns_404_not_500():
    """되돌리면(라우터의 CommentNotFoundError catch 제거) 500 재현 — 뮤테이션은
    아래에서 실 소스로 직접 검증."""
    from app.main import app
    from app.models.channel_post_comment import ChannelPostComment
    from sqlalchemy import delete

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="ext-3531")
            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

            # story #3531 재현 — 소프트 삭제(deleted_at)가 아니라 행 자체가 사라짐
            # (원격 재수집 정리·테스트 픽스처류 경로, FK 없음 관례).
            await s.execute(delete(ChannelPostComment).where(ChannelPostComment.id == comment.id))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                r_get = await client.get(f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies/{reply.id}")
                assert r_get.status_code == 404, r_get.text
                assert str(comment.id) in r_get.json().get("detail", r_get.text)
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
