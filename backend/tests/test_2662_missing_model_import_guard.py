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
    잣대"(sys.modules/Base.metadata)와 "스캔 행위"가 서로 안 섞인다는 설계 전제 확인."""
    import sys
    from tests.conftest import _build_tablename_to_module_registry

    assert "app.models.activity_log" not in sys.modules
    _build_tablename_to_module_registry()
    assert "app.models.activity_log" not in sys.modules, (
        "스캔이 실제로 모듈을 import했다 — 정적 스캔이어야 한다는 설계가 깨짐"
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


@pytest.mark.skipif(
    __import__("os").getenv("PARITY_TEST_DATABASE_URL") is None
    and __import__("os").getenv("ALEMBIC_DATABASE_URL") is None,
    reason="양성대조는 실 create_all 실패를 내야 하므로 실 Postgres 필요",
)
def test_ac2_positive_control_missing_import_gets_diagnosed(pytester: pytest.Pytester):
    """⭐AC2 핵심 — PR #3067 21파일 사례의 최소 재현. `import app.models.activity_log`가
    빠진 채 transition_gate()류 write를 흉내내는 create_all 테스트를 서브프로세스로 돌려,
    (1) 여전히 실패하고(가드가 실패를 숨기지 않는다) (2) 그 실패 리포트에 이 가드의 진단
    섹션이 실제로 붙는지(원인이 명확한 메시지로 바뀌는지) 둘 다 확인한다."""
    import os
    import shutil
    from pathlib import Path

    # story #2662 훅이 정의된 실 conftest.py를 pytester의 격리 실행 디렉터리로 복사 —
    # pytester 기본 sandbox는 빈 디렉터리라 훅 자체가 없으면 검증 대상이 없다.
    shutil.copy(Path(__file__).parent / "conftest.py", pytester.path / "conftest.py")

    db_url = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
    pytester.makepyfile(
        test_repro=f'''
import os
import uuid
import pytest

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_write_without_activity_log_import():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401 — 벌크 임포트(activity_log는 여기 없음, #2201 후속)

    url = {db_url!r}
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        from app.services.activity_log import ActivityLogService
        await ActivityLogService(s).record(
            org_id=uuid.uuid4(), action="x", actor_id=None, actor_type="human",
        )
        await s.commit()
    await engine.dispose()
'''
    )
    import os as _os
    backend_dir = str((__import__("pathlib").Path(__file__).parent.parent).resolve())
    mp = pytest.MonkeyPatch()
    mp.setenv("PYTHONPATH", backend_dir + _os.pathsep + _os.environ.get("PYTHONPATH", ""))
    try:
        result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-m", "destructive_schema", "-v")
    finally:
        mp.undo()
    result.assert_outcomes(failed=1)  # 가드가 실패 자체를 숨기면 안 된다 — 여전히 RED.
    output = "\\n".join(result.outlines)
    assert "app.models.activity_log" in output, (
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
    try:
        result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-m", "destructive_schema", "-v")
    finally:
        mp.undo()
    result.assert_outcomes(errors=1)  # setup 단계 실패는 pytest에서 "error"로 집계(fail 아님).
    output = "\n".join(result.outlines)
    assert "app.models.activity_log" in output, f"setup 단계 진단 미부착 — output={output!r}"
