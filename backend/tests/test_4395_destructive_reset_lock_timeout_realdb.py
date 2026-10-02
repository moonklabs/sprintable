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
    tag = conftest_module._global_engine_test_tag("f00d42", long_name, "_route_dispatch_bg")
    assert len(tag.encode("utf-8")) <= 63, tag
    # 태스크가 함수보다 앞 — 긴 함수 이름에 잘려도 태스크는 온전히 보인다(첫 CI 표본에서 태스크가 잘려 안 보였음).
    assert tag.startswith("ge|f00d42|_route_dispatch_bg|test_overlapping_crons"), tag
    korean = conftest_module._global_engine_test_tag("f00d42", "테스트_" * 30, "t")
    assert len(korean.encode("utf-8")) <= 63 and "\ufffd" not in korean, korean
    short = conftest_module._global_engine_test_tag("f00d42", "test_short", "_logged")
    assert short == "ge|f00d42|_logged|test_short", short


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
        parts = name.split("|")  # ge|해시|태스크|함수 — 함수는 63바이트에서 잘려 빠질 수 있어도 해시로 되살아난다(위 단언)
        assert len(parts) >= 3 and parts[2], name
    finally:
        await global_engine.dispose()


# ── story #4395: conftest drain(배경 작업) → dispose ──

async def _idle_in_tx_tagged() -> int:
    from sqlalchemy import create_engine as _ce

    eng = _ce(conftest_module._sync_url(_REAL_DB_URL))
    try:
        with eng.connect() as conn:
            return conn.execute(text(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                "AND state = 'idle in transaction' AND starts_with(application_name, :tag)"
            ), {"tag": conftest_module.GLOBAL_ENGINE_TEST_TAG_PREFIX}).scalar_one()
    finally:
        eng.dispose()


@pytest.mark.anyio
async def test_anyio_destructive_tests_drain_inside_the_test_loop_not_as_a_fixture(request):
    """anyio 테스트는 drain을 테스트 코루틴의 마지막 단계로(같은 루프) — pytest-asyncio fixture로 주입하면 다른 루프를 본다(CI run
    36947226511 shard 8). 뮤테이션: anyio 갈래를 fixture 주입으로 되돌리면 RED."""
    assert getattr(request.node.obj, conftest_module.TEST_LOOP_DRAIN_MARK, False) is True
    assert "_drain_and_dispose_global_engine_for_destructive_tests" not in request.fixturenames


@pytest.mark.anyio
async def test_drain_fails_naming_a_background_task_stuck_inside_a_transaction():
    """양성 대조: 전역 엔진 세션에서 SELECT 뒤 트랜잭션을 연 채 멈춘 배경 작업(CI 표본의 모양)을 일부러 남긴다 → drain은 상한에서
    **삼키지 않고** 그 작업 이름으로 실패하고, 작업을 취소해 트랜잭션을 닫는다(idle in transaction 0).
    뮤테이션: conftest 주입을 빼면 이 작업은 테스트 뒤에도 남아 다음 테스트 리셋이 lock_timeout 이름 RED로 멈춘다."""
    import asyncio

    from app.core.database import async_session_factory
    from app.services.pg_pubsub import fire_and_forget

    started, never = asyncio.Event(), asyncio.Event()

    async def _stuck_dispatch_4395():
        async with async_session_factory() as db:
            await db.execute(text("SELECT 1"))
            started.set()
            await never.wait()

    fire_and_forget(_stuck_dispatch_4395())
    await asyncio.wait_for(started.wait(), timeout=10)
    assert await _idle_in_tx_tagged() == 1
    with pytest.raises(pytest.fail.Exception, match="_stuck_dispatch_4395"):
        await conftest_module.drain_global_background_work(timeout=0.5)
    assert await _idle_in_tx_tagged() == 0


@pytest.mark.anyio
async def test_drain_waits_for_a_slow_but_finishing_task():
    """음성 대조: 늦게라도 끝나는 배경 작업은 기다렸다 통과(실패 없음)."""
    import asyncio

    from app.core.database import async_session_factory
    from app.services.pg_pubsub import fire_and_forget

    async def _slow_4395():
        async with async_session_factory() as db:
            await db.execute(text("SELECT 1"))
            await asyncio.sleep(0.2)

    fire_and_forget(_slow_4395())
    await conftest_module.drain_global_background_work(timeout=5)
    assert await _idle_in_tx_tagged() == 0


# ── story #4395 (PO 09-30): 테스트가 끝날 때 idle in transaction이 남으면 **그 테스트가** 실패 ──

def _open_idle_in_transaction(app_name: str):
    """다른 세션: 트랜잭션을 열고 읽은 뒤 쉰다(CI 표본의 모양). 돌려준 연결을 닫을 때까지 idle in transaction."""
    eng = create_engine(conftest_module._sync_url(_REAL_DB_URL), connect_args={"application_name": app_name})
    conn = eng.connect()
    conn.execute(text("SELECT 1"))  # autobegin — 커밋 · 롤백 없이 둔다
    return eng, conn


