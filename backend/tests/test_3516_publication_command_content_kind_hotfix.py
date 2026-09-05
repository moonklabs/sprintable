"""story #3516 조각② 라이브 결함 핫픽스(페드루 실사용 재현 2026-09-05 16:19Z,
배포32) — `publication_commands.content_kind` CHECK 제약(story e4fc29fa, migration
0323)이 `content_kind="comment_reply"`(3516 조각②)를 안 담아 댓글 답변 게이트
승인이 500으로 샜다. `create_or_get_publication_command`의 IntegrityError 처리는
`uq_publication_commands_idempotency`만 걸러내 그 외(CheckViolation 포함)는
그대로 re-raise하고, `transition_gate_endpoint`의 `except ValueError`도 이를 못
잡는다 — 두 레이어 다 무변경으로 두고 제약 자체만 이 마이그(0340)로 넓힌다.

로컬 테스트가 못 잡은 이유(재발 방지 핵심) — 이 CHECK는 0323이 raw SQL로만 걸어
`PublicationCommand` 모델의 `__table_args__`엔 없었다. `Base.metadata.create_all()`
(이 테스트 스위트의 disposable DB 셋업 방식)은 모델 정의만 보고 DDL을 짜므로 이
제약 자체가 생성되지 않아, 조각②의 광범위한 테스트도 이 CheckViolation을 한 번도
재현 못 했다. 이 핫픽스가 모델에도 CheckConstraint를 명시 추가했으므로 — 아래
테스트는 이제 `create_all()` 경로로도 이 제약을 실제로 태운다(뮤테이션 자가검증
포함)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory

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


@pytest.mark.anyio
async def test_comment_reply_content_kind_insert_succeeds_end_to_end():
    """정확히 사고 재현 경로 — `create_or_get_publication_command(content_kind=
    "comment_reply")`가 CheckViolation 없이 성공해야 한다(라이브 500의 직접 원인이
    었던 그 INSERT)."""
    from app.services.publication_command import create_or_get_publication_command

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            command, created = await create_or_get_publication_command(
                s, org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                approved_version=uuid.uuid4(), requested_by_member_id=uuid.uuid4(),
                scheduled_at=None, operation="reply", content_kind="comment_reply",
            )
            await s.commit()
            assert created is True
            assert command.content_kind == "comment_reply"
            assert command.operation == "reply"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_content_kind_still_rejected_by_check_constraint():
    """제약이 아예 없어진 게 아니라 값 목록만 넓어졌다는 것의 대조군 — 여전히
    모르는 값은 막혀야 한다(제약을 통째로 지워버리는 잘못된 "수정"을 방지)."""
    from app.services.publication_command import create_or_get_publication_command
    from sqlalchemy.exc import IntegrityError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            with pytest.raises(IntegrityError):
                await create_or_get_publication_command(
                    s, org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                    approved_version=uuid.uuid4(), requested_by_member_id=uuid.uuid4(),
                    scheduled_at=None, operation="reply", content_kind="totally_unknown_kind",
                )
            await s.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_full_gate_approval_flow_for_comment_reply_does_not_500(monkeypatch):
    """라이브 재현 경로 그대로 — 댓글 답변 초안→상신(게이트 생성)→승인(gates.py
    범용 전이)까지 API 계층 전체를 왕복해 500이 안 나는지 확認(서비스 계층 단위
    테스트만으론 라우터의 예외 전파 경로까지 못 잡는다 — 이번 사고가 정확히 그
    경계에서 났다)."""
    from app.main import app
    from tests.test_3502_insights_board import _seed_channel_publication as _seed_board_channel_publication
    from tests.test_3502_insights_board import _seed_gate
    from tests.test_3471_org_content_rules_lint import _seed_story
    from tests.test_3497_insight_snapshots import _seed_channel_connection
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _seed_human

    import app.services.channel_adapters as adapters_mod
    from cryptography.fernet import Fernet
    import app.core.config as config_module
    import importlib
    import app.services.channel_credential_crypto as crypto_module

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    importlib.reload(crypto_module)

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete,sandbox_manage_replies",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        insight_metrics=(), supports_fetch_replies=True, supports_reply=True,
        reply_required_scope="sandbox_manage_replies",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()

            human_id, _ = await _seed_human(s, org_id)
            work_item_id = await _seed_story(s, org_id, project_id)
            gate = await _seed_gate(s, org_id=org_id, work_item_id=work_item_id)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_board_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="sandbox", published_at=datetime.now(timezone.utc),
                connection_id=conn.id,
            )

            import hashlib
            from app.models.channel_post_comment import ChannelPostComment
            text = "원 댓글"
            comment = ChannelPostComment(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="sandbox",
                external_comment_id="c1", author_display_name="u", text=text,
                text_sha256=hashlib.sha256(text.encode()).hexdigest(),
                external_created_at=datetime.now(timezone.utc), captured_at=datetime.now(timezone.utc), raw={},
            )
            s.add(comment)
            await s.commit()

            from app.services.channel_post_comment_replies import create_comment_reply_draft, submit_comment_reply

            draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="답변 본문", created_by_member_id=human_id,
                created_by_kind="human",
            )
            reply = await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
            gate_id = reply.gate_id

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/gates/{gate_id}/transition",
                    json={"status": "approved", "note": "승인", "evidence_viewed": True},
                )
            assert resp.status_code == 200, resp.text
        finally:
            app.dependency_overrides.clear()

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            assert command.content_kind == "comment_reply"
            assert command.status in ("pending", "in_progress", "completed")
    finally:
        await engine.dispose()
