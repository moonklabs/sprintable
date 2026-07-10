from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.visual_artifact import ArtifactNode, ArtifactVersion, VisualArtifact
from app.schemas.visual_artifact import (
    ArtifactNodeOut,
    ArtifactVersionSummary,
    CreateArtifactRequest,
    VisualArtifactDetail,
    VisualArtifactSummary,
)
from app.services.project_auth import assert_target_in_caller_org

router = APIRouter(prefix="/api/v2/visual-artifacts", tags=["visual-artifacts"])


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


_LINK_TABLES = {"story_id": "stories", "epic_id": "epics", "doc_id": "docs"}


async def _assert_link_target_in_org(
    session: AsyncSession, caller_org_id: uuid.UUID, body: CreateArtifactRequest,
) -> None:
    """E-CANVAS C1-S3(story 8bace49e) crux 확認 사항: story_id/epic_id/doc_id 연결 시 SEC-S6/S7
    공통 가드(`assert_target_in_caller_org`) 재사용 — tenant 격리를 신규 기능에 재발시키지 않는다."""
    for field, table in _LINK_TABLES.items():
        target_id = getattr(body, field)
        if target_id is None:
            continue
        target_org_id = (await session.execute(
            text(f"SELECT org_id FROM {table} WHERE id = :id"),  # noqa: S608 — table은 고정 allowlist(_LINK_TABLES), 요청값 아님
            {"id": target_id},
        )).scalar_one_or_none()
        assert_target_in_caller_org(
            caller_org_id, target_org_id, not_found_detail=f"{field.replace('_id', '').title()} not found",
        )


@router.post("", status_code=201)
async def create_artifact(
    body: CreateArtifactRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    await _assert_link_target_in_org(session, org_id, body)

    created_by = uuid.UUID(auth.user_id)
    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=body.title,
        story_id=body.story_id, epic_id=body.epic_id, doc_id=body.doc_id,
        source=body.source, latest_version_number=1, created_by=created_by,
    )
    session.add(artifact)
    await session.flush()

    version = ArtifactVersion(
        id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=created_by,
        summary=body.summary,
    )
    session.add(version)
    await session.flush()

    nodes: list[ArtifactNode] = []
    for n in body.nodes:
        node = ArtifactNode(
            id=n.id or uuid.uuid4(), artifact_id=artifact.id, version_id=version.id,
            type=n.type, props=n.props, parent_id=n.parent_id, sort_order=n.sort_order,
        )
        session.add(node)
        nodes.append(node)
    await session.flush()

    detail = VisualArtifactDetail(
        id=artifact.id, org_id=artifact.org_id, project_id=artifact.project_id, title=artifact.title,
        story_id=artifact.story_id, epic_id=artifact.epic_id, doc_id=artifact.doc_id,
        source=artifact.source, latest_version_number=artifact.latest_version_number,
        anchor_version=artifact.anchor_version,
        created_by=artifact.created_by, created_at=artifact.created_at, updated_at=artifact.updated_at,
        version_number=version.version_number, version_summary=version.summary,
        nodes=[ArtifactNodeOut.model_validate(n) for n in nodes],
    )
    return _ok(detail.model_dump(mode="json"), status=201)


async def _get_artifact_or_404(
    session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, id: uuid.UUID
) -> VisualArtifact | None:
    """E-SECURITY SEC-S8(story 83ea3d6a) Q: org_id만 필터해 개별-ID GET/versions/version-detail/
    DELETE가 G(N)의 list project_id 필터를 직접 우회했다(같은 org 다른 project의 artifact id를
    알면 200) — list_artifacts와 동형으로 project_id도 함께 필터."""
    return (await session.execute(
        select(VisualArtifact).where(
            VisualArtifact.id == id, VisualArtifact.org_id == org_id,
            VisualArtifact.project_id == project_id, VisualArtifact.deleted_at.is_(None),
        )
    )).scalar_one_or_none()


