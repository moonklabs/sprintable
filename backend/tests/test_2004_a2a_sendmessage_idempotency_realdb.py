"""story #2004(E-A2A-PROTO Phase B P1-b): A2A SendMessage 멱등키 — 실 Postgres 검증.

`_handle_send_message`는 클라 `Message.message_id`(=`client_message_id`)를 dedup 키로 써서
동일 `(member_id, client_message_id)` 재시도가 **중복 Conversation/Task는 물론 중복 실
위임(webhook 또는 Event+wake_agent)도** 만들지 않도록 봉인한다. 핵심 메커니즘은
`_acquire_send_message_dedup_lock`의 `pg_advisory_xact_lock`(첫 DB 연산) — naive
insert-then-catch-conflict(맨 끝에서 UNIQUE 충돌만 잡는 안)는 그 전에 이미 나간
webhook/Event 부작용을 못 막아 AC3("중복 실행 지시 0")를 위반하므로 채택하지 않았다(모듈
docstring "설계 노트" 참조).

story 8236bbc3 컨벤션: `Base.metadata.create_all`로 자체 스키마 구축(공유 alembic-migrated
DB 오염 방지) — `team_members`는 이 스키마에서 일반 테이블(VIEW 아님, S-A8 멀티프로젝트
fan-out은 이 테스트 스코프 밖)이라 `create_all`로 충분(`test_a2a_sa4_streaming_realdb.py`와
동일 패턴). 이 테스트들은 fakechat(무-webhook) 경로로 고정 — `wake_agent`를 spy해 실 위임
호출 횟수를 직접 센다(webhook 경로는 별도 세션을 여는 `deliver_conversation_message_webhook`
자체가 검증 대상이 아니라 dispatch 여부만 중요하므로, 더 가벼운 fakechat 경로로 통일)."""
from __future__ import annotations

import asyncio
import os
import uuid
from unittest.mock import patch

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
    """다른 a2a realdb 테스트들과 동일 관례 — `app.core.database`의 모듈-전역 engine을 각
    테스트 뒤 폐기해 다음 테스트(다른 anyio 이벤트루프)의 asyncpg cross-loop RuntimeError를
    막는다."""
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
    """`ALEMBIC_DATABASE_URL`이 실 alembic-migrated DB를 가리키면 `team_members.project_id`
    FK(→projects)가 실제로 걸려 있다 — 이 테스트들의 관심사는 project 그래프가 아니라
    `_handle_send_message` dedup 이므로, 다른 a2a realdb 테스트(S-A1)와 동일 관례로 세션
    스코프 FK 검증을 끈다."""
    from sqlalchemy import text as _text
    await session.execute(_text("SET session_replication_role = replica"))


async def _seed_agent_member(session) -> uuid.UUID:
    """team_members 행 하나면 `_handle_send_message`가 필요로 하는 전부다(org_id/project_id는
    이 테스트 관심사 밖 — `_bypass_fk`로 FK 검증을 끈 뒤 임의 UUID를 그대로 쓴다)."""
    from app.models.team import TeamMember

    await _bypass_fk(session)
    member = TeamMember(
        id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
        name="Idempotency Test Agent", role="member", is_active=True,
    )
    session.add(member)
    await session.commit()
    return member.id


def _send_params(message_id: str, text: str) -> dict:
    return {
        "message": {
            "messageId": message_id,
            "role": "ROLE_USER",
            "parts": [{"text": text}],
        }
    }


async def _load_member(session, member_id: uuid.UUID):
    """`_handle_send_message`가 이 세션으로 Conversation(project_id/org_id FK) insert를
    할 것이므로, 매 세션(=매 커넥션 체크아웃, `SET session_replication_role`은 커넥션-스코프라
    이전 세션의 설정이 이어진다는 보장이 없다 — 특히 진짜 동시성 테스트는 서로 다른 커넥션을
    쓴다)마다 여기서 `_bypass_fk`를 다시 건다."""
    from app.models.team import TeamMember

    await _bypass_fk(session)
    return (await session.execute(
        select(TeamMember).where(TeamMember.id == member_id)
    )).scalar_one()


async def _tasks_for_member(session, member_id: uuid.UUID) -> list:
    from app.models.a2a_task import A2ATask

    return list((await session.execute(
        select(A2ATask).where(A2ATask.member_id == member_id)
    )).scalars().all())


