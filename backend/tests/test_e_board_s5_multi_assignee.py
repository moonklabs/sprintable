"""E-BOARD S5: 복수 assignee BE — schema/model/migration/repo 단위 검증.

엔드포인트 통합은 실 dev 적용 후 확인. 여기선 DB 없이 잠글 수 있는 계약을 잠근다.
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest
from unittest.mock import AsyncMock, MagicMock

_MIGRATION = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0094_add_story_assignees.py"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── schema ────────────────────────────────────────────────────────────────────

def test_create_update_accept_assignee_ids():
    from app.schemas.story import StoryCreate, StoryUpdate

    a, b = uuid.uuid4(), uuid.uuid4()
    c = StoryCreate(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="t", assignee_ids=[a, b])
    assert c.assignee_ids == [a, b]
    u = StoryUpdate(assignee_ids=[a])
    assert u.assignee_ids == [a]
    # 미지정 시 None (back-compat: join 미변경 신호)
    assert StoryCreate(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="t").assignee_ids is None
    assert StoryUpdate().assignee_ids is None


def test_response_exposes_assignee_ids_default_empty():
    from app.schemas.story import StoryResponse

    assert "assignee_ids" in StoryResponse.model_fields
    # 레거시 ORM(속성 없음) → from_attributes 기본값 []
    assert StoryResponse.model_fields["assignee_ids"].default == []


# ── model ─────────────────────────────────────────────────────────────────────

def test_story_assignee_model_structure():
    from app.models.story_assignee import StoryAssignee

    t = StoryAssignee.__table__
    assert t.name == "story_assignees"
    # member_id: FK 미부착 (grant-only 휴먼 허용, assignee_id와 동형)
    assert len(t.c.member_id.foreign_keys) == 0
    # story_id: stories FK + CASCADE
    fk = next(iter(t.c.story_id.foreign_keys))
    assert fk.column.table.name == "stories"
    assert fk.ondelete == "CASCADE"
    # org_id 존재(테넌트 스코프)
    assert "org_id" in t.c
    # (story_id, member_id) 유니크
    uniques = {tuple(sorted(col.name for col in con.columns)) for con in t.constraints
               if con.__class__.__name__ == "UniqueConstraint"}
    assert ("member_id", "story_id") in uniques


def test_migration_0094_chains_off_0093():
    spec = importlib.util.spec_from_file_location("rev_0094", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.revision == "0094"
    assert mod.down_revision == "0093"
    assert callable(mod.upgrade) and callable(mod.downgrade)


# ── repository: dedup + 순서 보존 ────────────────────────────────────────────

@pytest.mark.anyio
async def test_set_for_story_dedup_and_order():
    from app.repositories.story_assignee import StoryAssigneeRepository

    org, story = uuid.uuid4(), uuid.uuid4()
    m1, m2, m3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    session = AsyncMock()
    added: list = []
    session.add = MagicMock(side_effect=added.append)

    repo = StoryAssigneeRepository(session, org)
    saved = await repo.set_for_story(story, [m1, m2, m1, m3, m2])  # 중복 m1, m2

    assert saved == [m1, m2, m3]  # dedup + 입력 순서 보존
    assert [o.member_id for o in added] == [m1, m2, m3]
    assert all(o.org_id == org and o.story_id == story for o in added)
    session.execute.assert_awaited()  # 기존 행 delete 선행
