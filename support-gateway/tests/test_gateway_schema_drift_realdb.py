"""story #3285(지원v1·후속, 2026-09-01) — gateway 스위트가 SQLite 인메모리(conftest.py의
`Base.metadata.create_all()`)라 실 Postgres 마이그레이션 제약(CHECK/FK)과의 드리프트를
구조적으로 못 잡는 클래스. 실증: story #3672가 `role="operator"`를 코드로만 허용하고
`ck_support_messages_role`(migration 0001, 'customer'|'agent'|'system'만) 확장을 안 해
dev PG서 IntegrityError 500(#3279 실왕복) — SQLite는 이 제약 자체를 모델에서 안 봐서
어떤 테스트도 이걸 못 잡았다.

이 파일은 disposable Postgres(CI: gateway-test 잡의 postgres 서비스, 로컬: GATEWAY_REALDB_URL
설정 시)에 실 alembic 마이그레이션을 태워 두 층으로 검증한다:

① `compare_metadata()` — 테이블·컬럼·인덱스·FK·제약 유무(add/remove)류 구조 드리프트 일반
   봉쇄. 로컬 실측(2026-09-01, postgres@16) — 모델에서 제약을 통째로 빼면 diff 1건 정확히
   뜬다.
② ①의 사각(로컬 실측으로 직접 확認) — **같은 이름의 제약인데 조건식(허용 값 목록)만 바뀐
   경우는 `compare_metadata()`가 diff=0으로 못 잡는다**(Postgres가 `IN (...)`을
   `= ANY(ARRAY[...])`로 canonicalize해 텍스트 비교도 못 씀). 이 사각을 별도 삽입 프로브로
   보완 — `app.models.ALLOWED_ROLES`(모델 상수, 이 테스트에 별도 하드코딩하지 않음 — PO
   확定: 새 role이 그 상수에 추가되는 순간 이 프로브가 자동으로 그 값을 실제 INSERT해
   마이그레이션 누락을 구조적으로 잡는다)를 순회하며 실 제약을 통과하는지 확認한다.

⚠️2026-09-01 시점 — migration 0004(story #3279 핫픽스, PR#3678)가 아직 develop에 없어
ALLOWED_ROLES('operator' 포함)와 실 배포 제약(0001, 3개 값)이 불일치한다. 이 파일의 ②는
그래서 **지금 시점 의도적으로 RED**(정확히 이 사고를 재현·증명) — #3678 머지 전까지 이 PR은
머지 보류(PO 확定 사슬)."""
from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import ALLOWED_ROLES, Base, SupportConversation, SupportMessage, SupportSession

_ENV_VAR = "GATEWAY_REALDB_URL"
_ROOT = Path(__file__).parent.parent

pytestmark = pytest.mark.skipif(
    _ENV_VAR not in os.environ,
    reason=f"{_ENV_VAR} 미설정 — disposable Postgres 필요(CI gateway-test 잡은 항상 설정, 로컬은 선택 실행).",
)


def _sync_url() -> str:
    return os.environ[_ENV_VAR]


def _async_url() -> str:
    url = _sync_url()
    if "+asyncpg" in url:
        return url
    return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )


@pytest.fixture(scope="module")
def migrated_engine():
    env = {**os.environ, "SUPPORT_GATEWAY_DATABASE_URL": _async_url()}
    subprocess.run(["uv", "run", "alembic", "upgrade", "head"], cwd=_ROOT, env=env, check=True)
    engine = create_engine(_sync_url())
    try:
        yield engine
    finally:
        engine.dispose()
        subprocess.run(["uv", "run", "alembic", "downgrade", "base"], cwd=_ROOT, env=env, check=True)


def test_model_metadata_matches_migrated_schema_no_structural_drift(migrated_engine):
    """① add/remove류 구조 드리프트(테이블·컬럼·인덱스·FK·제약 유무) 일반 봉쇄."""
    with migrated_engine.connect() as conn:
        ctx = MigrationContext.configure(conn)
        diff = compare_metadata(ctx, Base.metadata)
    assert diff == [], f"모델↔실 마이그레이션 스키마 드리프트: {diff}"


def test_every_allowed_role_actually_persists_against_real_constraint(migrated_engine):
    """② ①의 사각(같은 이름·조건 변경) 보완 pin. ALLOWED_ROLES를 그대로 순회 —
    이 테스트 자체는 role 목록을 하드코딩하지 않는다(PO 확定, app/models.py 주석 참고)."""
    with Session(migrated_engine) as session:
        sess_row = SupportSession(org_id=uuid.uuid4(), external_user_id=uuid.uuid4())
        session.add(sess_row)
        session.flush()
        conv = SupportConversation(org_id=sess_row.org_id, session_id=sess_row.id)
        session.add(conv)
        session.flush()

        failed_roles: list[str] = []
        for role in ALLOWED_ROLES:
            try:
                with session.begin_nested():
                    session.add(
                        SupportMessage(
                            conversation_id=conv.id, org_id=sess_row.org_id, role=role, content="probe"
                        )
                    )
                    session.flush()
            except IntegrityError:
                failed_roles.append(role)

        session.rollback()

    assert failed_roles == [], (
        f"ALLOWED_ROLES에 있는 값이 실 CHECK 제약(ck_support_messages_role)을 못 넘었습니다: "
        f"{failed_roles} — 마이그레이션이 이 값을 반영 못 했다는 뜻(모델이 코드보다 먼저 넓어짐)."
    )