@pytest.mark.anyio
async def test_sequential_replay_dedupes_task_and_dispatch():
    """AC1/AC3: 동일 message_id로 순차 2회 호출 — task 1개, 두 응답 모두 같은 task id, wake_agent
    정확히 1회(fakechat 경로 고정이므로 wake_agent가 실 위임의 대리 신호)."""
    from app.routers.a2a import _handle_send_message

    engine, Session = await _engine_and_sessionmaker()
    try:
        async with Session() as s:
            member_id = await _seed_agent_member(s)

        message_id = str(uuid.uuid4())

        with patch("app.routers.a2a.wake_agent") as mock_wake_agent:
            async with Session() as s:
                member = await _load_member(s, member_id)
                result1 = await _handle_send_message(s, member, _send_params(message_id, "hello"))

            async with Session() as s:
                member = await _load_member(s, member_id)
                result2 = await _handle_send_message(
                    s, member, _send_params(message_id, "hello again (retry)"),
                )

        assert result1["task"]["id"] == result2["task"]["id"]
        assert mock_wake_agent.call_count == 1, (
            f"expected exactly 1 delegation dispatch, got {mock_wake_agent.call_count}"
        )

        async with Session() as s:
            tasks = await _tasks_for_member(s, member_id)
            assert len(tasks) == 1, f"expected exactly 1 A2ATask row, found {len(tasks)}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_true_concurrency_race_single_task_single_dispatch():
    """AC2(핵심): 동일 message_id를 진짜 동시에(asyncio.gather, 별도 세션/커넥션 2개) 발사해도
    advisory xact lock 직렬화 덕에 task 1개·dispatch 1회만 나간다 — 순차 재호출이 아니라 실
    레이스에서 TOCTOU가 구조적으로 막힌다는 증거(이 테스트가 통과해야 story #2004의 핵심
    주장이 실증된다)."""
    from app.routers.a2a import _handle_send_message

    engine, Session = await _engine_and_sessionmaker()
    try:
        async with Session() as s:
            member_id = await _seed_agent_member(s)

        message_id = str(uuid.uuid4())

        async def _call(text: str) -> dict:
            async with Session() as s:
                member = await _load_member(s, member_id)
                return await _handle_send_message(s, member, _send_params(message_id, text))

        with patch("app.routers.a2a.wake_agent") as mock_wake_agent:
            result1, result2 = await asyncio.gather(
                _call("concurrent call A"), _call("concurrent call B"),
            )

        assert result1["task"]["id"] == result2["task"]["id"], (
            "두 동시 호출이 서로 다른 task id를 반환 — advisory lock 직렬화 실패(레이스 재발)"
        )
        assert mock_wake_agent.call_count == 1, (
            f"true-concurrency race에서 중복 dispatch 발생: wake_agent 호출 {mock_wake_agent.call_count}회"
        )

        async with Session() as s:
            tasks = await _tasks_for_member(s, member_id)
            assert len(tasks) == 1, (
                f"true-concurrency race에서 중복 A2ATask 발생: {len(tasks)}행"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_different_message_ids_produce_independent_tasks_and_dispatches():
    """회귀 가드: message_id가 다르면(같은 member) 완전히 독립된 task 2개 + dispatch 2회 —
    락/dedup 키가 member_id 단독으로 과확장되지 않았음을 확인(story #2004 요구 §3)."""
    from app.routers.a2a import _handle_send_message

    engine, Session = await _engine_and_sessionmaker()
    try:
        async with Session() as s:
            member_id = await _seed_agent_member(s)

        with patch("app.routers.a2a.wake_agent") as mock_wake_agent:
            async with Session() as s:
                member = await _load_member(s, member_id)
                result1 = await _handle_send_message(
                    s, member, _send_params(str(uuid.uuid4()), "first independent message"),
                )
            async with Session() as s:
                member = await _load_member(s, member_id)
                result2 = await _handle_send_message(
                    s, member, _send_params(str(uuid.uuid4()), "second independent message"),
                )

        assert result1["task"]["id"] != result2["task"]["id"]
        assert mock_wake_agent.call_count == 2

        async with Session() as s:
            tasks = await _tasks_for_member(s, member_id)
            assert len(tasks) == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_self_check_dedup_bypass_goes_red_then_restored_green():
    """5(mutation self-check): `_acquire_send_message_dedup_lock`을 항상 None 반환(=dedup
    우회)으로 monkeypatch하면 test 1과 동형 시나리오(동일 message_id 2콜)가 RED여야 한다 —
    중복 task 2개 + 중복 dispatch 2회가 실제로 관측돼야 한다(그래야 원래 테스트가 "우연히
    통과"가 아니라 이 메커니즘을 실제로 검증한다는 증거). 그 다음 원복해 GREEN(정상 dedup)을
    재확인한다.

    ⚠️함정(방어선 2가 방어선 1의 우회를 가려버림): 마이그 0201 partial UNIQUE 인덱스가 여전히
    걸려 있으면, 락+재확인만 우회해도 두 번째 콜의 A2ATask insert가 UNIQUE violation →
    `_handle_send_message`의 IntegrityError 백스톱이 그 경합을 조용히 흡수해 여전히 task
    1개·dispatch 1회로 끝난다(defense-in-depth가 "우연히" RED를 GREEN처럼 보이게 만듦 —
    이 테스트가 검증하려는 게 바로 "락이 실제로 기여하는가"이므로 이 흡수는 무의미한 통과다).
    그래서 RED 구간에서는 UNIQUE 인덱스도 함께 임시 제거해 **락 메커니즘 단독**의 기여를
    격리 관찰하고, GREEN 구간 전에 원복한다(GREEN 자체는 락만으로 충분 — existing_task
    재확인이 두 번째 콜의 insert 시도 자체를 막으므로 UNIQUE 인덱스에 의존하지 않는다)."""
    import app.routers.a2a as a2a_module
    from sqlalchemy import text as sa_text

    _DROP_UQ_SQL = "DROP INDEX IF EXISTS uq_a2a_tasks_member_client_message_id"
    _CREATE_UQ_SQL = (
        "CREATE UNIQUE INDEX uq_a2a_tasks_member_client_message_id ON a2a_tasks "
        "(member_id, client_message_id) WHERE client_message_id IS NOT NULL"
    )

    engine, Session = await _engine_and_sessionmaker()
    try:
        async with Session() as s:
            member_id = await _seed_agent_member(s)

        message_id = str(uuid.uuid4())

        # ── RED: 방어선 1(락+재확인) 우회 + 방어선 2(UNIQUE 인덱스) 임시 제거 — "이 메커니즘이
        # 없으면 정말로 중복이 난다"를 순수하게 격리 실증.
        async def _bypass_always_none(session, member_id, client_message_id):  # noqa: ARG001
            return None

        original = a2a_module._acquire_send_message_dedup_lock
        a2a_module._acquire_send_message_dedup_lock = _bypass_always_none
        async with Session() as s:
            await s.execute(sa_text(_DROP_UQ_SQL))
            await s.commit()
        try:
            with patch("app.routers.a2a.wake_agent") as mock_wake_agent:
                async with Session() as s:
                    member = await _load_member(s, member_id)
                    await a2a_module._handle_send_message(
                        s, member, _send_params(message_id, "red call 1"),
                    )
                async with Session() as s:
                    member = await _load_member(s, member_id)
                    await a2a_module._handle_send_message(
                        s, member, _send_params(message_id, "red call 2 (same message_id)"),
                    )

            async with Session() as s:
                tasks_red = await _tasks_for_member(s, member_id)
            assert len(tasks_red) == 2, (
                "mutation self-check 실패: 방어선을 모두 걷어냈는데도 task가 1개뿐 — 이 테스트가 "
                "실제로 dedup 메커니즘을 검증하고 있지 않다는 뜻(가짜 GREEN 위험)"
            )
            assert mock_wake_agent.call_count == 2, (
                "mutation self-check 실패: 방어선을 모두 걷어냈는데도 dispatch가 1회뿐"
            )
        finally:
            a2a_module._acquire_send_message_dedup_lock = original
            # RED 구간이 의도적으로 만든 중복 행(같은 member_id+client_message_id 2개)부터
            # 청소해야 UNIQUE 인덱스 재생성이 성공한다 — 정리 없이 그대로 재생성하면 방금 만든
            # 그 중복 자체가 CREATE UNIQUE INDEX를 막는다.
            async with Session() as s:
                await s.execute(sa_text(
                    "DELETE FROM a2a_tasks WHERE member_id = :mid AND client_message_id = :cmid"
                ), {"mid": str(member_id), "cmid": message_id})
                await s.execute(sa_text(_CREATE_UQ_SQL))
                await s.commit()

        # ── GREEN: 원복 후 동일 시나리오(새 message_id로, 앞선 RED 오염과 독립) 재확인.
        message_id_2 = str(uuid.uuid4())
        with patch("app.routers.a2a.wake_agent") as mock_wake_agent:
            async with Session() as s:
                member = await _load_member(s, member_id)
                result1 = await a2a_module._handle_send_message(
                    s, member, _send_params(message_id_2, "green call 1"),
                )
            async with Session() as s:
                member = await _load_member(s, member_id)
                result2 = await a2a_module._handle_send_message(
                    s, member, _send_params(message_id_2, "green call 2 (same message_id)"),
                )

        assert result1["task"]["id"] == result2["task"]["id"]
        assert mock_wake_agent.call_count == 1

        async with Session() as s:
            tasks_for_id2 = [
                t for t in await _tasks_for_member(s, member_id)
                if t.client_message_id == message_id_2
            ]
            assert len(tasks_for_id2) == 1
    finally:
        await engine.dispose()
