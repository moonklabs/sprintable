"""story #2662 — create_all() 격리 테스트의 "model 미등재" 실패가 명확한 원인 메시지로
잡히는지 검증(conftest.py의 pytest_runtest_makereport 훅 + 테이블명 레지스트리).

PR #3067(#2631) 실측: 이 클래스가 한 PR 안에서 세 라운드 재발(21파일 수기 임포트) — 실패
메시지(`relation "X" does not exist`)가 원인(모델 미등재)을 안 가리켜서 매번 사람이 직접
grep으로 추적해야 했다. 처방 후보 ⓐ(conftest 벌크 임포트)는 #2201 실측(25분 CI 타임아웃)으로
기각됐고, 이 파일은 채택된 ⓑ(실행 시점 진단 가드)를 검증한다.
"""
from __future__ import annotations

import ast

import pytest


# ─── 단위 축 — 레지스트리 빌더 + 진단 함수(순수 함수, DB 불요) ────────────────────


def test_registry_maps_known_tables_to_their_module():
    """PR #3067에서 실제로 놓쳤던 테이블(activity_logs)이 정확한 모듈로 매핑되는지 —
    이 스토리의 존재 이유가 된 그 사례 자체를 양성대조로 고정."""
    from tests.conftest import _build_tablename_to_module_registry

    registry = _build_tablename_to_module_registry()
    assert registry["activity_logs"] == "app.models.activity_log"
    assert registry["gate"] == "app.models.gate"
    # 파일당 모델 여러 개(예: doc.py가 Doc·DocSlugAlias 등 5개 __tablename__)도 전부 잡힌다.
    assert registry["docs"] == "app.models.doc"


def test_registry_scan_is_side_effect_free_no_model_imported():
    """AST 정적 스캔이라 스캔 자체가 어떤 모델도 import하지 않는다 — "등재 여부를 재는
    잣대"(sys.modules/Base.metadata)와 "스캔 행위"가 서로 안 섞인다는 설계 전제 확인.

    PO 리뷰(2026-08-15) 지적 — "app.models.activity_log ∉ sys.modules" 전역 절대 단언은
    풀스위트 실행 순서에 취약하다(다른 테스트가 그 모듈을 이미 정당하게 import해뒀으면 이
    단언 자체가 깨진다 — 이 테스트가 검증하려는 것과 무관한 이유로). 스캔 «전/후 델타»로
    바꿔 순서 무관하게 만든다 — 확인 대상은 "이미 import돼 있었나"가 아니라 "이 스캔 호출이
    «새로» import를 만들었나"뿐이다."""
    import sys
    from tests.conftest import _build_tablename_to_module_registry

    before = set(sys.modules)
    _build_tablename_to_module_registry()
    newly_imported = set(sys.modules) - before
    assert not newly_imported, (
        f"스캔이 실제로 모듈을 import했다 — 정적 스캔이어야 한다는 설계가 깨짐: {newly_imported}"
    )


def test_diagnose_matches_known_missing_relation_error():
    from tests.conftest import _diagnose_missing_relation_error

    exc = Exception('relation "activity_logs" does not exist')
    diagnosis = _diagnose_missing_relation_error(exc)
    assert diagnosis is not None
    assert "app.models.activity_log" in diagnosis
    assert "임포트" in diagnosis


def test_diagnose_walks_cause_chain():
    """실제 asyncpg 에러는 흔히 SQLAlchemy 래퍼 예외의 __cause__로 들어 있다 — 최상위
    예외 메시지 자체엔 "relation ... does not exist"가 없어도 체인을 타고 들어가 찾는다."""
    from tests.conftest import _diagnose_missing_relation_error

    inner = Exception('UndefinedTableError: relation "gate" does not exist')
    outer = Exception("sqlalchemy.exc.ProgrammingError: (raised as a result of Query-invoked autoflush)")
    outer.__cause__ = inner
    diagnosis = _diagnose_missing_relation_error(outer)
    assert diagnosis is not None
    assert "app.models.gate" in diagnosis


def test_diagnose_returns_none_for_unrelated_failure():
    """음성대조 — "relation ... does not exist" 패턴 자체가 없는 실패(예: AssertionError)는
    이 가드가 아무것도 안 붙인다(오탐 0)."""
    from tests.conftest import _diagnose_missing_relation_error

    assert _diagnose_missing_relation_error(AssertionError("expected 1 got 2")) is None


def test_diagnose_returns_none_for_unregistered_table_name():
    """음성대조 — 레지스트리에 없는 테이블명(오타·다른 원인)이면 진단을 지어내지 않는다
    (모르면 조용히 원래 실패 그대로 — 틀린 진단을 붙이는 것보다 안전)."""
    from tests.conftest import _diagnose_missing_relation_error

    assert _diagnose_missing_relation_error(
        Exception('relation "this_table_definitely_does_not_exist_xyz" does not exist')
    ) is None