async def _load_detail(session: AsyncSession, artifact: VisualArtifact, version_number: int) -> VisualArtifactDetail | None:
    version = (await session.execute(
        select(ArtifactVersion).where(
            ArtifactVersion.artifact_id == artifact.id, ArtifactVersion.version_number == version_number,
        )
    )).scalar_one_or_none()
    if version is None:
        return None
    node_rows = (await session.execute(
        select(ArtifactNode).where(ArtifactNode.version_id == version.id).order_by(ArtifactNode.sort_order)
    )).scalars().all()
    return VisualArtifactDetail(
        id=artifact.id, org_id=artifact.org_id, project_id=artifact.project_id, title=artifact.title,
        story_id=artifact.story_id, epic_id=artifact.epic_id, doc_id=artifact.doc_id,
        source=artifact.source, latest_version_number=artifact.latest_version_number,
        anchor_version=artifact.anchor_version,
        created_by=artifact.created_by, created_at=artifact.created_at, updated_at=artifact.updated_at,
        version_number=version.version_number, version_summary=version.summary,
        nodes=[ArtifactNodeOut.model_validate(n) for n in node_rows],
    )


@router.get("/{id}")
async def get_artifact(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    detail = await _load_detail(session, artifact, artifact.latest_version_number)
    if detail is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)
    return _ok(detail.model_dump(mode="json"))


@router.get("/{id}/versions")
async def list_artifact_versions(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    rows = (await session.execute(
        select(ArtifactVersion).where(ArtifactVersion.artifact_id == id)
        .order_by(ArtifactVersion.version_number.desc())
    )).scalars().all()
    return _ok([ArtifactVersionSummary.model_validate(r).model_dump(mode="json") for r in rows])


@router.get("/{id}/versions/{version_number}")
async def get_artifact_version(
    id: uuid.UUID,
    version_number: int,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """무-mutate 버전 조회 — 미르코 §6-1 갭 지적 대응(mockup은 restore=즉시 라이브 덮어씀)."""
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    detail = await _load_detail(session, artifact, version_number)
    if detail is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)
    return _ok(detail.model_dump(mode="json"))


@router.get("")
async def list_artifacts(
    story_id: uuid.UUID | None = Query(default=None),
    epic_id: uuid.UUID | None = Query(default=None),
    doc_id: uuid.UUID | None = Query(default=None),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    # E-SECURITY SEC-S8(story 83ea3d6a) G(N): project_id 필터가 아예 없어 story_id/epic_id/
    # doc_id 미지정 호출(파라미터 없는 목록 조회)이 org 전체 artifact를 반환했다(cross-project
    # 노출·미르코 라이브 실측). create_artifact/get_artifact와 동형으로 JWT/API키 컨텍스트의
    # project_id(비-caller-suppliable)로 항상 스코프.
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    q = select(VisualArtifact).where(
        VisualArtifact.org_id == org_id, VisualArtifact.project_id == project_id,
        VisualArtifact.deleted_at.is_(None),
    )
    if story_id is not None:
        q = q.where(VisualArtifact.story_id == story_id)
    if epic_id is not None:
        q = q.where(VisualArtifact.epic_id == epic_id)
    if doc_id is not None:
        q = q.where(VisualArtifact.doc_id == doc_id)
    q = q.order_by(VisualArtifact.created_at.desc())
    rows = (await session.execute(q)).scalars().all()
    return _ok([VisualArtifactSummary.model_validate(r).model_dump(mode="json") for r in rows])


@router.delete("/{id}")
async def delete_artifact(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """생성자만 삭제 가능(Evidence 패턴 계승 — "누가 주어인가"). soft delete."""
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    if artifact.created_by != uuid.UUID(auth.user_id):
        return _err("FORBIDDEN", "생성자만 삭제할 수 있습니다", 403)
    from datetime import datetime, timezone
    artifact.deleted_at = datetime.now(timezone.utc)
    await session.flush()
    return _ok({"ok": True, "id": str(id)})
