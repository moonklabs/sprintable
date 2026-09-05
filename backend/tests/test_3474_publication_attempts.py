"""story #3474(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 워커가 adapter 호출
직전 게이트를 재검증하고(site_post 경로 신규, channel_post는 무변) 매 시도를
`publication_attempts` 원장에 남긴다. 블루프린트 §1 구조적 차단 장치 4 「승인 없는
adapter 호출 0건」을 표본 3종(양성·부정·부정)으로 고정한다.

디디 그라운딩(2026-09-05, 페드루 실물 대조로 확認) — 재검증 신규 코드는 site_post
외부 발행·발행 취소 둘뿐(publish_site_post_external_command·unpublish_site_post_
external_command). channel_post(publish_channel_post_draft)는 이미 재검증이 있어
무변 — 그 경로의 기존 테스트(test_3414_publication_command.py) 쪽에 원장 assert
한 줄만 추가했다(이 파일이 아님).

세팅 헬퍼는 test_e4fc29fa_site_post_orchestration.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _client_for,
    _create_and_submit_site_post_draft,
    _seed_agent,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _seed_wordpress_connection,
    _session_factory,
    _setup_org_scoped_app,
    live_wordpress_stub,  # noqa: F401 — pytest fixture import
)

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


async def _seed_and_approve(*, live_wordpress_stub_url, story_title="사이트 포스트"):
    """org→story→wordpress connection→draft 제출→승인까지 공통 준비. 반환값으로
    이후 검증에 필요한 전부(엔진·세션팩토리·조직·게이트·커맨드 조회용 식별자)를 준다."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        agent_id = await _seed_agent(s, org_id, project_id)
        human_user_id, human_id = await _seed_human(s, org_id)
        story_id = await _seed_story(s, org_id, project_id, title=story_title)
        connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub_url)

    _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
    async with _client_for(app) as client:
        draft_id, gate_id = await _create_and_submit_site_post_draft(
            client, org_id=org_id, story_id=story_id, connection_id=connection_id,
        )

    async with Session() as s:
        await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
        await s.commit()

    return engine, Session, app, org_id, draft_id, gate_id, human_id


async def _command_id_for_gate(Session, gate_id):
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    async with Session() as s:
        return (await s.execute(
            select(PublicationCommand.id).where(PublicationCommand.gate_id == gate_id)
        )).scalar_one()


