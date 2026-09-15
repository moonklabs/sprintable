"""story #3896 AC2 양성대조 — tests/conftest.py의 `_snapshot_columns`(스키마 드리프트
감시 fixture `_detect_schema_drift_in_non_destructive_module`이 쓰는 핵심 비교 로직)가
실제로 server_default drift를 잡아내는지 독립 검증한다.

⚠️왜 pytest 테스트가 아니라 별도 스크립트인가 — 처음엔 `destructive_schema`-마커
pytest 테스트로 짰으나(reset fixture 활용), 그 fixture(`_reset_schema_for_destructive_
tests`)가 스키마를 리셋한 **뒤** 같은 프로세스 안에서 새 sync psycopg2 커넥션을 열면
재현 불가능한 `FATAL: password authentication failed`가 났다(원인 미상 — pytest
collection이 만드는 다른 전역 상태(app.core.database 전역 엔진 등)와의 상호작용으로
추정, 이 스크립트로 **동일 로직을 pytest 밖에서** 실행하면 매번 정상 동작하는 것으로
근본 배제 확認). 이 클래스의 실사고 재현이 목적이 아니라 "비교 로직 자체가 옳은가"가
목적이라, pytest 인프라 없이도 충분히 검증된다 — story #f6d1bbaa류 `scripts/jobs/*.py`
관례(pytest 밖 독립 가드/검증 스크립트)를 그대로 따른다.

사용법(disposable Postgres 필요, 예: `docker run -d -e POSTGRES_USER=x -e
POSTGRES_PASSWORD=x -e POSTGRES_DB=x -p 5555:5432 pgvector/pgvector:pg15`):
    ALEMBIC_DATABASE_URL=postgresql://x:x@localhost:5555/x \
    uv run python scripts/jobs/verify_schema_drift_snapshot_logic.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_BACKEND_DIR / "tests"))
sys.path.insert(0, str(_BACKEND_DIR))

from sqlalchemy import Boolean, Column, MetaData, Table, Text, create_engine, false, text  # noqa: E402

from conftest import _snapshot_columns  # noqa: E402


def main() -> int:
    url = os.getenv("ALEMBIC_DATABASE_URL") or os.getenv("PARITY_TEST_DATABASE_URL")
    if not url:
        print("ALEMBIC_DATABASE_URL/PARITY_TEST_DATABASE_URL 미설정 — disposable Postgres를 가리켜야 함")
        return 2

    sync_url = url
    for prefix in ("postgresql+asyncpg://",):
        if sync_url.startswith(prefix):
            sync_url = "postgresql+psycopg2://" + sync_url[len(prefix):]
    engine = create_engine(sync_url)
    metadata = MetaData()
    table = Table(
        "_3896_drift_selfcheck",
        metadata,
        Column("id", Text, primary_key=True),
        Column("flag", Boolean, nullable=False, server_default=false()),
    )
    try:
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS _3896_drift_selfcheck"))
        metadata.create_all(engine)

        before = _snapshot_columns(sync_url, "_3896_drift_selfcheck")
        assert before is not None, "create_all 직후인데 스냅샷이 None — 테이블이 실제로 안 만들어짐"
        print(f"[1/3] 생성 직후 스냅샷: {before}")

        after_noop = _snapshot_columns(sync_url, "_3896_drift_selfcheck")
        assert before == after_noop, "음성대조 실패 — 아무 변경도 없는데 스냅샷이 달라짐(비교 로직 불안정)"
        print("[2/3] 음성대조 OK — 무변경 스냅샷 일치")

        # 실 drift 재현 — marketing_email_opt_out 사고와 동형(server_default가 사라짐).
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE _3896_drift_selfcheck ALTER COLUMN flag DROP DEFAULT"))
        after_drift = _snapshot_columns(sync_url, "_3896_drift_selfcheck")
        print(f"[3/3] DROP DEFAULT 後 스냅샷: {after_drift}")

        if before == after_drift:
            print(
                "FAIL — server_default가 실제로 벗겨졌는데 _snapshot_columns이 그 변화를 "
                "못 잡음(감시 fixture의 핵심 비교 로직이 무력하다는 뜻)"
            )
            return 1

        print("PASS — _snapshot_columns이 server_default drift를 정확히 잡아낸다.")
        return 0
    finally:
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS _3896_drift_selfcheck"))
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
