"""story #4395 — destructive 리셋의 **관측 · 빠른 실패**(고침 아님).

배경: test_4228에서 앞 테스트가 남긴 전역 엔진 세션(idle in transaction)이 잠금을 쥔 채 남아, 다음 테스트 준비의
`DROP SCHEMA`가 끝없이 기다리다 CI 정지 감지(8분)에야 잘렸다 — 누가 남겼는지 이름이 없는 STALL.

- B: 리셋이 잠금을 `lock_timeout` 안에 못 받으면 막는 세션의 앱 이름 · 상태 · 트랜잭션 나이 · 쿼리를 싣고 즉시 실패.
- C: 전역 엔진 커넥션의 application_name에 지금 destructive 테스트 이름을 싣는다(B의 메시지가 곧 범인 이름).
"""
from __future__ import annotations

import os
import threading
import time

import pytest
from sqlalchemy import create_engine, text

import tests.conftest as conftest_module

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_BLOCKER_APP = "story4395-blocker"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_reset_blocked_by_an_idle_in_transaction_session_fails_fast_naming_the_blocker(monkeypatch):
    """양성 대조: 다른 세션이 표를 읽은 채 트랜잭션을 열어 두면(idle in transaction — CI 덤프의 모양) 리셋은 lock_timeout
    안에 실패하고, 메시지에 그 세션의 앱 이름 · 상태 · 쿼리가 실린다.
    뮤테이션: 리셋에서 lock_timeout을 빼면 DROP이 막는 쪽이 놓을 때(8초 뒤)까지 기다렸다 **성공**한다 → 실패 없음 · 오래 걸림 — RED."""
    url = conftest_module._sync_url(_REAL_DB_URL)
    monkeypatch.setattr(conftest_module, "_RESET_LOCK_TIMEOUT_MS", 1_000)

    setup = create_engine(url)
    with setup.begin() as conn:
        conn.execute(text("CREATE TABLE story4395_probe (id int)"))
    setup.dispose()

    blocker_engine = create_engine(url, connect_args={"application_name": _BLOCKER_APP})
    blocker = blocker_engine.connect()
    blocker.begin()
    blocker.execute(text("SELECT count(*) FROM story4395_probe"))  # AccessShareLock을 쥔 채 idle in transaction
    release = threading.Timer(8.0, blocker.rollback)  # 뮤테이션(lock_timeout 없음)이면 리셋이 여기까지 기다렸다 성공한다
    release.start()
    try:
        started = time.monotonic()
        with pytest.raises(RuntimeError) as caught:
            conftest_module._reset_public_schema(_REAL_DB_URL)
        elapsed = time.monotonic() - started
        message = str(caught.value)
        assert elapsed < 5, elapsed
        assert "story #4395" in message and "DROP SCHEMA" in message, message
        assert f"app='{_BLOCKER_APP}'" in message, message
        assert "state=idle in transaction" in message, message
        assert "story4395_probe" in message, message
    finally:
        release.cancel()
        blocker.rollback()
        blocker.close()
        blocker_engine.dispose()


def test_reset_that_is_not_blocked_still_succeeds_within_the_limit(monkeypatch):
    """음성 대조: 막는 세션이 없으면 짧은 상한(1s)에서도 리셋은 그대로 성공한다(평소 리셋은 잠금 대기 0)."""
    monkeypatch.setattr(conftest_module, "_RESET_LOCK_TIMEOUT_MS", 1_000)
    conftest_module._reset_public_schema(_REAL_DB_URL)
    engine = create_engine(conftest_module._sync_url(_REAL_DB_URL))
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM pg_namespace WHERE nspname = 'public'")).scalar_one() == 1
    engine.dispose()


def test_reset_failure_names_the_full_test_behind_a_tagged_global_engine_session(monkeypatch):
    """막는 세션이 전역 엔진 태그(`ge|<해시>|…`)를 달고 있으면 실패 메시지가 그 해시로 **전체 nodeid**를 되살려 싣는다
    (63바이트 app 이름에서 잘린 긴 함수 이름도 온전히)."""
    url = conftest_module._sync_url(_REAL_DB_URL)
    monkeypatch.setattr(conftest_module, "_RESET_LOCK_TIMEOUT_MS", 1_000)
    long_nodeid = "tests/test_x.py::test_" + "a_very_long_descriptive_test_function_name_" * 2
    monkeypatch.setitem(conftest_module._DESTRUCTIVE_TAG["nodeids"], "abc123", long_nodeid)
    tag = conftest_module._global_engine_test_tag("abc123", long_nodeid.split("::")[1], "_logged")

    setup = create_engine(url)
    with setup.begin() as conn:
        conn.execute(text("CREATE TABLE story4395_probe (id int)"))
    setup.dispose()
    blocker_engine = create_engine(url, connect_args={"application_name": tag})
    blocker = blocker_engine.connect()
    blocker.begin()
    blocker.execute(text("SELECT count(*) FROM story4395_probe"))
    try:
        with pytest.raises(RuntimeError) as caught:
            conftest_module._reset_public_schema(_REAL_DB_URL)
        assert f"test={long_nodeid}" in str(caught.value), str(caught.value)
    finally:
        blocker.rollback()
        blocker.close()
        blocker_engine.dispose()


def test_tag_keeps_the_prefix_and_hash_and_clips_by_bytes_without_splitting_a_character():
    """63바이트(NAMEDATALEN) 안 · 접두와 해시는 늘 남고 · 한글도 글자 중간에서 안 끊는다 · 해시로 전체 nodeid를 되찾는다."""
    long_name = "test_overlapping_crons_handle_each_step_run_once_even_when_an_item_hook_commits"  # 79자(test_4228 실제 이름)
    tag = conftest_module._global_engine_test_tag("f00d42", long_name, "_logged")
    assert len(tag.encode("utf-8")) <= 63, tag
    assert tag.startswith("ge|f00d42|test_overlapping_crons"), tag
    korean = conftest_module._global_engine_test_tag("f00d42", "테스트_" * 30, "t")
    assert len(korean.encode("utf-8")) <= 63 and "\ufffd" not in korean, korean
    short = conftest_module._global_engine_test_tag("f00d42", "test_short", "_logged")
    assert short == "ge|f00d42|test_short|_logged", short


@pytest.mark.anyio
async def test_global_engine_connections_carry_the_current_destructive_test_name(request):
    """C: destructive 테스트 안에서 전역 엔진이 준 커넥션의 application_name = `ge|<nodeid 해시>|<함수 이름>|<태스크>` ·
    해시로 이 테스트의 전체 nodeid를 되찾는다.
    뮤테이션: conftest의 checkout 태깅을 빼면 app 이름이 `db_application_name()` 그대로 — RED."""
    from app.core.database import async_session_factory
    from app.core.database import engine as global_engine

    try:
        async with async_session_factory() as db:
            name = (await db.execute(text("SELECT current_setting('application_name')"))).scalar_one()
        assert name.startswith(conftest_module.GLOBAL_ENGINE_TEST_TAG_PREFIX), name
        assert conftest_module._resolve_global_engine_test_tag(name) == request.node.nodeid, name
        assert f"|{request.node.name}"[:20] in name, name
    finally:
        await global_engine.dispose()