def _alive(pid: int) -> bool:
    eng = create_engine(conftest_module._sync_url(_REAL_DB_URL))
    try:
        with eng.connect() as c:
            return c.execute(text("SELECT count(*) FROM pg_stat_activity WHERE pid = :p"), {"p": pid}).scalar_one() == 1
    finally:
        eng.dispose()


def test_idle_in_transaction_left_at_the_end_fails_naming_it_and_is_ended():
    """양성 대조: 쉬는 트랜잭션이 남으면 앱 이름을 싣고 실패하고, 그 세션을 끊는다(다음 테스트 리셋으로 번지지 않게).
    뮤테이션: 끊기를 빼면 마지막 단언이 RED · 실패를 빼면 raises가 RED."""
    eng, conn = _open_idle_in_transaction("story4395-idle")
    pid = conn.execute(text("SELECT pg_backend_pid()")).scalar_one()
    try:
        with pytest.raises(pytest.fail.Exception, match=r"(?s)tests/x\.py::t.*story4395-idle.*state=idle in transaction"):
            conftest_module.check_no_idle_in_transaction(_REAL_DB_URL, "tests/x.py::t", grace=0.3)
        assert not _alive(pid)
    finally:
        conn.invalidate()
        eng.dispose()


def test_a_transaction_that_ends_within_the_grace_is_not_blamed():
    """음성 대조: 커밋이 막 오가는 세션(곧 끝나는 트랜잭션)은 범인이 아니다. 뮤테이션: 다시 보기(grace)를 빼면 RED."""
    eng, conn = _open_idle_in_transaction("story4395-finishing")
    timer = threading.Timer(0.3, conn.rollback)
    timer.start()
    try:
        conftest_module.check_no_idle_in_transaction(_REAL_DB_URL, "tests/x.py::t", grace=3.0)
    finally:
        timer.join()
        conn.close()
        eng.dispose()


@pytest.mark.anyio
async def test_the_idle_check_runs_after_the_drain(request):
    """순서: 배경 작업 drain(테스트 코루틴 끝 · 같은 루프) → idle 검사(autouse fixture의 teardown — 테스트가 다 끝난 뒤).
    뮤테이션: autouse를 떼면 RED."""
    assert "_no_idle_in_transaction_after_destructive_test" in request.fixturenames
    assert getattr(request.node.obj, conftest_module.TEST_LOOP_DRAIN_MARK, False) is True


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
def test_end_to_end_the_leaking_test_fails_and_the_next_one_is_not_blocked(pytester: pytest.Pytester):
    """실 pytest 서브프로세스(실 conftest · 버리는 DB): 앞 테스트가 sync · async 둘 다 쉬는 트랜잭션을 남긴다 → **그 테스트**가
    이름과 함께 실패하고, 다음 테스트는 리셋이 막히지 않아 통과한다. 이 가드 없이는 앞 둘은 통과, 다음 테스트가 리셋에서
    lock_timeout(30s)으로 실패했다(엉뚱한 테스트를 가리킴)."""
    import shutil
    from pathlib import Path

    from tests.test_2662_missing_model_import_guard import _create_disposable_pg_database, _drop_disposable_pg_database

    shutil.copy(Path(__file__).parent / "conftest.py", pytester.path / "conftest.py")
    url, name = _create_disposable_pg_database(_REAL_DB_URL)
    pytester.makepyfile(
        test_leak_4395='''
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.destructive_schema
_kept = []


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_sync_leaks_an_open_read():
    import os
    from sqlalchemy import create_engine
    from tests.conftest import _sync_url

    eng = create_engine(_sync_url(os.environ["PARITY_TEST_DATABASE_URL"]))
    conn = eng.connect()
    conn.execute(text("SELECT 1"))
    _kept.append((eng, conn))


@pytest.mark.anyio
async def test_async_leaks_an_open_read_on_the_global_engine():
    from app.core.database import async_session_factory

    s = async_session_factory()
    await s.execute(text("SELECT 1"))
    _kept.append(s)


def test_next_runs_after_both():
    pass
'''
    )
    backend_dir = str(Path(__file__).parent.parent.resolve())
    mp = pytest.MonkeyPatch()
    mp.setenv("PYTHONPATH", backend_dir + os.pathsep + os.environ.get("PYTHONPATH", ""))
    mp.setenv("PARITY_TEST_DATABASE_URL", url)
    mp.setenv("ALEMBIC_DATABASE_URL", url)
    mp.setenv("DATABASE_URL", "postgresql+asyncpg://" + conftest_module._sync_url(url).split("://", 1)[1])
    try:
        result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-m", "destructive_schema", "-v", "-p", "no:randomly")
    finally:
        mp.undo()
        _drop_disposable_pg_database(_REAL_DB_URL, name)
    out = "\n".join(result.outlines)
    assert "ERROR at teardown of test_sync_leaks_an_open_read" in out, out
    assert "ERROR at teardown of test_async_leaks_an_open_read_on_the_global_engine" in out, out
    assert "test_next_runs_after_both PASSED" in out, out
    assert "ERROR at setup of test_next_runs_after_both" not in out, out
    result.assert_outcomes(passed=3, errors=2)  # 둘은 call은 통과 · teardown에서 가드가 실패 — 다음 테스트는 통과


