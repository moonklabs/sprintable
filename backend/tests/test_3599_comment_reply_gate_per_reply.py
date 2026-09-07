"""story #3599(BE·결함·결재 이력, 페드루 PO 決 2026-09-07) — 댓글 답변 2차 상신이
1차 답변의 external_publish 게이트를 재개방·덮어쓰기하던 결함의 근본 수정.

원인: submit_comment_reply의 scope_key가 "comment:{comment_id}"뿐이라 create_gate
(work_item, gate_type, scope_key) 슬롯 재사용 멱등이 댓글당 게이트 1행으로
수렴했다 — 2차 답변 상신이 1차 답변 게이트를 재-open해 sealed_content_sha256/
body/neutral_facts/resolved_at을 2차 것으로 덮어썼다("14:07Z에 무엇을 승인
했나"가 사라지는 감사 갭).

처방: scope_key를 "comment:{comment_id}:{reply_id}"로 answer마다 쪼갠다(같은
reply_id 재상신 경로가 없다 — submit_comment_reply가 status=="draft"만 허용,
새 답변은 항상 새 reply_id — 이력 테이블 신설 불요, PR 그라운딩 근거). 추가로
transition_gate의 ActivityLog context에 sealed_content_sha256·sealed_content_
version을 얹어(append-only) 게이트 행 자체가 나중에 다른 이유로 재사용되더라도
"그 결정 시점에 무엇을 승인했나"가 이력에 남게 한다.

세팅 헬퍼는 test_3596_open_reply_draft_additive.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_default_role, _seed_human, _seed_org, _session_factory
from app.main import app
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


async def _submit_and_approve(s, *, org_id, comment, human_id, text):
    from app.services.channel_post_comment_replies import create_comment_reply_draft, submit_comment_reply
    from app.services.gate_service import transition_gate

    draft = await create_comment_reply_draft(
        s, org_id=org_id, comment_id=comment.id, text=text,
        created_by_member_id=human_id, created_by_kind="human",
    )
    reply = await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
    await transition_gate(s, org_id, reply.gate_id, "approved", human_id, "승인")
    await s.commit()
    # 실 워커(process_due_publication_commands) 없이도 다음 답변을 만들 수 있게
    # sent로 종결(create_comment_reply_draft의 409 가드는 draft/pending만 막는다 —
    # 이 스토리 관심사(게이트 슬롯 분리)와 무관한 축이라 워커까지 안 돌린다).
    reply.status = "sent"
    await s.commit()
    await s.refresh(reply)
    return reply


@pytest.mark.anyio
async def test_second_reply_submit_gets_own_gate_row_first_seal_untouched():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            first = await _submit_and_approve(s, org_id=org_id, comment=comment, human_id=human_id, text="1차 봉인 원문")
            first_gate_id = first.gate_id
            from app.models.gate import Gate
            first_gate_snapshot = (await s.execute(
                Gate.__table__.select().where(Gate.id == first_gate_id)
            )).mappings().one()

            second = await _submit_and_approve(s, org_id=org_id, comment=comment, human_id=human_id, text="2차 봉인 원문")

            # 뮤테이션 대상①(scope_key 원복 → 같은 gate row 재사용 → 이 assert가 RED).
            assert second.gate_id != first_gate_id, "2차 답변이 1차 게이트를 재사용하면 안 된다(scope_key가 reply 단위여야)"

            first_gate_after = (await s.execute(
                Gate.__table__.select().where(Gate.id == first_gate_id)
            )).mappings().one()
            assert first_gate_after["sealed_content_sha256"] == first_gate_snapshot["sealed_content_sha256"]
            assert first_gate_after["sealed_content_body"] == "1차 봉인 원문"
            assert first_gate_after["neutral_facts"]["reply_id"] == str(first.id)
            assert first_gate_after["resolved_at"] == first_gate_snapshot["resolved_at"]
            assert first_gate_after["sealed_content_version"] == 1

            # story #3599(유나 §22-17 ⑥-1) — 게이트 생성 시점 sent 카운트 스냅샷.
            # 1차는 만들 당시 보낸 답변 0건, 2차는 1차가 이미 sent라 1건이어야
            # 한다(뮤테이션 대상③ — sent_replies_count 배선 제거 → KeyError/None RED).
            assert first_gate_snapshot["neutral_facts"]["sent_replies_count"] == 0
            second_gate = (await s.execute(
                Gate.__table__.select().where(Gate.id == second.gate_id)
            )).mappings().one()
            assert second_gate["neutral_facts"]["sent_replies_count"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_approved_activity_log_context_carries_sealed_content_sha_and_version():
    """뮤테이션 대상②(context에서 sealed_content_sha256 제거 → 이 assert가 RED)."""
    from app.models.activity_log import ActivityLog

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            reply = await _submit_and_approve(s, org_id=org_id, comment=comment, human_id=human_id, text="승인 대상 답변")

            log_row = (await s.execute(
                ActivityLog.__table__.select().where(
                    ActivityLog.entity_id == reply.gate_id, ActivityLog.action == "gate_approved",
                )
            )).mappings().one()
            import hashlib
            expected_sha = hashlib.sha256("승인 대상 답변".encode("utf-8")).hexdigest()
            assert log_row["context"]["sealed_content_sha256"] == expected_sha
            assert log_row["context"]["sealed_content_version"] == 1
            # 기존 키 불변(additive) — head_sha 등 원래 있던 필드가 그대로.
            assert "work_item_id" in log_row["context"]
    finally:
        await engine.dispose()
