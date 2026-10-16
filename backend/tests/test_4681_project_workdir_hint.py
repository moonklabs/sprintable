"""[SID:4681] (UX-1 · D3 · AC4) — `projects.workdir_hint` is text: stored and shown as the person gave it, checked only as text
(trim · empty → none · length · control characters), and the server never opens it as a path.

Router tests follow tests/test_projects.py (mocked session · patched service); the «never a path» rule is pinned two ways:
the value round-trips verbatim (a path-looking string is just a string), and the modules that carry it import nothing that
opens files or resolves paths."""
import ast
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.schemas.project import WORKDIR_HINT_MAX_LEN, ProjectCreate, ProjectUpdate, normalize_workdir_hint

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_project(workdir_hint: str | None) -> MagicMock:
    p = MagicMock()
    p.id = PROJECT_ID
    p.org_id = ORG_ID
    p.name = "Sprintable"
    p.slug = "sprintable"
    p.description = None
    p.workdir_hint = workdir_hint
    p.created_at = datetime(2026, 10, 13, tzinfo=timezone.utc)
    p.updated_at = datetime(2026, 10, 13, tzinfo=timezone.utc)
    return p


async def _client():
    from app.main import app
    from app.dependencies.auth import get_current_user
    from tests.conftest import override_db_and_read

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    session = AsyncMock()

    async def override_db():
        yield session

    async def override_auth():
        return ctx

    override_db_and_read(app, override_db)
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), session, app


# ── the text checks (schema) ────────────────────────────────────────────────────────────────────────────────────────────


def test_normalize_trims_and_empties_to_none():
    assert normalize_workdir_hint(None) is None
    assert normalize_workdir_hint("") is None
    assert normalize_workdir_hint("   ") is None
    assert normalize_workdir_hint("  ~/work/foo  ") == "~/work/foo"


def test_normalize_keeps_a_path_looking_string_verbatim():
    # a path is just text here — nothing is resolved, nothing is refused for «looking dangerous» (the Mac decides what it opens)
    for s in ["/Users/me/work/foo", "~/.ssh", "../../etc/passwd", "C:\\work\\foo", "폴더 이름에 공백 · 한글"]:
        assert normalize_workdir_hint(s) == s


def test_normalize_refuses_too_long_and_control_characters():
    assert normalize_workdir_hint("a" * WORKDIR_HINT_MAX_LEN) == "a" * WORKDIR_HINT_MAX_LEN
    with pytest.raises(ValueError, match="too long"):
        normalize_workdir_hint("a" * (WORKDIR_HINT_MAX_LEN + 1))
    for bad in ["~/work\x00foo", "~/work\nfoo", "~/work\x1b[31mfoo", "~/work\x7f"]:
        with pytest.raises(ValueError, match="control characters"):
            normalize_workdir_hint(bad)


def test_create_schema_applies_the_checks():
    body = ProjectCreate(org_id=ORG_ID, name="P", workdir_hint="  ~/work/foo ")
    assert body.workdir_hint == "~/work/foo"
    assert ProjectCreate(org_id=ORG_ID, name="P").workdir_hint is None
    assert ProjectCreate(org_id=ORG_ID, name="P", workdir_hint="").workdir_hint is None
    with pytest.raises(ValidationError):
        ProjectCreate(org_id=ORG_ID, name="P", workdir_hint="x\x00y")
    with pytest.raises(ValidationError):
        ProjectCreate(org_id=ORG_ID, name="P", workdir_hint="a" * (WORKDIR_HINT_MAX_LEN + 1))


def test_update_schema_omitted_unchanged_null_clears_text_checked():
    assert "workdir_hint" not in ProjectUpdate(name="N").model_dump(exclude_unset=True)
    assert ProjectUpdate(workdir_hint=None).model_dump(exclude_unset=True) == {"workdir_hint": None}  # null = clear (nullable column)
    assert ProjectUpdate(workdir_hint=" ~/x ").model_dump(exclude_unset=True) == {"workdir_hint": "~/x"}
    with pytest.raises(ValidationError):
        ProjectUpdate(workdir_hint="x\ty")


