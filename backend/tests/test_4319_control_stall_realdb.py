"""story #4319 AC6 양성대조 — 일부러 멈추는 테스트. 병합 전에 뺀다(버리는 draft PR #4693 전용).

첫 판(비동기 대기)은 pytest-timeout(signal · 210초)이 끊어 8분 정지 감지까지 안 갔다 — 실제 STALL 두 건은 그 타임아웃이 못 끊는 자리다.
그래서 이 판은 **동기 psycopg2 DDL이 다른 연결의 잠금을 기다리게** 한다: libpq 호출 안에 묶인 주 스레드는 파이썬으로 안 돌아와
SIGALRM 처리기가 못 돌고(pytest-timeout 무력), 8분 정지 감지가 증거를 남기고 죽이는 경로를 탄다(첫 STALL — conftest의 동기
DROP SCHEMA · create_all 중 멈춤 — 과 같은 부류)."""
import os

import pytest
import sqlalchemy as sa

_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = [pytest.mark.destructive_schema, pytest.mark.skipif(not _URL, reason="real PG")]


def test_control_sync_ddl_waits_on_a_lock_held_by_another_connection():
    engine = sa.create_engine(_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://"))
    with engine.begin() as c:
        c.execute(sa.text("CREATE TABLE IF NOT EXISTS stall_control_4319 (id int)"))
    hold = engine.connect()
    tx = hold.begin()
    hold.execute(sa.text("LOCK TABLE stall_control_4319 IN ACCESS EXCLUSIVE MODE"))  # 쥐고 놓지 않는다
    with engine.begin() as waiter:
        waiter.execute(sa.text("ALTER TABLE stall_control_4319 ADD COLUMN extra int"))  # libpq 안에서 멈춘다
    tx.rollback()
