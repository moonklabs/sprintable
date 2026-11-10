"""story 6185e437 (UI-9) — `POST /api/v2/docs` with an empty slug: '' is a slug to the unique (project_id, slug) index (`docs_project_slug_active`), so the first doc of a
project took it and EVERY later blank one broke the index with an IntegrityError → a 500 (seen on dev: only the first folder 201, the rest 500). A blank slug is a caller error: 422."""
from __future__ import annotations

import os
import uuid

import pytest
from pydantic import ValidationError

from app.schemas.doc import DocCreate


def _body(**over):
    return {"project_id": uuid.uuid4(), "org_id": uuid.uuid4(), "title": "기획", "slug": "plan", **over}


@pytest.mark.parametrize("blank", ["", " ", "   ", "\t", "\n"])
def test_a_blank_slug_is_a_validation_error_not_a_row(blank: str) -> None:
    with pytest.raises(ValidationError) as e:
        DocCreate(**_body(slug=blank))
    assert "slug must not be blank" in str(e.value)


def test_a_real_slug_and_the_untitled_family_still_pass() -> None:
    assert DocCreate(**_body(slug="prd-v2")).slug == "prd-v2"
    assert DocCreate(**_body(slug="untitled-1794292070034")).slug == "untitled-1794292070034"


# the cause, pinned against a real database: the unique index takes ONE '' per project and refuses the second
_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.skipif(not _REAL_DB_URL, reason="real PG (PARITY/ALEMBIC_DATABASE_URL) needed")
@pytest.mark.anyio
async def test_two_docs_with_an_empty_slug_in_one_project_break_the_unique_index() -> None:
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.organization import Organization
    from app.models.project import Project
    from app.repositories.doc import DocRepository

    engine = create_async_engine(_async_url())
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org); await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project); await s.commit()
            repo = DocRepository(s, org.id)
            first = await repo.create(project_id=project.id, title="기획", slug="", content="", doc_type="page")
            assert first.slug == "", "the first '' is accepted — that is how the problem hid"
            with pytest.raises(IntegrityError):
                await repo.create(project_id=project.id, title="회의록", slug="", content="", doc_type="page")
    finally:
        await engine.dispose()
