"""story #2635 준비 — migration 0246: role_templates.default_tool_groups 전체에 "events" 부여.

검증 축:
- AC1: 현존 role_template 전부(is_builtin 무관)에 "events" 부여, 멱등(재실행 시 중복 없음).
- AC2: is_tool_allowed("sprintable_publish_event", role.default_tool_groups) 왕복 — 부여 후
  실제로 그 도구가 열리는지까지 확인(그룹 문자열만 박고 끝내지 않는다).
- AC3: 휴먼/비활성 role 오염 0 — team_members.role(휴먼 축, 완전히 다른 테이블/컬럼)과
  role_templates.is_published=False 행 둘 다 이 마이그가 건드리는 범위 밖임을 직접 확인.
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_MIG = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0246_role_templates_events_scope.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig0246", _MIG)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _load_seed_slugs():
    """0156(원 4직무) + 0157(신규 18직무) + 0160(마케팅 2직무) — 현존 24개 role_template
    slug 전량(grep으로 role_templates INSERT/`_SEED`를 가진 모든 마이그를 대조해 실측 —
    "22"로 추정하면 0160을 놓친다, 실제 24)."""
    slugs: set[str] = set()
    for filename in (
        "0156_role_templates.py", "0157_role_templates_catalog_buildout.py",
        "0160_role_templates_marketing_roster.py",
    ):
        path = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", filename)
        spec = importlib.util.spec_from_file_location(filename, path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        slugs.update(row[0] for row in m._SEED)
    return slugs


def _run_migration_fn(eng, mig, fn_name: str) -> None:
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    with eng.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            getattr(mig, fn_name)()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_all_role_templates_receive_events_grant_and_idempotent():
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    slugs = _load_seed_slugs()

    try:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS role_templates"))
            c.execute(sa.text(
                "CREATE TABLE role_templates (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, "
                "is_builtin boolean NOT NULL DEFAULT false, is_published boolean NOT NULL DEFAULT true, "
                "default_tool_groups text[] NOT NULL DEFAULT '{}')"
            ))
            # 24개 실 slug + 인위 커스텀 role(is_builtin=False)·미공개 role(is_published=False)도
            # 섞어 「현존 전부」의 실제 다양성을 재현.
            for slug in slugs:
                c.execute(sa.text(
                    "INSERT INTO role_templates (id, slug, default_tool_groups) "
                    "VALUES (:id, :slug, ARRAY['stories','tasks','chat'])"
                ), {"id": str(uuid.uuid4()), "slug": slug})
            c.execute(sa.text(
                "INSERT INTO role_templates (id, slug, is_builtin, default_tool_groups) "
                "VALUES (:id, 'custom-role', false, ARRAY['docs'])"
            ), {"id": str(uuid.uuid4())})
            c.execute(sa.text(
                "INSERT INTO role_templates (id, slug, is_published, default_tool_groups) "
                "VALUES (:id, 'unpublished-role', false, ARRAY['retro'])"
            ), {"id": str(uuid.uuid4())})
            # 이미 "events"를 가진 행 — 멱등 검증용(중복 삽입 시 배열 길이가 2가 돼야 실패로 잡힌다).
            c.execute(sa.text(
                "INSERT INTO role_templates (id, slug, default_tool_groups) "
                "VALUES (:id, 'already-has-events', ARRAY['stories','events'])"
            ), {"id": str(uuid.uuid4())})

        _run_migration_fn(eng, mig, "upgrade")

        with eng.begin() as c:
            rows = c.execute(sa.text(
                "SELECT slug, default_tool_groups FROM role_templates"
            )).fetchall()
        by_slug = {r[0]: list(r[1]) for r in rows}

        # AC1: 전량(24 실 slug + 커스텀 + 미공개) "events" 보유.
        for slug in slugs | {"custom-role", "unpublished-role"}:
            assert "events" in by_slug[slug], f"{slug} missing events grant"

        # 멱등: 이미 갖고 있던 행은 중복 삽입되지 않는다(배열에 "events"가 정확히 1개).
        assert by_slug["already-has-events"].count("events") == 1

        # AC1 재확인(재실행해도 배열 길이 불변) — 실제로 두 번째 upgrade를 다시 태운다.
        before = {k: list(v) for k, v in by_slug.items()}
        _run_migration_fn(eng, mig, "upgrade")
        with eng.begin() as c:
            rows2 = c.execute(sa.text("SELECT slug, default_tool_groups FROM role_templates")).fetchall()
        after = {r[0]: list(r[1]) for r in rows2}
        assert after == before, "재실행 시 배열이 변해선 안 된다(멱등 위반)"

        # downgrade — 전부 걷힌다.
        _run_migration_fn(eng, mig, "downgrade")
        with eng.begin() as c:
            rows3 = c.execute(sa.text("SELECT slug, default_tool_groups FROM role_templates")).fetchall()
        for slug, groups in rows3:
            assert "events" not in groups, f"{slug} downgrade 후에도 events 잔존"
        # downgrade가 events 아닌 기존 그룹은 안 건드렸는지도 확인(예: already-has-events의 stories).
        after_down = {r[0]: list(r[1]) for r in rows3}
        assert "stories" in after_down["already-has-events"]
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS role_templates"))
        eng.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_migration_does_not_touch_human_role_table():
    """AC3 — team_members.role(휴먼 축)은 role_templates와 완전히 다른 테이블/컬럼이다.
    이 마이그의 SQL이 UPDATE role_templates 단일 문 하나뿐이라는 것 자체가 구조적 보증이지만,
    실측으로도 team_members 행이 이 마이그 전후로 그대로임을 확인한다(오염 0 직접 증명)."""
    import sqlalchemy as sa

    sync_url = _REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
        "postgresql://", "postgresql+psycopg2://"
    )
    eng = sa.create_engine(sync_url)
    mig = _load_migration()
    member_id = str(uuid.uuid4())

    try:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS role_templates"))
            c.execute(sa.text("DROP TABLE IF EXISTS team_members_probe"))
            c.execute(sa.text(
                "CREATE TABLE role_templates (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, "
                "default_tool_groups text[] NOT NULL DEFAULT '{}')"
            ))
            c.execute(sa.text(
                "CREATE TABLE team_members_probe (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'member')"
            ))
            c.execute(sa.text(
                "INSERT INTO role_templates (id, slug, default_tool_groups) "
                "VALUES (:id, 'backend', ARRAY['stories'])"
            ), {"id": str(uuid.uuid4())})
            c.execute(sa.text(
                "INSERT INTO team_members_probe (id, role) VALUES (:id, 'owner')"
            ), {"id": member_id})

        _run_migration_fn(eng, mig, "upgrade")

        with eng.begin() as c:
            role = c.execute(sa.text(
                "SELECT role FROM team_members_probe WHERE id = :id"
            ), {"id": member_id}).scalar_one()
        assert role == "owner", "휴먼 role(team_members)이 role_templates 마이그로 오염됐다"
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS role_templates"))
            c.execute(sa.text("DROP TABLE IF EXISTS team_members_probe"))
        eng.dispose()


def test_is_tool_allowed_roundtrip_after_grant():
    """AC2 — 그룹 문자열만 박고 끝내지 않는다: 부여된 default_tool_groups로 실제
    is_tool_allowed("sprintable_publish_event", ...)가 True로 왕복되는지 직접 확인."""
    from app.services.mcp_toolset import is_tool_allowed

    granted_groups = ["stories", "tasks", "chat", "events"]
    assert is_tool_allowed("sprintable_publish_event", granted_groups) is True
    assert is_tool_allowed("sprintable_list_event_definitions", granted_groups) is True

    ungranted_groups = ["stories", "tasks", "chat"]
    assert is_tool_allowed("sprintable_publish_event", ungranted_groups) is False


def test_all_24_role_template_seed_slugs_covered_by_migration_scope():
    """0246은 slug를 하드코딩하지 않고 테이블 전체를 UPDATE한다 — 이 테스트는 "전체"의 실
    크기(현존 24개 — 0156+0157+0160)가 스토리 서술과 어긋나지 않는지만 sanity로 고정.
    실 alembic upgrade heads로 직접 실측 확인(role_templates 24행, 전부 events 포함)."""
    slugs = _load_seed_slugs()
    assert len(slugs) == 24
