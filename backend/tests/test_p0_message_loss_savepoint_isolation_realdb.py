"""P0(prod-impact, 2026-08-08, 페드루 오르테가 AC 락) — 「send_chat_message가 성공 id를
반환하는데 그 메시지가 conv에 저장 안 되는」 간헐적 유실 근본수정 검증.

근본 메커니즘(로컬 asyncpg+SQLAlchemy 실증·이 파일 test_aborted_transaction_commit_silently_*
이 실PG로 pin): `conversations.py::send_message()`가 메시지를 flush(uncommitted)한 뒤, 그 함수
안에서 나중에 실행되는 다른 DB statement(route_message·resolve_conversation_webhook_targets·
dispatch_notification 등)가 SAVEPOINT(`begin_nested()`) 없이 bare `except Exception:
logger.warning(...)`로만 감싸져 있으면 — 그 statement가 SQL 레벨에서 실패할 때 Postgres
트랜잭션이 ABORTED 상태가 되고, 그 뒤 최종 `db.commit()`은 **예외를 던지지 않고 정상 반환**
하지만 실제로는 Postgres가 그 COMMIT을 ROLLBACK으로 처리해 트랜잭션의 모든 write(먼저 flush한
메시지 insert 포함)가 통째로 사라진다. fix: 위험한 보조 write들을 `_dispatch_conversation_event`
(같은 파일)가 이미 쓰던 패턴대로 `async with db.begin_nested():`(SAVEPOINT)로 격리 —
`dispatch_notification()` 자체도 본문 전체를 SAVEPOINT로 감싸 14+ 콜사이트를 한 번에 보호(클래스
전수 fix, 인스턴스만 닫지 않음).

AC(페드루 지시, 2026-08-08):
  ①양성대조 — 취약 블록이 실패해도 메시지는 살아남는다(fix 後 GREEN).
  ②정상 메시지 저장 회귀 0.
  ③가드 — "aborted 트랜잭션에 commit이 조용히 성공반환+rollback" 되는 실PG 사실 자체를 pin.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import text

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _message_exists(session, message_id: uuid.UUID) -> bool:
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select
    row = (await session.execute(
        select(ConversationMessage.id).where(ConversationMessage.id == message_id)
    )).scalar_one_or_none()
    return row is not None


# ─── AC① 양성대조: 취약 블록이 실패해도 메시지는 살아남는다 ──────────────────────


async def _dispatch_notification_with_real_sql_failure(db, **_kwargs):
    """dispatch_notification()의 대역 — ⛔순수 Python 예외(AsyncMock side_effect=RuntimeError)는
    Postgres 트랜잭션을 조금도 건드리지 않아 이 버그 클래스를 전혀 재현 못 한다(bare except가
    아무 문제 없이 잡아내는 「무해한」 예외라 SAVEPOINT 유무와 무관하게 항상 통과 — 공허 양성대조).
    실제 위험은 "SQL 레벨"에서 실패해야 재현된다 — 그래서 caller의 실 세션으로 진짜 실패하는
    statement(0으로 나누기, DivisionByZero)를 보내 Postgres 트랜잭션을 실제로 ABORT시킨다."""
    await db.execute(text("select 1/0"))


async def test_message_survives_when_dispatch_notification_raises_realdb():
    """dispatch_notification()(conversations.py send_message의 candidate_targets 알림 콜사이트)이
    SQL 레벨에서 실패하는 조건을 실제로 재현 — begin_nested() 격리 前이었다면 이 실패가
    Postgres 트랜잭션 전체를 ABORT시켜 최종 commit이 조용히 ROLLBACK되고 메시지가 통째로
    사라졌을 자리다. fix 後엔 SAVEPOINT가 이 실패만 롤백하고 메시지 insert는 살아남아야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            other_id, other_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [sender_id, other_id], sender_id,
            )

        await _setup_app_human(app, Session, sender_user, org.id)
        with patch(
            "app.services.notification_dispatch.dispatch_notification",
            new=_dispatch_notification_with_real_sql_failure,
        ):
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/conversations/{conv_id}/messages",
                    json={"content": "이 메시지는 알림 write 실패에도 살아남아야 한다"},
                )
        app.dependency_overrides.clear()

        # ⭐본 판정: 성공 응답이면서 실제로 저장까지 됐는지 — 응답만 보고 "성공"이라 믿지 않는다
        # (이 P0 증상 자체가 정확히 "성공 응답인데 저장 안 됨"이었다).
        assert resp.status_code == 201, resp.text
        msg_id = uuid.UUID(resp.json()["data"]["id"])

        async with Session() as check_session:
            assert await _message_exists(check_session, msg_id), (
                "메시지가 201로 응답됐는데 DB에 없다 — SAVEPOINT 격리가 안 먹힌 것(회귀)"
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC② 회귀 0: 정상 메시지 저장은 그대로 ────────────────────────────────────


async def test_normal_message_still_persists_and_is_readable_realdb():
    """실패 주입 없는 정상 경로 — fix가 정상 케이스를 안 건드렸는지 왕복(write_ok→read_success)
    으로 확인."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            other_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [sender_id, other_id], sender_id,
            )

        await _setup_app_human(app, Session, sender_user, org.id)
        async with _client_for(app) as client:
            resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages", json={"content": "정상 메시지"},
            )
            assert resp.status_code == 201, resp.text
            msg_id = resp.json()["data"]["id"]

            list_resp = await client.get(f"/api/v2/conversations/{conv_id}/messages")
            assert list_resp.status_code == 200
            ids = [m["id"] for m in list_resp.json()["data"]]
            assert msg_id in ids
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC③ 가드: aborted 트랜잭션 + commit 조용한 성공반환+rollback 를 실PG로 pin ──────


async def test_aborted_transaction_commit_silently_succeeds_and_rolls_back_realdb():
    """근본 메커니즘 자체를 실PG로 고정한다 — 이 테스트가 없으면 미래에 같은 클래스 결함이
    재발해도 또 조용히 지나간다(페드루 AC③ 명시 요구). 순서: ①정상 insert(flush) ②SAVEPOINT
    없이 실행된 statement가 실패(bare except로 삼킴, 회귀 재현 그대로) ③commit()이 예외를
    안 던지는지 ④그런데도 insert가 사라졌는지 — 넷 다 확인해야 "메커니즘 확定"이라 부를 수 있다."""
    from app.core.database import async_session_factory

    async with async_session_factory() as session:
        table_name = f"p0_probe_{uuid.uuid4().hex[:8]}"
        await session.execute(text(f"create temporary table {table_name} (id int primary key, v text)"))
        await session.commit()

        await session.execute(text(f"insert into {table_name} (id, v) values (1, 'should-vanish')"))

        try:
            # 의도적 실패 — bare except로만 삼킴(begin_nested 없음), 이 파일이 고친 4블록의
            # "고치기 전" 상태 그대로 재현.
            await session.execute(text(f"insert into {table_name} (id, v) values (1, 'dup')"))
            pytest.fail("unique violation이 안 났다 — 픽스처가 잘못됐다")
        except Exception:
            pass  # bare except — 실제 코드의 위험 패턴과 동형(rollback도 savepoint도 없음)

        # 판정①: commit()이 예외 없이 정상 반환되는가(=위험의 핵심 — 실패를 숨긴다)
        await session.commit()  # 예외가 났으면 이 테스트 자체가 여기서 실패해 그 사실을 드러낸다

        # 판정②: 그런데도 먼저 insert한 row는 사라졌는가(=조용한 데이터 유실 그 자체)
        result = await session.execute(text(f"select count(*) from {table_name}"))
        assert result.scalar_one() == 0, (
            "aborted 트랜잭션에서 commit()이 예외 없이 row를 살렸다 — 이 판정 전제가 바뀌었다면"
            " conversations.py::send_message의 SAVEPOINT 격리가 왜 필요한지도 다시 검토할 것"
        )


async def test_savepoint_protects_prior_insert_from_later_failure_realdb():
    """위 위험 시나리오를 begin_nested()로 감쌌을 때 실제로 방어되는지 — fix가 쓰는 패턴 자체의
    정당성을 실PG로 pin(대조 실험 — 위 테스트가 「위험」을, 이 테스트가 「방어」를 각각 고정)."""
    from app.core.database import async_session_factory

    async with async_session_factory() as session:
        table_name = f"p0_probe_ok_{uuid.uuid4().hex[:8]}"
        await session.execute(text(f"create temporary table {table_name} (id int primary key, v text)"))
        await session.commit()

        await session.execute(text(f"insert into {table_name} (id, v) values (1, 'should-survive')"))

        try:
            async with session.begin_nested():
                await session.execute(text(f"insert into {table_name} (id, v) values (1, 'dup')"))
        except Exception:
            pass  # SAVEPOINT 격리 — 여기서 실패해도 begin_nested()가 SAVEPOINT까지만 롤백

        await session.commit()

        result = await session.execute(text(f"select id, v from {table_name}"))
        rows = result.all()
        assert rows == [(1, "should-survive")], (
            "begin_nested() 로 감쌌는데도 먼저 insert한 row가 사라졌다 — SAVEPOINT 격리가 깨졌다"
        )
