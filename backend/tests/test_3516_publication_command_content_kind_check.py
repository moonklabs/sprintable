"""story #3516 조각② 라이브 핫픽스(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) —
`publication_commands.content_kind` CHECK(0323)에 "comment_reply"가 빠져 있어
댓글 답변 게이트 승인이 dev 배포32에서 500(IntegrityError)으로 죽던 결함.

뿌리 원인: 0323이 CHECK를 raw SQL로만 걸고 `PublicationCommand` 모델
`__table_args__`엔 미러가 없었다 — 로컬 테스트가 전부 `Base.metadata.create_all()`
로 스키마를 세우는데(마이그 안 거침) 그 경로는 모델에 없는 제약을 못 본다. 이
파일은 그 사각지대를 직접 겨눈다: create_all() 기반 세션에서도(마이그 0340이
아니라 모델 __table_args__의 CheckConstraint 미러가 이제 그 자리를 채운다)
content_kind="comment_reply" INSERT는 통과하고 미등록 값은 IntegrityError로
막혀야 한다(양성·음성 대조 — 페드루 PO 明示 요청)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _seed_agent, _seed_default_role, _seed_human, _seed_org, _session_factory,
)
from tests.test_3497_insight_snapshots import _seed_channel_connection
from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3502_insights_board import _seed_channel_publication as _seed_board_channel_publication
from tests.test_3502_insights_board import _seed_gate
from tests.test_3471_org_content_rules_lint import _seed_story
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


# ─── 양성 대조 — content_kind="comment_reply" INSERT는 통과 ──────────────────


@pytest.mark.anyio
async def test_content_kind_comment_reply_insert_passes_check_constraint():
    from app.models.publication_command import PublicationCommand

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            row = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                approved_version=uuid.uuid4(), operation="reply", content_kind="comment_reply",
                requested_by_member_id=uuid.uuid4(),
            )
            s.add(row)
            await s.commit()  # CHECK 위반이면 여기서 IntegrityError.
    finally:
        await engine.dispose()


# ─── 음성 대조 — 미등록 값은 IntegrityError(CHECK가 실제로 걸려 있다는 증거) ──


@pytest.mark.anyio
async def test_content_kind_unknown_value_raises_integrity_error():
    from app.models.publication_command import PublicationCommand
    from sqlalchemy.exc import IntegrityError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            row = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                approved_version=uuid.uuid4(), operation="publish", content_kind="unknown_kind",
                requested_by_member_id=uuid.uuid4(),
            )
            s.add(row)
            with pytest.raises(IntegrityError):
                await s.commit()
    finally:
        await engine.dispose()


# ─── 뮤테이션 자가검증 — 모델 CheckConstraint를 빼면 위 음성 대조가 더는 안 걸린다 ─


@pytest.mark.anyio
async def test_mutation_dropping_check_constraint_lets_unknown_value_through():
    """이번 사고의 «뿌리 원인 재현» — CHECK 자체가 없던 시절(0323 직후, 모델 미러
    이전)을 이 DB 연결에서 직접 흉내낸다(같은 테이블이 앞선 테스트의 create_all()로
    이미 존재해 모델 __table_args__ 몽키패치만으론 재현이 안 되므로, 이 테스트
    안에서만 실 제약을 DROP했다가 끝나면 RESTORE — 다른 테스트에 영향 0)."""
    from sqlalchemy import text as sa_text

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            await s.execute(sa_text(
                "ALTER TABLE publication_commands DROP CONSTRAINT ck_publication_commands_content_kind",
            ))
            await s.commit()
            row_id = uuid.uuid4()
            try:
                from app.models.publication_command import PublicationCommand

                row = PublicationCommand(
                    id=row_id, org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                    approved_version=uuid.uuid4(), operation="publish",
                    content_kind="unknown_kind_should_be_blocked", requested_by_member_id=uuid.uuid4(),
                )
                s.add(row)
                await s.commit()  # 제약이 없는 상태에선 이게 성공해야(=원래는 막혔어야 할 값이 샌다) 정상.
            finally:
                # 복원 前에 방금 넣은 위반 행을 지운다 — 안 지우면 제약 재생성 자체가
                # "기존 행이 위반 中"이라 실패한다(원복이 원복을 못 하는 자기모순 방지).
                await s.execute(sa_text("DELETE FROM publication_commands WHERE id = :id"), {"id": row_id})
                await s.commit()
                await s.execute(sa_text(
                    "ALTER TABLE publication_commands ADD CONSTRAINT ck_publication_commands_content_kind "
                    "CHECK (content_kind IN ('channel_post', 'site_post', 'comment_reply'))",
                ))
                await s.commit()
    finally:
        await engine.dispose()


# ─── e2e — 댓글 답변 게이트 승인 transition이 실제로 성공(라이브 사고의 재현+수정 확인) ─


@pytest.mark.anyio
async def test_comment_reply_gate_approval_e2e_succeeds_without_500():
    """라이브 재현 표본 그대로 — submit→approve(transition_gate, gate_service.py의
    comment_reply 분기가 content_kind="comment_reply"로 커맨드를 만드는 그 자리)가
    이제 IntegrityError 없이 끝까지 간다."""
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == reply.gate_id)
            )).scalar_one()
            assert command.content_kind == "comment_reply"
            assert command.operation == "reply"
    finally:
        await engine.dispose()