_LOOP_PROBE = '''
import asyncio
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.destructive_schema
MARK = Path(os.environ["STORY_4395_MARK"])


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_returns_while_its_background_work_still_runs():
    """after_commit 발행 꼴: 테스트가 띄운 배경 작업(0.3초 뒤 끝남)이 남은 채 테스트가 돌아온다."""
    from app.services.pg_pubsub import fire_and_forget

    async def _publish_like_4395():
        await asyncio.sleep(0.3)
        MARK.write_text("done")

    fire_and_forget(_publish_like_4395())


def test_that_work_finished():
    # 같은 루프의 drain이 기다렸으면 끝났다 · 다른 루프를 봤으면 anyio가 루프를 닫으며 끊었다
    assert MARK.exists()
'''


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
def test_end_to_end_the_drain_sees_the_anyio_test_loop(pytester: pytest.Pytester):
    """회귀(CI run 36947226511 · test_2985): anyio 테스트가 돌아올 때 남은 배경 작업을 drain이 **테스트 루프**에서 끝까지 기다린다
    (그 작업이 남긴 표시를 다음 테스트가 봄). 뮤테이션(양성 대조): anyio 갈래를 pytest-asyncio fixture 주입으로 되돌리면 drain이
    다른 루프를 보고(남은 작업 0) anyio가 루프를 닫으며 그 작업을 끊어 표시가 없음 → RED. (test_2985의 누수 자체 — 첫 연결 초기화
    도중 끊김 — 는 타이밍 경합이라 여기서 결정적으로 못 만든다 · 그 파일 반복 판은 PR 본문.)"""
    import shutil
    from pathlib import Path

    from tests.test_2662_missing_model_import_guard import _create_disposable_pg_database, _drop_disposable_pg_database

    shutil.copy(Path(__file__).parent / "conftest.py", pytester.path / "conftest.py")
    url, name = _create_disposable_pg_database(_REAL_DB_URL)
    # pyproject의 값 그대로 — 이것 없이(strict) 돌리면 주입된 async fixture를 anyio가 맡아 테스트 루프에서 돌아 이 결함이 안 보인다
    pytester.makeini("[pytest]\nasyncio_mode = auto\n")
    pytester.makepyfile(test_loop_probe_4395=_LOOP_PROBE)
    mark = pytester.path / "story4395.mark"
    backend_dir = str(Path(__file__).parent.parent.resolve())
    mp = pytest.MonkeyPatch()
    mp.setenv("PYTHONPATH", backend_dir + os.pathsep + os.environ.get("PYTHONPATH", ""))
    mp.setenv("PARITY_TEST_DATABASE_URL", url)
    mp.setenv("ALEMBIC_DATABASE_URL", url)
    mp.setenv("DATABASE_URL", "postgresql+asyncpg://" + conftest_module._sync_url(url).split("://", 1)[1])
    mp.setenv("STORY_4395_MARK", str(mark))
    try:
        result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-m", "destructive_schema", "-v", "-p", "no:randomly")
    finally:
        mp.undo()
        _drop_disposable_pg_database(_REAL_DB_URL, name)
    result.assert_outcomes(passed=2)


_NON_DESTRUCTIVE_PROBE = '''
import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_dispose_runs_in_this_loop(request):
    import conftest
    assert getattr(request.node.obj, conftest.TEST_LOOP_DISPOSE_MARK, False) is True
    assert "_dispose_global_engine_for_non_destructive_tests" not in request.fixturenames


async def test_asyncio_mode_test_keeps_the_fixture(request):
    assert "_dispose_global_engine_for_non_destructive_tests" in request.fixturenames
'''


def test_non_destructive_anyio_tests_dispose_inside_the_test_loop_too(pytester: pytest.Pytester):
    """같은 부류(3330 dispose fixture): anyio 비파괴 테스트도 dispose를 테스트 루프 안에서 · pytest-asyncio 테스트는 fixture 그대로.
    뮤테이션: 비파괴 anyio 갈래를 fixture 주입으로 되돌리면 RED."""
    import shutil
    from pathlib import Path

    shutil.copy(Path(__file__).parent / "conftest.py", pytester.path / "conftest.py")
    pytester.makeini("[pytest]\nasyncio_mode = auto\n")  # pyproject의 값 그대로 — pytest-asyncio 테스트가 fixture를 받는 모드
    pytester.makepyfile(test_nd_probe_4395=_NON_DESTRUCTIVE_PROBE)
    backend_dir = str(Path(__file__).parent.parent.resolve())
    mp = pytest.MonkeyPatch()
    mp.setenv("PYTHONPATH", backend_dir + os.pathsep + os.environ.get("PYTHONPATH", ""))
    try:
        result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-m", "not destructive_schema", "-v", "-p", "no:randomly")
    finally:
        mp.undo()
    result.assert_outcomes(passed=2)
