"""story #2620(P3) 후속 — 카디르 QA 실크래시 100% 재현 회귀 가드.

`resolve_conversation_webhook_targets`를 새 시그니처(`authorized_member_ids`)로 리팩터하며
호출부 grep을 tests/*.py로만 좁혀서(스코프 실수) `conversation_webhook.py:291`(targets 미전달
fallback — a2a.py:716이 태우는 그 경로, [[feedback_import_grep_misses_call_only_consumers]]
동형)이 구 시그니처(conversation_id/mentioned_ids/blocker_member_ids)로 남았었다. webhook 설정
agent로 가는 모든 A2A SendMessage task가 TypeError로 100% 크래시했다(카디르 실측). 이 테스트는
`_handle_send_message`를 실제로 호출해(단위 함수 직접 호출이 아니라 그 진짜 caller를 통해) 그
fallback 경로를 태운다 — fix 전으로 되돌리면 TypeError로 RED여야 한다(아래 mutation self-check).

story #2004 관례(`test_2004_a2a_sendmessage_idempotency_realdb.py`) 그대로: `Base.metadata.
create_all` 자체 스키마(FK 검증 끔) + 모듈-전역 engine 루프 격리(`_dispose_global_engine_after_
test`) — `deliver_conversation_message_webhook`가 내부에서 `app.core.database.async_session_
factory`(그 전역 engine)를 직접 열므로 이 관례가 그대로 필요하다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _engine_and_sessionmaker():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _bypass_fk(session) -> None:
    from sqlalchemy import text as _text
    await session.execute(_text("SET session_replication_role = replica"))


async def _seed_webhook_agent_member(session) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """a2a.py:716 fallback 진입 조건 — member-bound 활성 WebhookConfig가 있는 agent 1명
    (a2a.py의 has_webhook 게이트가 이걸로 webhook 분기를 택한다)."""
    from app.models.team import TeamMember
    from app.models.webhook_config import WebhookConfig

    await _bypass_fk(session)
    org_id, project_id = uuid.uuid4(), uuid.uuid4()
    member = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
        name="A2A Webhook Fallback Test Agent", role="member", is_active=True,
    )
    session.add(member)
    session.add(WebhookConfig(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, member_id=member.id,
        url=f"https://example.invalid/{uuid.uuid4()}", is_active=True,
        events=["conversation.message_created"],
    ))
    await session.commit()
    return member.id, org_id, project_id


async def _load_member(session, member_id: uuid.UUID):
    from app.models.team import TeamMember

    await _bypass_fk(session)
    return (await session.execute(
        select(TeamMember).where(TeamMember.id == member_id)
    )).scalar_one()


def _send_params(message_id: str, text: str) -> dict:
    return {
        "message": {
            "messageId": message_id,
            "role": "ROLE_USER",
            "parts": [{"text": text}],
        }
    }


@pytest.mark.anyio
async def test_a2a_send_message_to_webhook_agent_does_not_crash():
    """카디르 QA(#2620) 재현 — webhook-설정 agent로의 A2A SendMessage가 크래시 없이 완주하고,
    fallback 경로(targets=None → route_message 재조회)가 실제로 올바른 target(그 agent의
    webhook URL)으로 전달을 스케줄한다(`_retry_deliver` 스케줄 호출을 가로채 확인 — 실제
    HTTP는 별개 fire-and-forget task라 스케줄 여부만 결정적으로 관측 가능).

    fix 전(구 시그니처 잔존) 상태로 되돌리면 `_handle_send_message` 내부의
    `deliver_conversation_message_webhook` 호출이 `resolve_conversation_webhook_targets()
    got an unexpected keyword argument 'conversation_id'`로 TypeError — task 자체가 절대
    반환되지 않는다(아래 mutation self-check가 이를 직접 재현·확인)."""
    from app.routers.a2a import _handle_send_message

    engine, Session = await _engine_and_sessionmaker()
    try:
        async with Session() as s:
            member_id, org_id, project_id = await _seed_webhook_agent_member(s)

        captured_urls: list[str] = []

        def _fake_retry_deliver(delivery_id, url, secret, payload):  # noqa: ARG001
            """실 HTTP는 `_retry_deliver`가 `fire_and_forget`으로 스케줄하는 별개 asyncio
            task 안에서 나가(타이밍 레이스) — 그 task가 실제로 도는지가 아니라 «올바른 target
            으로 스케줄이 됐는지»만 이 테스트의 관심사라, 스케줄 호출 자체(동기 시점)를
            가로챈다. sync 함수가 즉시 캡처하고, fire_and_forget이 기대하는 awaitable만
            돌려준다(무해 no-op 코루틴)."""
            captured_urls.append(url)

            async def _noop():
                return None

            return _noop()

        import app.services.conversation_webhook as cw_mod
        original_retry = cw_mod._retry_deliver
        cw_mod._retry_deliver = _fake_retry_deliver
        try:
            async with Session() as s:
                member = await _load_member(s, member_id)
                result = await _handle_send_message(
                    s, member, _send_params(str(uuid.uuid4()), "a2a webhook fallback regression"),
                )
        finally:
            cw_mod._retry_deliver = original_retry

        assert result["task"]["id"], "task가 정상 반환돼야(크래시 없이 완주)"
        assert result["task"]["metadata"]["delivery_channel"] == "webhook", (
            "이 테스트는 webhook 분기(has_webhook=True)를 태워야 — fakechat로 새면 이 경로가 검증 안 됨"
        )
        assert captured_urls, (
            "webhook delivery가 시도되지 않음 — fallback의 route_message 재조회가 대상을 "
            "못 찾았거나(authorized_member_ids 유도 실패) 애초에 도달 못 함"
        )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_self_check_stale_signature_goes_red_then_restored_green():
    """mutation self-check — fallback 호출부를 구 시그니처(conversation_id/mentioned_ids/
    blocker_member_ids)로 되돌리면 위 테스트와 동형 시나리오가 TypeError로 RED여야 한다(그래야
    이 회귀 테스트가 실제로 그 시그니처 정합을 검증하고 있다는 증거). 그 다음 원복해 GREEN
    재확인([[feedback_guard_must_declare_what_it_misses]])."""
    import inspect
    import app.services.conversation_webhook as cw_mod
    from app.routers.a2a import _handle_send_message

    original_fn = cw_mod.deliver_conversation_message_webhook

    async def _stale_signature_fallback(
        message_id, conversation_id, org_id, project_id, sender_id, thread_id, created_at,
        mentioned_ids=None, content=None, targets=None,
    ):
        """fix 전 실제 프로덕션 코드가 하던 일 그대로 재현 — targets=None이면 구 kwarg로
        resolve_conversation_webhook_targets를 호출해 TypeError를 강제한다."""
        if targets is None:
            await cw_mod.resolve_conversation_webhook_targets(
                None,
                conversation_id=conversation_id,
                org_id=org_id,
                project_id=project_id,
                sender_id=sender_id,
                mentioned_ids=mentioned_ids,
                blocker_member_ids=set(),
            )
        raise AssertionError("도달하면 안 됨 — 위 호출에서 TypeError가 먼저 발생해야")

    engine, Session = await _engine_and_sessionmaker()
    try:
        async with Session() as s:
            member_id, org_id, project_id = await _seed_webhook_agent_member(s)

        import app.routers.a2a as a2a_module
        a2a_module.deliver_conversation_message_webhook = _stale_signature_fallback
        try:
            with pytest.raises(TypeError):
                async with Session() as s:
                    member = await _load_member(s, member_id)
                    await _handle_send_message(
                        s, member, _send_params(str(uuid.uuid4()), "red: stale signature"),
                    )
        finally:
            a2a_module.deliver_conversation_message_webhook = original_fn

        # GREEN 재확인 — 원복 후 새 message_id로 동일 시나리오가 정상 완주.
        async with Session() as s:
            member = await _load_member(s, member_id)
            result = await _handle_send_message(
                s, member, _send_params(str(uuid.uuid4()), "green: restored signature"),
            )
        assert result["task"]["id"]
        assert inspect.iscoroutinefunction(a2a_module.deliver_conversation_message_webhook)
    finally:
        await engine.dispose()