# ── the routes (mocked) ─────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_create_passes_the_hint_to_the_service_and_echoes_it():
    client, session, app = await _client()
    try:
        created = _mock_project("~/work/foo")
        with patch("app.routers.projects.check_project_create_allowed", new=AsyncMock()), \
                patch("app.routers.projects.create_project_with_member", new=AsyncMock(return_value=created)) as cpm:
            async with client as c:
                resp = await c.post("/api/v2/projects", json={"org_id": str(ORG_ID), "name": "Sprintable", "workdir_hint": " ~/work/foo "})
        assert resp.status_code == 201
        assert resp.json()["workdir_hint"] == "~/work/foo"
        assert cpm.await_args.kwargs["workdir_hint"] == "~/work/foo"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_without_the_hint_passes_none_and_answers_null():
    client, session, app = await _client()
    try:
        with patch("app.routers.projects.check_project_create_allowed", new=AsyncMock()), \
                patch("app.routers.projects.create_project_with_member", new=AsyncMock(return_value=_mock_project(None))) as cpm:
            async with client as c:
                resp = await c.post("/api/v2/projects", json={"org_id": str(ORG_ID), "name": "Sprintable"})
        assert resp.status_code == 201
        assert resp.json()["workdir_hint"] is None
        assert cpm.await_args.kwargs["workdir_hint"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_refuses_control_characters_with_422_before_any_write():
    client, session, app = await _client()
    try:
        with patch("app.routers.projects.create_project_with_member", new=AsyncMock()) as cpm:
            async with client as c:
                resp = await c.post("/api/v2/projects", json={"org_id": str(ORG_ID), "name": "Sprintable", "workdir_hint": "~/w\x00f"})
        assert resp.status_code == 422
        cpm.assert_not_awaited()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_the_service_stores_the_hint_as_given():
    """create_project_with_member hands the text to the repository untouched (no resolve · no check as a path)."""
    from app.services import org_project_create as svc

    session = AsyncMock()
    with patch.object(svc, "resolve_unique_project_slug", new=AsyncMock(return_value="sprintable")), \
            patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as create:
        create.return_value = _mock_project("../../etc/passwd")
        await svc.create_project_with_member(session, org_id=ORG_ID, name="Sprintable", description=None, slug=None, user_id=None, workdir_hint="../../etc/passwd")
    assert create.await_args.kwargs["workdir_hint"] == "../../etc/passwd"
    # the desktop setup's own caller leaves it out → None
    with patch.object(svc, "resolve_unique_project_slug", new=AsyncMock(return_value="sprintable")), \
            patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as create:
        create.return_value = _mock_project(None)
        await svc.create_project_with_member(session, org_id=ORG_ID, name="Sprintable", description=None, slug=None, user_id=None)
    assert create.await_args.kwargs["workdir_hint"] is None


@pytest.mark.anyio
async def test_update_sets_and_clears_the_hint():
    client, session, app = await _client()
    try:
        found = MagicMock()
        found.scalar_one_or_none.return_value = _mock_project("~/old")
        session.execute = AsyncMock(return_value=found)
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=True)), \
                patch("app.repositories.base.BaseRepository.update", new_callable=AsyncMock) as update:
            async with client as c:
                update.return_value = _mock_project("~/new")
                resp = await c.patch(f"/api/v2/projects/{PROJECT_ID}", json={"workdir_hint": " ~/new "})
                assert resp.status_code == 200
                assert resp.json()["workdir_hint"] == "~/new"
                assert update.await_args.kwargs == {"workdir_hint": "~/new"}
                update.return_value = _mock_project(None)
                resp = await c.patch(f"/api/v2/projects/{PROJECT_ID}", json={"workdir_hint": None})
                assert resp.status_code == 200
                assert resp.json()["workdir_hint"] is None
                assert update.await_args.kwargs == {"workdir_hint": None}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_shows_the_hint():
    client, session, app = await _client()
    try:
        found = MagicMock()
        found.scalar_one_or_none.return_value = _mock_project("~/work/foo")
        session.execute = AsyncMock(return_value=found)
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=True)):
            async with client as c:
                resp = await c.get(f"/api/v2/projects/{PROJECT_ID}")
        assert resp.status_code == 200
        assert resp.json()["workdir_hint"] == "~/work/foo"
    finally:
        app.dependency_overrides.clear()


# ── AC4: the server never opens the hint as a path — the carrying modules import nothing that could ───────────────────


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_carrying_modules_import_no_filesystem_or_path_tools():
    backend = Path(__file__).resolve().parents[1]
    for rel in ["app/schemas/project.py", "app/routers/projects.py", "app/services/org_project_create.py", "app/models/project.py"]:
        mods = _imported_modules(backend / rel)
        assert not ({"os", "pathlib", "shutil", "glob", "aiofiles", "subprocess"} & mods), f"{rel} imports {mods}"
        src = (backend / rel).read_text(encoding="utf-8")
        assert "open(" not in src.replace("opens", ""), f"{rel} opens a file"


def test_migration_0451_is_additive_text_only():
    backend = Path(__file__).resolve().parents[1]
    src = (backend / "alembic/versions/0451_project_workdir_hint.py").read_text(encoding="utf-8")
    assert 'op.add_column("projects", sa.Column("workdir_hint", sa.Text(), nullable=True))' in src
    assert "create_index" not in src and "server_default" not in src
