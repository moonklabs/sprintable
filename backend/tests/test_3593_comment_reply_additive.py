"""story #3593(Phase2·BE, 페드루 PO 確定 2026-09-06) — 유나 배포 44 FB 답변 경로
실측(publication c547fa6d·댓글 9d255bd9): 답변 sent 뒤에도 행에 답변 텍스트가
어디에도 없었다(comments-section.tsx에 reply.text류를 그리는 코드 0건). DB엔
이미 저장된 값(ChannelPostCommentReply.text)의 투영만 빠진 자리 — 이 스토리의
BE 몫만(FE는 3592 뒤 별도 PR, 페드루 PO 明示).

또한 `create_comment_reply_draft`는 기존 답변을 확認하지 않고 새 행을 만든다
(2차 답변 허용·중복 가드 0) — 그런데 목록 응답은 배지 하나(=최신 답변 status)
뿐이라, 답변이 2건 이상이면 「이 상태가 어느 답변의 것인가」가 안 선다. 이
스토리는 `reply`(이미 최신 답변 — `_latest_reply_by_comment_ids`)에 `text`를
additive로 얹고, `CommentItem`에 `replies_count`를 additive로 얹는다.

세팅 헬퍼는 test_3529_comment_reply_command_status.py·test_3516_comment_
reply.py(조각②) 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _seed_default_role, _seed_human, _seed_org, _session_factory,
)
from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3516_comment_reply import _seed_comment, _seed_full_publication_chain

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
    """test_3529_comment_reply_command_status.py와 동형 — supports_reply/
    fetch_replies=True로 등재."""
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


async def _submit_and_approve_reply_with_text(s, *, org_id, human_id, comment, text: str):
    """test_3516_comment_reply.py::_submit_and_approve_reply와 동형이나 text를
    파라미터로 받는다 — 이 스토리는 2건의 답변을 «다른 본문»으로 구분해야 한다
    (그 헬퍼는 "답변 본문" 고정이라 이 스토리 전용으로 옆에 둔다, 공용 헬퍼 수정
    없음 — 다른 소비처 회귀 0)."""
    from app.services.channel_post_comment_replies import create_comment_reply_draft, submit_comment_reply
    from app.services.gate_service import transition_gate

    draft = await create_comment_reply_draft(
        s, org_id=org_id, comment_id=comment.id, text=text, created_by_member_id=human_id,
        created_by_kind="human",
    )
    reply = await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
    await transition_gate(s, org_id, reply.gate_id, "approved", human_id, "승인")
    await s.commit()
    return reply


@pytest.mark.anyio
async def test_comment_with_two_replies_exposes_count_and_latest_text():
    """AC1 — 답변 2건인 댓글에서 replies_count==2·reply(=latest)가 더 최근에
    만든 답변의 text·status를 실어야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_default_role(s, org_id)
            _work_item_id, _gate, _conn, pub = await _seed_full_publication_chain(
                s, org_id=org_id, project_id=project_id,
            )
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)
            await _submit_and_approve_reply_with_text(s, org_id=org_id, human_id=human_id, comment=comment, text="첫 답변")
            second_reply = await _submit_and_approve_reply_with_text(
                s, org_id=org_id, human_id=human_id, comment=comment, text="두 번째 답변",
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
        assert r.status_code == 200, r.text
        item = next(c for c in r.json()["comments"] if c["id"] == str(comment.id))
        assert item["replies_count"] == 2, item
        assert item["reply"]["text"] == "두 번째 답변", item
        assert item["reply"]["id"] == str(second_reply.id), item
        assert item["reply"]["status"] == "pending", item
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_with_single_reply_exposes_text_and_count_one():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_default_role(s, org_id)
            _work_item_id, _gate, _conn, pub = await _seed_full_publication_chain(
                s, org_id=org_id, project_id=project_id,
            )
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)
            await _submit_and_approve_reply_with_text(s, org_id=org_id, human_id=human_id, comment=comment, text="유일한 답변")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
        assert r.status_code == 200, r.text
        item = next(c for c in r.json()["comments"] if c["id"] == str(comment.id))
        assert item["replies_count"] == 1, item
        assert item["reply"]["text"] == "유일한 답변", item
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_without_reply_exposes_zero_count_and_null_reply():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_default_role(s, org_id)
            _work_item_id, _gate, _conn, pub = await _seed_full_publication_chain(
                s, org_id=org_id, project_id=project_id,
            )
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
        assert r.status_code == 200, r.text
        item = next(c for c in r.json()["comments"] if c["id"] == str(comment.id))
        assert item["replies_count"] == 0, item
        assert item["reply"] is None, item
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
