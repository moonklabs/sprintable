"""story #3596(Phase2·BE, 페드루 PO 確定 2026-09-06, #3947 카디르 비차단① 근거) —
목록 API에 댓글마다 open_reply_draft(안 보낸 최신 답변)·sent_replies_count(보낸
답변 수)를 additive로 얹는다. create_comment_reply_draft는 안 보낸 초안이 이미
있으면 409(2차 초안 방지).

세팅 헬퍼는 test_3593_comment_reply_additive.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_default_role, _seed_human, _seed_org, _session_factory
from app.main import app
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


async def _create_reply(db, *, org_id, comment, text, human_id):
    from app.services.channel_post_comment_replies import create_comment_reply_draft

    return await create_comment_reply_draft(
        db, org_id=org_id, comment_id=comment.id, text=text,
        created_by_member_id=human_id, created_by_kind="human",
    )


@pytest.mark.anyio
async def test_draft_only_exposes_open_reply_draft_and_zero_sent_count():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            draft = await _create_reply(s, org_id=org_id, comment=comment, text="작성 중인 답변", human_id=human_id)

            _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
            async with _client_for(app) as client:
                resp = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
            item = resp.json()["comments"][0]
            assert item["open_reply_draft"]["id"] == str(draft.id)
            assert item["open_reply_draft"]["status"] == "draft"
            assert item["open_reply_draft"]["text"] == "작성 중인 답변"
            assert item["sent_replies_count"] == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sent_only_exposes_null_open_draft_and_sent_count_one():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)
            reply.status = "sent"
            await s.commit()

            _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
            async with _client_for(app) as client:
                resp = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
            item = resp.json()["comments"][0]
            assert item["open_reply_draft"] is None
            assert item["sent_replies_count"] == 1
            assert item["replies_count"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sent_reply_plus_new_draft_shows_both_derived_fields_consistently():
    """#3947 카디르 비차단⑥ — repliesCount·sent_replies_count·open_reply_draft
    3필드 정합을 전용 테스트로 고정(보낸 1+안 보낸 초안 1 = replies_count 2·
    sent_replies_count 1·open_reply_draft != null)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            sent_reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)
            sent_reply.status = "sent"
            await s.commit()

            open_draft = await _create_reply(s, org_id=org_id, comment=comment, text="이어서 쓰는 중", human_id=human_id)

            _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
            async with _client_for(app) as client:
                resp = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
            item = resp.json()["comments"][0]
            assert item["replies_count"] == 2
            assert item["sent_replies_count"] == 1
            assert item["open_reply_draft"]["id"] == str(open_draft.id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_draft_rejects_second_draft_with_409_and_existing_id():
    """AC3 — open_reply_draft가 있는 댓글에 새 초안 요청 → 409 + 기존 초안 id."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            first_draft = await _create_reply(s, org_id=org_id, comment=comment, text="첫 초안", human_id=human_id)

            _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies", json={"text": "두 번째 시도"},
                )
            assert resp.status_code == 409, resp.text
            body = resp.json()
            assert body["error"]["existing_reply_id"] == str(first_draft.id), body
    finally:
        await engine.dispose()
