"""AC4 + AC5: model import + BaseRepository unit tests."""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models import Doc, Epic, Meeting, OrgMember, Project, Sprint, Story, Task, TeamMember


# ── AC4: import smoke ──────────────────────────────────────────────────────────

def test_model_imports() -> None:
    for cls in (Sprint, Epic, Story, Task, Doc, Meeting, Project, TeamMember, OrgMember):
        assert cls.__tablename__


def test_tablenames() -> None:
    assert Sprint.__tablename__ == "sprints"
    assert Epic.__tablename__ == "epics"
    assert Story.__tablename__ == "stories"
    assert Task.__tablename__ == "tasks"
    assert Doc.__tablename__ == "docs"
    assert Meeting.__tablename__ == "meetings"
    assert Project.__tablename__ == "projects"
    assert TeamMember.__tablename__ == "team_members"
    assert OrgMember.__tablename__ == "org_members"


def test_sprint_has_duration_and_report_doc_id() -> None:
    cols = {c.key for c in Sprint.__table__.columns}
    assert "duration" in cols
    assert "report_doc_id" in cols


def test_doc_has_doc_type() -> None:
    cols = {c.key for c in Doc.__table__.columns}
    assert "doc_type" in cols
    assert "parent_id" in cols


def test_meeting_no_org_id() -> None:
    cols = {c.key for c in Meeting.__table__.columns}
    assert "project_id" in cols
    assert "org_id" not in cols


# ── AC3: BaseRepository unit tests ────────────────────────────────────────────

@pytest.fixture
def org_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def mock_session() -> AsyncMock:
    session = AsyncMock()
    session.execute = AsyncMock()
    session.flush = AsyncMock()
    session.refresh = AsyncMock()
    session.delete = AsyncMock()
    return session


@pytest.fixture
def repo(mock_session: AsyncMock, org_id: uuid.UUID):
    from app.repositories.base import BaseRepository
    return BaseRepository(Project, mock_session, org_id)


@pytest.mark.asyncio
async def test_get_applies_org_filter(repo, mock_session: AsyncMock, org_id: uuid.UUID) -> None:
    project_id = uuid.uuid4()
    mock_project = MagicMock(spec=Project)
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_project
    mock_session.execute.return_value = mock_result

    result = await repo.get(project_id)

    assert result is mock_project
    mock_session.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_list_applies_org_filter(repo, mock_session: AsyncMock) -> None:
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute.return_value = mock_result

    result = await repo.list()

    assert result == []
    mock_session.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_injects_org_id(mock_session: AsyncMock, org_id: uuid.UUID) -> None:
    from app.repositories.base import BaseRepository

    created_obj = MagicMock(spec=Project)
    mock_session.add = MagicMock()

    with patch.object(Project, "__init__", return_value=None) as mock_init:
        repo = BaseRepository(Project, mock_session, org_id)
        mock_session.refresh = AsyncMock(side_effect=lambda obj: None)

        # patch to return a real-ish object
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = created_obj
            result = await repo.create(name="test")

    assert result is created_obj


@pytest.mark.asyncio
async def test_delete_returns_false_when_not_found(repo, mock_session: AsyncMock) -> None:
    missing_id = uuid.uuid4()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute.return_value = mock_result

    result = await repo.delete(missing_id)

    assert result is False
    mock_session.delete.assert_not_called()
