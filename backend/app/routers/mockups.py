from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.mockup import MockupComponent, MockupPage, MockupScenario, MockupVersion, UsageMeter
from app.schemas.mockup import (
    CreateMockupRequest, CreateScenarioRequest, DeleteScenarioRequest,
    MockupComponentOut, MockupPageSummary, RestoreVersionRequest,
    UpdateMockupRequest, UpdateScenarioRequest, UsageMeterOut,
)

router = APIRouter(prefix="/api/v2", tags=["mockups"])


def _ok(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status)


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


def _get_org_project(auth: AuthContext) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    meta = auth.claims.get("app_metadata", {})
    o = meta.get("org_id")
    p = meta.get("project_id")
    if not o or not p:
        return None, None
    return uuid.UUID(str(o)), uuid.UUID(str(p))


# ─── Mockups CRUD ─────────────────────────────────────────────────────────────

@router.get("/mockups")
async def list_mockups(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    offset = (page - 1) * limit
    result = await session.execute(
        select(MockupPage)
        .where(MockupPage.project_id == project_id, MockupPage.deleted_at.is_(None))
        .order_by(MockupPage.created_at.desc())
        .offset(offset).limit(limit)
    )
    rows = result.scalars().all()
    items = [MockupPageSummary.model_validate(r).model_dump(mode="json") for r in rows]
    return _ok({"items": items, "page": page, "limit": limit})


@router.post("/mockups", status_code=201)
async def create_mockup(
    body: CreateMockupRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    now = datetime.now(timezone.utc)
    page = MockupPage(
        org_id=org_id, project_id=project_id,
        slug=body.slug, title=body.title,
        category=body.category, viewport=body.viewport,
        created_by=auth.user_id, created_at=now, updated_at=now,
    )
    session.add(page)
    await session.flush()

    # default scenario
    session.add(MockupScenario(
        page_id=page.id, name="Default", override_props={}, is_default=True, sort_order=0,
    ))
    await session.commit()
    return _ok(MockupPageSummary.model_validate(page).model_dump(mode="json"), 201)


@router.get("/mockups/{page_id}")
async def get_mockup(
    page_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    result = await session.execute(
        select(MockupPage).where(MockupPage.id == page_id, MockupPage.deleted_at.is_(None))
    )
    page = result.scalar_one_or_none()
    if not page:
        return _err("NOT_FOUND", "Mockup not found", 404)

    comps_r = await session.execute(
        select(MockupComponent).where(MockupComponent.page_id == page_id).order_by(MockupComponent.sort_order)
    )
    scenarios_r = await session.execute(
        select(MockupScenario).where(MockupScenario.page_id == page_id).order_by(MockupScenario.sort_order)
    )
    components = [MockupComponentOut.model_validate(c).model_dump(mode="json") for c in comps_r.scalars().all()]
    scenarios = [{"name": s.name, "overrides": s.override_props, "is_default": s.is_default} for s in scenarios_r.scalars().all()]

    data: dict[str, Any] = {
        "id": str(page.id), "org_id": str(page.org_id), "project_id": str(page.project_id),
        "slug": page.slug, "title": page.title, "category": page.category,
        "viewport": page.viewport, "version": page.version,
        "created_by": str(page.created_by) if page.created_by else None,
        "created_at": page.created_at.isoformat(), "updated_at": page.updated_at.isoformat(),
        "components": components, "scenarios": scenarios,
    }
    return _ok(data)


@router.put("/mockups/{page_id}")
async def update_mockup(
    page_id: uuid.UUID,
    body: UpdateMockupRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, _ = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    result = await session.execute(
        select(MockupPage).where(MockupPage.id == page_id, MockupPage.deleted_at.is_(None))
    )
    page = result.scalar_one_or_none()
    if not page:
        return _err("NOT_FOUND", "Mockup not found", 404)

    now = datetime.now(timezone.utc)
    updates: dict[str, Any] = {"updated_at": now}
    if body.title is not None:
        updates["title"] = body.title
    if body.category is not None:
        updates["category"] = body.category
    if body.viewport is not None:
        updates["viewport"] = body.viewport

    if body.components is not None:
        await session.execute(
            text("DELETE FROM mockup_components WHERE page_id = :pid"), {"pid": str(page_id)}
        )
        for comp in body.components:
            session.add(MockupComponent(
                page_id=page_id,
                type=comp.get("type", "box"),
                props=comp.get("props", {}),
                sort_order=comp.get("sort_order", 0),
                parent_id=uuid.UUID(comp["parent_id"]) if comp.get("parent_id") else None,
            ))
        updates["version"] = (page.version or 1) + 1

    await session.execute(update(MockupPage).where(MockupPage.id == page_id).values(**updates))
    await session.commit()
    return _ok({"ok": True})


@router.delete("/mockups/{page_id}")
async def delete_mockup(
    page_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, _ = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    await session.execute(
        update(MockupPage)
        .where(MockupPage.id == page_id, MockupPage.deleted_at.is_(None))
        .values(deleted_at=datetime.now(timezone.utc))
    )
    await session.commit()
    return _ok({"ok": True})


# ─── Versions ─────────────────────────────────────────────────────────────────

@router.get("/mockups/{page_id}/versions")
async def list_versions(
    page_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    if not _get_org_project(auth)[0]:
        return _err("FORBIDDEN", "org_id required", 403)

    result = await session.execute(
        select(MockupVersion.id, MockupVersion.version, MockupVersion.created_at)
        .where(MockupVersion.page_id == page_id)
        .order_by(MockupVersion.version.desc())
    )
    rows = [{"id": str(r.id), "version": r.version, "created_at": r.created_at.isoformat()} for r in result.all()]
    return _ok(rows)


@router.post("/mockups/{page_id}/versions")
async def restore_version(
    page_id: uuid.UUID,
    body: RestoreVersionRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    if not _get_org_project(auth)[0]:
        return _err("FORBIDDEN", "org_id required", 403)

    result = await session.execute(
        select(MockupVersion).where(MockupVersion.id == body.version_id, MockupVersion.page_id == page_id)
    )
    ver = result.scalar_one_or_none()
    if not ver:
        return _err("NOT_FOUND", "Version not found", 404)

    snapshot = ver.snapshot or {}
    now = datetime.now(timezone.utc)

    await session.execute(text("DELETE FROM mockup_components WHERE page_id = :pid"), {"pid": str(page_id)})
    components = snapshot.get("components") or []
    for comp in components:
        session.add(MockupComponent(
            page_id=page_id,
            type=comp.get("type", "box"),
            props=comp.get("props", {}),
            sort_order=comp.get("sort_order", 0),
        ))

    updates: dict[str, Any] = {"updated_at": now}
    if snapshot.get("title"):
        updates["title"] = snapshot["title"]

    scenarios = snapshot.get("scenarios") or []
    if scenarios:
        await session.execute(text("DELETE FROM mockup_scenarios WHERE page_id = :pid"), {"pid": str(page_id)})
        for s in scenarios:
            session.add(MockupScenario(
                page_id=page_id,
                name=s.get("name", "Scenario"),
                override_props=s.get("override_props", {}),
                is_default=s.get("is_default", False),
                sort_order=s.get("sort_order", 0),
            ))

    await session.execute(text("SELECT increment_mockup_version(:pid)"), {"pid": str(page_id)})
    await session.execute(update(MockupPage).where(MockupPage.id == page_id).values(**updates))
    await session.commit()
    return _ok({"ok": True})


# ─── Scenarios ────────────────────────────────────────────────────────────────

@router.get("/mockups/{page_id}/scenarios")
async def list_scenarios(
    page_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    if not _get_org_project(auth)[0]:
        return _err("FORBIDDEN", "org_id required", 403)
    result = await session.execute(
        select(MockupScenario).where(MockupScenario.page_id == page_id).order_by(MockupScenario.sort_order)
    )
    rows = [{"id": str(s.id), "page_id": str(s.page_id), "name": s.name, "override_props": s.override_props, "is_default": s.is_default, "sort_order": s.sort_order} for s in result.scalars().all()]
    return _ok(rows)


@router.post("/mockups/{page_id}/scenarios", status_code=201)
async def create_scenario(
    page_id: uuid.UUID,
    body: CreateScenarioRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    if not _get_org_project(auth)[0]:
        return _err("FORBIDDEN", "org_id required", 403)
    s = MockupScenario(page_id=page_id, name=body.name, override_props=body.override_props, is_default=False)
    session.add(s)
    await session.commit()
    return _ok({"id": str(s.id), "page_id": str(s.page_id), "name": s.name, "override_props": s.override_props, "is_default": s.is_default, "sort_order": s.sort_order}, 201)


@router.patch("/mockups/{page_id}/scenarios")
async def update_scenario(
    page_id: uuid.UUID,
    body: UpdateScenarioRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    if not _get_org_project(auth)[0]:
        return _err("FORBIDDEN", "org_id required", 403)
    vals: dict[str, Any] = {}
    if body.name is not None:
        vals["name"] = body.name
    if body.override_props is not None:
        vals["override_props"] = body.override_props
    if body.sort_order is not None:
        vals["sort_order"] = body.sort_order
    if vals:
        await session.execute(
            update(MockupScenario).where(MockupScenario.id == body.scenario_id, MockupScenario.page_id == page_id).values(**vals)
        )
        await session.commit()
    return _ok({"ok": True})


@router.delete("/mockups/{page_id}/scenarios")
async def delete_scenario(
    page_id: uuid.UUID,
    body: DeleteScenarioRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    if not _get_org_project(auth)[0]:
        return _err("FORBIDDEN", "org_id required", 403)
    result = await session.execute(
        select(MockupScenario).where(MockupScenario.id == body.scenario_id, MockupScenario.page_id == page_id)
    )
    s = result.scalar_one_or_none()
    if not s:
        return _err("NOT_FOUND", "Scenario not found", 404)
    if s.is_default:
        return _err("CANNOT_DELETE_DEFAULT", "Cannot delete default scenario", 400)
    await session.delete(s)
    await session.commit()
    return _ok({"ok": True})


# ─── Usage Meters ─────────────────────────────────────────────────────────────

@router.get("/usage")
async def get_usage_meters(
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, _ = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    now = datetime.now(timezone.utc)
    period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    result = await session.execute(
        select(UsageMeter.meter_type, UsageMeter.current_value, UsageMeter.limit_value, UsageMeter.period_start, UsageMeter.period_end)
        .where(UsageMeter.org_id == org_id, UsageMeter.period_start >= period_start)
        .order_by(UsageMeter.meter_type)
    )
    rows = [UsageMeterOut.model_validate(r).model_dump(mode="json") for r in result.all()]
    return _ok(rows)
