"""story #3631 — migration 0350: role_templates.default_tool_groups에 "content" 부여
(growth-hacker·performance-marketer 2종 한정, 0181_role_templates_canvas_group.py와 동형
scoped-UPDATE 패턴 — 0246처럼 전체가 아니다).

검증 축(test_2635_role_templates_events_scope.py 관례 재사용):
- AC1: 대상 2 role만 "content" 부여, 멱등(재실행 시 중복 없음).
- AC2: is_tool_allowed 왕복 — 부여 후 content 그룹 도구가 실제로 열리는지.
- AC3: 대상 밖 role(예: backend)은 오염 0.
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest

pytestmark = pytest.mark.destructive_schema

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0350_role_templates_content_group.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0350", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _run_migration_fn(eng, mig, fn_name: str) -> None:
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    with eng.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            getattr(mig, fn_name)()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_only_target_roles_receive_content_grant_and_idempotent():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()

    try:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS role_templates"))
            c.execute(sa.text(
                "CREATE TABLE role_templates (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, "
                "default_tool_groups text[] NOT NULL DEFAULT '{}')"
            ))
            for slug, groups in (
                ("growth-hacker", "ARRAY['stories','tasks','chat','docs','analytics','hypotheses']"),
                ("performance-marketer", "ARRAY['stories','tasks','chat','docs','analytics','hypotheses']"),
                ("backend", "ARRAY['stories','tasks','canvas']"),
                # 이미 "content"를 가진 행 — 멱등 검증용.
                ("already-has-content", "ARRAY['stories','content']"),
            ):
                c.execute(sa.text(
                    f"INSERT INTO role_templates (id, slug, default_tool_groups) VALUES (:id, :slug, {groups})"
                ), {"id": str(uuid.uuid4()), "slug": slug})

        _run_migration_fn(eng, mig, "upgrade")

        with eng.begin() as c:
            rows = c.execute(sa.text("SELECT slug, default_tool_groups FROM role_templates")).fetchall()
        by_slug = {r[0]: list(r[1]) for r in rows}

        # AC1: 대상 2 role만 부여.
        assert "content" in by_slug["growth-hacker"]
        assert "content" in by_slug["performance-marketer"]
        # AC3: 대상 밖 role은 오염 0.
        assert "content" not in by_slug["backend"]
        assert by_slug["backend"] == ["stories", "tasks", "canvas"]

        # 멱등: 이미 갖고 있던 행은 중복 삽입되지 않는다.
        assert by_slug["already-has-content"].count("content") == 1

        before = {k: list(v) for k, v in by_slug.items()}
        _run_migration_fn(eng, mig, "upgrade")
        with eng.begin() as c:
            rows2 = c.execute(sa.text("SELECT slug, default_tool_groups FROM role_templates")).fetchall()
        after = {r[0]: list(r[1]) for r in rows2}
        assert after == before, "재실행 시 배열이 변해선 안 된다(멱등 위반)"

        # downgrade — 대상 2 role만 걷힌다.
        _run_migration_fn(eng, mig, "downgrade")
        with eng.begin() as c:
            rows3 = c.execute(sa.text("SELECT slug, default_tool_groups FROM role_templates")).fetchall()
        after_down = {r[0]: list(r[1]) for r in rows3}
        assert "content" not in after_down["growth-hacker"]
        assert "content" not in after_down["performance-marketer"]
        # downgrade가 content 아닌 기존 그룹은 안 건드렸는지도 확인.
        assert "stories" in after_down["growth-hacker"]
        assert "analytics" in after_down["performance-marketer"]
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS role_templates"))
        eng.dispose()


def test_is_tool_allowed_roundtrip_after_grant():
    """AC2 — 그룹 문자열만 박고 끝내지 않는다: 부여된 default_tool_groups로 실제
    content 그룹 도구가 True로 왕복되는지 직접 확인(synthetic 이름 — story #3631의
    실 등록 도구는 story #3614/#3972 머지 시점에 달림, 키워드 매칭 자체는 독립적으로
    검증 가능)."""
    from app.services.mcp_toolset import is_tool_allowed

    granted_groups = ["stories", "tasks", "chat", "content"]
    assert is_tool_allowed("sprintable_withdraw_channel_post_draft", granted_groups) is True

    ungranted_groups = ["stories", "tasks", "chat"]
    assert is_tool_allowed("sprintable_withdraw_channel_post_draft", ungranted_groups) is False