@pytest.mark.anyio
async def test_approved_gate_attempt_ok_and_adapter_called_once(live_wordpress_stub):
    """(a) 양성대조 — 정상 승인 경로는 attempt 원장에 approval_check='ok'·
    adapter_called=True가 정확히 1행 남고, 실 스텁에 진짜 글이 생긴다(카운트=1, 항상
    통과하는 가짜 테스트가 아님을 스텁 원장으로 증명)."""
    from app.services.publication_command import process_due_publication_commands
    from app.routers.dev_wordpress_stub import _POSTS

    engine, Session, app, org_id, draft_id, gate_id, human_id = await _seed_and_approve(
        live_wordpress_stub_url=live_wordpress_stub,
    )
    try:
        cmd_id = await _command_id_for_gate(Session, gate_id)

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts
        assert len(_POSTS) == 1, "adapter가 정확히 한 번만 실 스텁에 글을 만들어야 한다"

        from app.models.publication_attempt import PublicationAttempt
        from sqlalchemy import select

        async with Session() as s:
            attempts = (await s.execute(
                select(PublicationAttempt).where(PublicationAttempt.command_id == cmd_id)
            )).scalars().all()
        assert len(attempts) == 1
        assert attempts[0].approval_check == "ok"
        assert attempts[0].adapter_called is True
        assert attempts[0].gate_id == gate_id
        assert attempts[0].finished_at is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_no_longer_approved_rejected_before_adapter_call(live_wordpress_stub):
    """(b) 부정대조 — void_pending_commands_for_gate 훅이 보통 이 경합을 선점하지만,
    놓친 경우를 워커가 뒤늦게 만나는 시나리오를 직접 DB 조작으로 재현한다(channel_post
    쪽 기존 결정적-실패 테스트와 동형 기법). adapter가 아예 안 불려야 한다(스텁 원장
    0건이 유일한 신뢰 가능한 증거 — command.status만 보면 조작 성공 여부를 못 가른다)."""
    from app.models.gate import Gate
    from app.services.publication_command import process_due_publication_commands
    from app.routers.dev_wordpress_stub import _POSTS
    from sqlalchemy import select

    engine, Session, app, org_id, draft_id, gate_id, human_id = await _seed_and_approve(
        live_wordpress_stub_url=live_wordpress_stub,
    )
    try:
        cmd_id = await _command_id_for_gate(Session, gate_id)

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.status = "pending"
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["blocked_unapproved"] == 1, counts
        assert _POSTS == {}, "게이트 재검증에서 막혔는데 adapter가 실제로 호출됐다"

        from app.models.publication_command import PublicationCommand
        from app.models.publication_attempt import PublicationAttempt

        async with Session() as s:
            cmd_row = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == cmd_id)
            )).scalar_one()
            assert cmd_row.status == "blocked_unapproved"

            attempts = (await s.execute(
                select(PublicationAttempt).where(PublicationAttempt.command_id == cmd_id)
            )).scalars().all()
        assert len(attempts) == 1
        assert attempts[0].approval_check == "missing"
        assert attempts[0].adapter_called is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approved_but_sealed_hash_mismatch_rejected_before_adapter_call(live_wordpress_stub):
    """(c) 부정대조 — 게이트는 approved 그대로지만 봉인된 sha256과 지금 버전의
    body_sha256이 다르다(승인 뒤 버전이 몰래 바뀐 경합을 직접 DB 조작으로 재현 —
    resubmit 흐름을 타면 이미 별도 테스트(#3437 계열)가 있는 재승인 로직이 선점해
    이 지점(워커 자신의 재검증)까지 못 온다). adapter 0회·voided 종결."""
    from app.models.site_post_version import SitePostVersion
    from app.services.publication_command import process_due_publication_commands
    from app.routers.dev_wordpress_stub import _POSTS
    from sqlalchemy import select

    engine, Session, app, org_id, draft_id, gate_id, human_id = await _seed_and_approve(
        live_wordpress_stub_url=live_wordpress_stub,
    )
    try:
        cmd_id = await _command_id_for_gate(Session, gate_id)

        async with Session() as s:
            version = (await s.execute(
                select(SitePostVersion).where(SitePostVersion.draft_id == draft_id)
            )).scalar_one()
            version.body_sha256 = "0" * 64  # 봉인된 sha256과 절대 안 맞는 값.
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["voided"] == 1, counts
        assert _POSTS == {}, "봉인 sha256 불일치인데 adapter가 실제로 호출됐다"

        from app.models.publication_command import PublicationCommand
        from app.models.publication_attempt import PublicationAttempt

        async with Session() as s:
            cmd_row = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == cmd_id)
            )).scalar_one()
            assert cmd_row.status == "voided"
            assert cmd_row.reason_code == "CONTENT_CHANGED"

            attempts = (await s.execute(
                select(PublicationAttempt).where(PublicationAttempt.command_id == cmd_id)
            )).scalars().all()
        assert len(attempts) == 1
        assert attempts[0].approval_check == "version_mismatch"
        assert attempts[0].adapter_called is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_gate_no_longer_approved_rejected_before_module_unpublish_call(live_wordpress_stub):
    """(d) 페드루 리뷰 보정①(2026-09-05) — publish 경로의 부정대조(b)만으론 부족하다,
    unpublish도 「동형으로 확인 필요」라 명시했던 자리. 발행 완료 뒤 게이트가 무효화된
    상태에서 회수 요청 커맨드가 워커에 걸리면, `unpublish_site_post_external_command`
    자신의 신규 재검증이 adapter(module.unpublish) 호출 자체를 막아야 한다 — 스텁
    원장(_POSTS)의 status가 "draft"로 안 바뀌는 것이 유일한 신뢰 가능한 증거(command
    상태만 보면 조작 성공 여부를 못 가른다)."""
    from app.models.gate import Gate
    from app.services.publication_command import process_due_publication_commands
    from app.services.site_posts import request_site_post_external_unpublish
    from app.routers.dev_wordpress_stub import _POSTS
    from sqlalchemy import select

    engine, Session, app, org_id, draft_id, gate_id, human_id = await _seed_and_approve(
        live_wordpress_stub_url=live_wordpress_stub,
    )
    try:
        # 1) 정상 발행 완료(양성대조 (a)와 동일 절차) — external_id가 실제로 생긴다.
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts
        assert len(_POSTS) == 1
        published_stub_status = next(iter(_POSTS.values()))["status"]

        # 2) 회수 요청 커맨드를 만든 뒤(서비스 직접 호출 — 라우터의 owner/admin 가드는
        # 이 테스트 관심사가 아니다) 게이트를 무효화한다(void_pending_commands_for_gate
        # 훅이 보통 이 경합을 선점하지만, 놓친 경우를 워커가 마지막으로 잡는 시나리오를
        # 직접 DB 조작으로 재현 — (b)와 동형 기법).
        async with Session() as s:
            await request_site_post_external_unpublish(
                s, org_id=org_id, draft_id=draft_id, requested_by_member_id=human_id,
            )
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.status = "pending"
            await s.commit()

        from app.models.publication_command import PublicationCommand
        async with Session() as s:
            unpub_cmd_id = (await s.execute(
                select(PublicationCommand.id).where(
                    PublicationCommand.gate_id == gate_id, PublicationCommand.operation == "unpublish",
                )
            )).scalar_one()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["blocked_unapproved"] == 1, counts

        # 스텁 원장 — 회수가 실제로 adapter를 안 건드렸다는 유일한 신뢰 가능한 증거.
        assert next(iter(_POSTS.values()))["status"] == published_stub_status, (
            "게이트 재검증에서 막혔는데 module.unpublish가 실제로 호출됐다"
        )

        from app.models.publication_attempt import PublicationAttempt
        async with Session() as s:
            cmd_row = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == unpub_cmd_id)
            )).scalar_one()
            assert cmd_row.status == "blocked_unapproved"

            attempts = (await s.execute(
                select(PublicationAttempt).where(PublicationAttempt.command_id == unpub_cmd_id)
            )).scalars().all()
        assert len(attempts) == 1
        assert attempts[0].approval_check == "missing"
        assert attempts[0].adapter_called is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