# ─── 실행 축(AC2 양성대조) — pytester로 실 pytest 서브프로세스를 돌려 훅이 진짜로
#     리포트에 진단을 붙이는지 확인. DRY_RUN이 아니라 21파일 사례의 실제 실패 형태를
#     최소 재현한다: model 미등재로 create_all()이 실패하는 destructive_schema 테스트. ──


def _replace_dbname(url: str, new_name: str) -> str:
    base, _, tail = url.rpartition("/")
    query = ""
    if "?" in tail:
        _, _, query = tail.partition("?")
        query = "?" + query
    return f"{base}/{new_name}{query}"


def _admin_url(base_url: str) -> str:
    """CREATE/DROP DATABASE는 자기 자신에 붙은 채로는 못 하므로 관리용 DB(postgres)로 붙는다."""
    from tests.conftest import _sync_url

    return _replace_dbname(_sync_url(base_url), "postgres")


def _create_disposable_pg_database(base_url: str) -> tuple[str, str]:
    """PR#3088 QA CRITICAL(까디르, 2026-08-15) 재발방지 — pytester 서브프로세스에 복사된
    conftest.py의 autouse `_reset_schema_for_destructive_tests`가, 서브프로세스가 «상속»한
    PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL을 그대로 읽어 CI의 공유 sprintable_test DB에
    DROP SCHEMA public CASCADE를 실행 — alembic_version·기초테이블 전멸로 906건 연쇄실패를
    냈다(로컬 재현으로 실증됨). 서브프로세스가 그 공유 DB를 아예 못 보게, 이 양성대조 전용
    throwaway DB를 새로 만들어 그 URL로만 동작하게 강제한다."""
    import uuid

    from sqlalchemy import create_engine, text

    db_name = f"sprintable_test_ac2_{uuid.uuid4().hex[:8]}"
    engine = create_engine(_admin_url(base_url), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    finally:
        engine.dispose()
    return _replace_dbname(base_url, db_name), db_name


def _drop_disposable_pg_database(base_url: str, db_name: str) -> None:
    from sqlalchemy import create_engine, text

    engine = create_engine(_admin_url(base_url), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    except Exception:
        pass  # cleanup 실패는 비치명적 — CI 잡 컨테이너 자체가 곧 폐기된다.
    finally:
        engine.dispose()


@pytest.mark.skipif(
    __import__("os").getenv("PARITY_TEST_DATABASE_URL") is None
    and __import__("os").getenv("ALEMBIC_DATABASE_URL") is None,
    reason="양성대조는 실 create_all 실패를 내야 하므로 실 Postgres 필요",
)
def test_ac2_positive_control_missing_import_gets_diagnosed(pytester: pytest.Pytester):
    """⭐AC2 핵심 — PR #3067 21파일 사례의 최소 재현. `import app.models.activity_log`가
    빠진 채 transition_gate()류 write를 흉내내는 create_all 테스트를 서브프로세스로 돌려,
    (1) 여전히 실패하고(가드가 실패를 숨기지 않는다) (2) 그 실패 리포트에 이 가드의 진단
    섹션이 실제로 붙는지(원인이 명확한 메시지로 바뀌는지) 둘 다 확인한다.

    PR#3700(story #2255) 리뷰(페드루, 2026-09-02) — 이 표본은 원래 실 운영 모델
    `app.models.activity_log`를 빌려 썼는데, 그 모델이 #2255에서 실제로 `__init__.py`에
    등재되면서 표본의 전제("app.models 벌크 import에 없다")가 깨져 이 테스트가 거짓
    GREEN(failed=0)으로 무너졌다. 운영 모델이 아니라 `app/models/_test_only_unregistered_fixture.py`
    (영구 미등재로 설계된 테스트 전용 모델, `lint_model_registration_completeness.py`의
    `_INTENTIONALLY_UNREGISTERED` 허용목록으로 AC6 가드에서도 제외됨)를 대상으로 바꿔,
    앞으로 어떤 운영 모델이 등재되든 이 양성대조는 계속 실패할 수 있다."""
    import os
    import shutil
    from pathlib import Path

    # story #2662 훅이 정의된 실 conftest.py를 pytester의 격리 실행 디렉터리로 복사 —
    # pytester 기본 sandbox는 빈 디렉터리라 훅 자체가 없으면 검증 대상이 없다.
    shutil.copy(Path(__file__).parent / "conftest.py", pytester.path / "conftest.py")

    base_db_url = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
    disposable_url, disposable_name = _create_disposable_pg_database(base_db_url)
    pytester.makepyfile(
        test_repro=f'''
import pytest

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_write_without_fixture_import():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401 — 벌크 임포트(story #2662 AC2 픽스처는 영구 미등재라 여기 없음)

    url = {disposable_url!r}
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # story #2662 AC2 픽스처 모듈을 이 프로세스가 절대 import 안 하므로 그 테이블은
        # Base.metadata에 없다 — create_all()이 만들 수 없는 테이블 이름을 직접 참조해
        # PR #3067 21파일 사례(모델 미등재 → relation ... does not exist)를 재현.
        await conn.execute(
            text(
                "INSERT INTO test_2662_ac2_positive_control (id) "
                "VALUES ('00000000-0000-0000-0000-000000000000'::uuid)"
            )
        )
    await engine.dispose()
'''
    )
    import os as _os
    backend_dir = str((__import__("pathlib").Path(__file__).parent.parent).resolve())
    mp = pytest.MonkeyPatch()
    mp.setenv("PYTHONPATH", backend_dir + _os.pathsep + _os.environ.get("PYTHONPATH", ""))
    # ⛔PR#3088 QA CRITICAL(까디르) — 복사된 conftest.py의 autouse 리셋 픽스처가 «상속받은»
    # 실 DB URL을 그대로 읽는다. 서브프로세스가 그 두 변수를 무조건 위 disposable_url(이
    # 양성대조 전용 throwaway DB)로만 보게 강제 — 진짜 CI 공유 DB는 이 서브프로세스 시야에
    # 아예 없어야 한다(상속 금지).
    mp.setenv("PARITY_TEST_DATABASE_URL", disposable_url)
    mp.setenv("ALEMBIC_DATABASE_URL", disposable_url)
    try:
        result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-m", "destructive_schema", "-v")
    finally:
        mp.undo()
        _drop_disposable_pg_database(base_db_url, disposable_name)
    result.assert_outcomes(failed=1)  # 가드가 실패 자체를 숨기면 안 된다 — 여전히 RED.
    output = "\\n".join(result.outlines)
    assert "app.models._test_only_unregistered_fixture" in output, (
        f"진단 섹션이 리포트에 안 실렸다 — 21파일 사례가 재현 안 됨.\\noutput={output!r}"
    )
    assert "story #2662" in output


def test_setup_phase_failure_also_gets_diagnosed(pytester: pytest.Pytester):
    """PO AC 리뷰(2026-08-15) 비블로커 권고 반영 — 21파일 사례의 지배 패턴은 call 단계
    실패(평 async 헬퍼를 테스트 본문에서 await)지만, `@pytest.fixture`로 감싼 create_all
    헬퍼를 쓰는 미래 테스트는 실패가 setup 단계로 떨어진다. DB 없이(가짜 예외로) 그 축도
    실제로 커버되는지 확인 — call 단계 검증(pytester 서브프로세스, 실 PG 필요)과 별개로
    빠르게 도는 회귀가드."""
    import shutil
    from pathlib import Path

    shutil.copy(Path(__file__).parent / "conftest.py", pytester.path / "conftest.py")

    pytester.makepyfile(
        test_repro_setup='''
import pytest

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def broken_create_all_session():
    raise Exception('relation "activity_logs" does not exist')


def test_uses_broken_fixture(broken_create_all_session):
    pass
'''
    )
    import os

    backend_dir = str(Path(__file__).parent.parent.resolve())
    mp = pytest.MonkeyPatch()
    mp.setenv("PYTHONPATH", backend_dir + os.pathsep + os.environ.get("PYTHONPATH", ""))
    # ⛔PR#3088 QA CRITICAL(까디르, 2026-08-15) — 이 테스트는 DB가 전혀 필요 없다(가짜
    # 예외로 setup 실패를 재현). 그런데 복사된 conftest.py의 autouse 리셋 픽스처는
    # destructive_schema 마커만 보고 발동하므로, 서브프로세스가 «상속받은» 실 DB URL이
    # 있으면 CI의 공유 sprintable_test DB에 DROP SCHEMA를 실행해버린다(로컬 재현으로
    # 실증 — alembic_version 전멸·906건 연쇄실패). 빈 문자열로 명시 오버라이드해 그
    # 리셋을 완전히 무력화한다(url이 falsy → conftest.py의 `if url:` 가드가 no-op).
    mp.setenv("PARITY_TEST_DATABASE_URL", "")
    mp.setenv("ALEMBIC_DATABASE_URL", "")
    try:
        result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-m", "destructive_schema", "-v")
    finally:
        mp.undo()
    result.assert_outcomes(errors=1)  # setup 단계 실패는 pytest에서 "error"로 집계(fail 아님).
    output = "\n".join(result.outlines)
    assert "app.models.activity_log" in output, f"setup 단계 진단 미부착 — output={output!r}"
