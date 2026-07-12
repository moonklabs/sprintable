from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.asset import Asset
from app.models.visual_artifact import (
    ArtifactComment, ArtifactExport, ArtifactNode, ArtifactVersion, VisualArtifact,
)
from app.schemas.visual_artifact import (
    ArtifactCommentResponse,
    ArtifactExportResponse,
    ArtifactNodeOperation,
    ArtifactNodeOut,
    ArtifactVersionSummary,
    CompleteExportRequest,
    CreateArtifactCommentRequest,
    CreateArtifactRequest,
    EditArtifactRequest,
    ExportUploadUrlRequest,
    ExportUploadUrlResponse,
    VisualArtifactDetail,
    VisualArtifactSummary,
)
from app.services.member_resolver import filter_org_member_ids
from app.services.notification_dispatch import dispatch_notification
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


async def _assert_link_target_in_scope(
    session: AsyncSession, caller_org_id: uuid.UUID, caller_project_id: uuid.UUID, body: CreateArtifactRequest,
) -> None:
    """E-CANVAS C1-S3(story 8bace49e) crux + E-SECURITY SEC-S8 R(까심 전수스윕): story_id/epic_id/
    doc_id 연결 시 SEC-S6/S7 공통 가드(`assert_target_in_caller_org`)로 org만 대조하고 project는
    안 봐서, 같은 org 다른 project 스토리/에픽/doc에 artifact를 링크할 수 있었다(G/Q와 동형
    project-scope 부재). org 대조와 동일 지점에서 target의 project_id도 함께 조회해 caller
    project와 대조 — 불일치/미존재 모두 404(존재 비노출)."""
    for field, table in _LINK_TABLES.items():
        target_id = getattr(body, field)
        if target_id is None:
            continue
        row = (await session.execute(
            text(f"SELECT org_id, project_id FROM {table} WHERE id = :id"),  # noqa: S608 — table은 고정 allowlist(_LINK_TABLES), 요청값 아님
            {"id": target_id},
        )).first()
        target_org_id = row.org_id if row is not None else None
        target_project_id = row.project_id if row is not None else None
        not_found_detail = f"{field.replace('_id', '').title()} not found"
        assert_target_in_caller_org(caller_org_id, target_org_id, not_found_detail=not_found_detail)
        if target_project_id != caller_project_id:
            raise HTTPException(status_code=404, detail=not_found_detail)


@router.post("", status_code=201)
async def create_artifact(
    body: CreateArtifactRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    await _assert_link_target_in_scope(session, org_id, project_id, body)

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
            description=n.description,
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
        version_source_comment_id=version.source_comment_id,
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
        version_source_comment_id=version.source_comment_id,
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


# ─── Comments (E-CANVAS C2-S6, story 0edca31e) ────────────────────────────────
# 스토리 코멘트(stories.py add_comment/list_comments)와 공통 프리미티브(content/created_by/
# created_at + C0 이벤트 전파) 계승. artifact 특유의 앵커(node_id 또는 anchor_x/y)·스레드
# (parent_id)·resolve 추가.


@router.get("/{id}/comments")
async def list_artifact_comments(
    id: uuid.UUID,
    limit: int = Query(default=50, le=200),
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
        select(ArtifactComment).where(ArtifactComment.artifact_id == id)
        .order_by(ArtifactComment.created_at.asc()).limit(limit)
    )).scalars().all()
    return _ok([ArtifactCommentResponse.model_validate(r).model_dump(mode="json") for r in rows])


@router.post("/{id}/comments", status_code=201)
async def add_artifact_comment(
    id: uuid.UUID,
    body: CreateArtifactCommentRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)

    if body.node_id is not None:
        node_owner = (await session.execute(
            select(ArtifactNode.artifact_id).where(ArtifactNode.id == body.node_id)
        )).scalar_one_or_none()
        if node_owner != artifact.id:
            return _err("NOT_FOUND", "Node not found on this artifact", 404)

    if body.parent_id is not None:
        parent_owner = (await session.execute(
            select(ArtifactComment.artifact_id).where(ArtifactComment.id == body.parent_id)
        )).scalar_one_or_none()
        if parent_owner != artifact.id:
            return _err("NOT_FOUND", "Parent comment not found on this artifact", 404)

    created_by = uuid.UUID(auth.user_id)
    comment = ArtifactComment(
        id=uuid.uuid4(), artifact_id=artifact.id, org_id=org_id, project_id=project_id,
        node_id=body.node_id, anchor_x=body.anchor_x, anchor_y=body.anchor_y,
        content=body.content, parent_id=body.parent_id, created_by=created_by,
    )
    session.add(comment)
    await session.flush()
    await session.refresh(comment)

    # E-CANVAS C0-S1 §F4 계승(stories.py add_comment와 동형): comment.created 이벤트 전파.
    # 수신자 = artifact 생성자 + mentioned_ids(cross-org 필터) - 작성자 본인.
    valid_mentioned_ids = await filter_org_member_ids(set(body.mentioned_ids), org_id, session)
    target_member_ids = list(
        (valid_mentioned_ids | ({artifact.created_by} if artifact.created_by else set())) - {created_by}
    )
    if target_member_ids:
        await dispatch_notification(
            session,
            org_id=org_id,
            event_type="comment.created",
            target_member_ids=target_member_ids,
            title=f"새 코멘트: {artifact.title}",
            body=body.content[:200],
            reference_type="visual_artifact",
            reference_id=artifact.id,
            source_project_id=project_id,
        )

    return _ok(ArtifactCommentResponse.model_validate(comment).model_dump(mode="json"), status=201)


@router.post("/{id}/comments/{comment_id}/resolve")
async def resolve_artifact_comment(
    id: uuid.UUID,
    comment_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    comment = (await session.execute(
        select(ArtifactComment).where(
            ArtifactComment.id == comment_id, ArtifactComment.artifact_id == artifact.id,
        )
    )).scalar_one_or_none()
    if comment is None:
        return _err("NOT_FOUND", "Comment not found", 404)
    from datetime import datetime, timezone
    comment.resolved = True
    comment.resolved_by = uuid.UUID(auth.user_id)
    comment.resolved_at = datetime.now(timezone.utc)
    await session.flush()
    await session.refresh(comment)
    return _ok(ArtifactCommentResponse.model_validate(comment).model_dump(mode="json"))


# ─── Export (E-CANVAS C1-S5, story 1f365e33) ──────────────────────────────────
# crux(오르테가 승인): PNG는 클라 캡처 — BE는 바이너리를 경유하지 않고 signed write URL만 발급,
# FE가 GCS에 직접 PUT 후 complete로 편입 알림(head_object 실체 검증 — client-trust 금지 원칙
# 계승). HTML은 렌더 불요라 BE가 즉시 생성+저장(client-trust 이슈 없음). asset_id는 유나 UX③
# (공유 링크 1급)의 안정 참조 — 기존 attachments.authorize(asset_id=) 인프라 재사용.

_EXPORT_TTL_MIN = 30


def _export_container() -> str:
    from app.services.asset_registry import DEFAULT_CONTAINER
    return DEFAULT_CONTAINER


def _export_object_path(org_id: uuid.UUID, project_id: uuid.UUID, artifact_id: uuid.UUID, ext: str) -> str:
    """SEC 계열 스코프 원칙 계승(org/project/artifact 전 segment exact 바인딩) — cross-project
    export asset 오염/IDOR 차단."""
    return f"org/{org_id}/project/{project_id}/artifact/{artifact_id}/export/{uuid.uuid4()}.{ext}"


def _export_path_in_scope(object_path: str, org_id: uuid.UUID, project_id: uuid.UUID, artifact_id: uuid.UUID) -> bool:
    expected_prefix = f"org/{org_id}/project/{project_id}/artifact/{artifact_id}/export/"
    return object_path.startswith(expected_prefix)


async def _get_version_or_404(
    session: AsyncSession, artifact_id: uuid.UUID, version_number: int
) -> ArtifactVersion | None:
    return (await session.execute(
        select(ArtifactVersion).where(
            ArtifactVersion.artifact_id == artifact_id, ArtifactVersion.version_number == version_number,
        )
    )).scalar_one_or_none()


async def _upsert_export_asset(
    session: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID,
    object_path: str, name: str, content_type: str, size_bytes: int, created_by: uuid.UUID,
) -> uuid.UUID:
    """assets 레지스트리 upsert(멱등) — asset_registry.sync_attachment_assets와 동일 ON CONFLICT
    키 규칙(org_id/project_id/container/object_path)이나 AssetLink 폴리모픽 확장 없이 단독 사용
    (ArtifactExport가 자체 귀속 테이블이라 소스타입 CHECK 확장 불요)."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    container = _export_container()
    base_ins = pg_insert(Asset).values(
        org_id=org_id, project_id=project_id, container=container, object_path=object_path,
        name=name, content_type=content_type, size_bytes=size_bytes, created_by=created_by,
    )
    ins = base_ins.on_conflict_do_nothing(
        index_elements=[Asset.org_id, Asset.project_id, Asset.container, Asset.object_path],
        index_where=Asset.project_id.isnot(None),
    ).returning(Asset.id)
    asset_id = (await session.execute(ins)).scalar_one_or_none()
    if asset_id is None:
        sel = select(Asset.id).where(
            Asset.org_id == org_id, Asset.project_id == project_id,
            Asset.container == container, Asset.object_path == object_path,
        )
        asset_id = (await session.execute(sel)).scalar_one()
    return asset_id


async def _export_response(
    session: AsyncSession, export: ArtifactExport, version_number: int, *, container: str,
) -> ArtifactExportResponse:
    from datetime import timedelta

    from app.services.storage import get_storage_provider

    asset = (await session.execute(select(Asset).where(Asset.id == export.asset_id))).scalar_one()
    download_url = await get_storage_provider().signed_read_url(
        container, asset.object_path, ttl=timedelta(minutes=_EXPORT_TTL_MIN),
    )
    return ArtifactExportResponse(
        id=export.id, artifact_id=export.artifact_id, version_id=export.version_id,
        version_number=version_number, format=export.format, created_by=export.created_by,
        created_at=export.created_at, asset_id=export.asset_id, download_url=download_url,
    )


@router.post("/{id}/versions/{version_number}/export/png/upload-url")
async def create_export_upload_url(
    id: uuid.UUID,
    version_number: int,
    body: ExportUploadUrlRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    from datetime import datetime, timedelta, timezone

    from app.services.storage import get_storage_provider

    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    version = await _get_version_or_404(session, artifact.id, version_number)
    if version is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)

    object_path = _export_object_path(org_id, project_id, artifact.id, "png")
    ttl = timedelta(minutes=_EXPORT_TTL_MIN)
    upload_url = await get_storage_provider().signed_write_url(
        _export_container(), object_path, ttl=ttl, content_type=body.content_type,
    )
    if upload_url is None:
        return _err("STORAGE_ERROR", "signed write URL 발급 실패", 500)
    return _ok(ExportUploadUrlResponse(
        upload_url=upload_url, object_path=object_path,
        expires_at=datetime.now(timezone.utc) + ttl,
    ).model_dump(mode="json"))


@router.post("/{id}/versions/{version_number}/export/png/complete", status_code=201)
async def complete_png_export(
    id: uuid.UUID,
    version_number: int,
    body: CompleteExportRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    from app.services.storage import get_storage_provider

    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    version = await _get_version_or_404(session, artifact.id, version_number)
    if version is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)

    if not _export_path_in_scope(body.object_path, org_id, project_id, artifact.id):
        return _err("FORBIDDEN", "object_path not in artifact export scope", 403)

    container = _export_container()
    size_bytes = await get_storage_provider().head_object(container, body.object_path)
    if size_bytes is None:
        return _err("NOT_FOUND", "업로드된 객체를 찾을 수 없습니다(head_object 실패)", 404)

    created_by = uuid.UUID(auth.user_id)
    asset_id = await _upsert_export_asset(
        session, org_id=org_id, project_id=project_id, object_path=body.object_path,
        name=f"{artifact.title}-v{version_number}.png", content_type="image/png",
        size_bytes=size_bytes, created_by=created_by,
    )
    export = ArtifactExport(
        id=uuid.uuid4(), artifact_id=artifact.id, version_id=version.id, format="png",
        asset_id=asset_id, created_by=created_by,
    )
    session.add(export)
    await session.flush()
    await session.refresh(export)

    target_member_ids = list({artifact.created_by} - {created_by}) if artifact.created_by else []
    if target_member_ids:
        await dispatch_notification(
            session, org_id=org_id, event_type="artifact.exported",
            target_member_ids=target_member_ids,
            title=f"산출물 export: {artifact.title}",
            body="PNG export가 완료됐습니다.",
            reference_type="visual_artifact", reference_id=artifact.id,
            source_project_id=project_id,
        )

    resp = await _export_response(session, export, version_number, container=container)
    return _ok(resp.model_dump(mode="json"), status=201)


@router.post("/{id}/versions/{version_number}/export/html", status_code=201)
async def create_html_export(
    id: uuid.UUID,
    version_number: int,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """self-contained HTML export — 렌더 불요(nodes 트리를 BE가 직렬화), client-trust 이슈 없어
    즉시 put_object(유나 UX②: as-authored — 별도 재테마 없이 저장된 props 그대로 직렬화)."""
    from app.services.storage import get_storage_provider

    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    version = await _get_version_or_404(session, artifact.id, version_number)
    if version is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)

    node_rows = (await session.execute(
        select(ArtifactNode).where(ArtifactNode.version_id == version.id).order_by(ArtifactNode.sort_order)
    )).scalars().all()
    html = _render_self_contained_html(artifact.title, node_rows)
    html_bytes = html.encode("utf-8")

    container = _export_container()
    object_path = _export_object_path(org_id, project_id, artifact.id, "html")
    ok = await get_storage_provider().put_object(
        container, object_path, html_bytes, content_type="text/html; charset=utf-8",
    )
    if not ok:
        return _err("STORAGE_ERROR", "HTML export 업로드 실패", 500)

    created_by = uuid.UUID(auth.user_id)
    asset_id = await _upsert_export_asset(
        session, org_id=org_id, project_id=project_id, object_path=object_path,
        name=f"{artifact.title}-v{version_number}.html", content_type="text/html; charset=utf-8",
        size_bytes=len(html_bytes), created_by=created_by,
    )
    export = ArtifactExport(
        id=uuid.uuid4(), artifact_id=artifact.id, version_id=version.id, format="html",
        asset_id=asset_id, created_by=created_by,
    )
    session.add(export)
    await session.flush()
    await session.refresh(export)

    target_member_ids = list({artifact.created_by} - {created_by}) if artifact.created_by else []
    if target_member_ids:
        await dispatch_notification(
            session, org_id=org_id, event_type="artifact.exported",
            target_member_ids=target_member_ids,
            title=f"산출물 export: {artifact.title}",
            body="HTML export가 완료됐습니다.",
            reference_type="visual_artifact", reference_id=artifact.id,
            source_project_id=project_id,
        )

    resp = await _export_response(session, export, version_number, container=container)
    return _ok(resp.model_dump(mode="json"), status=201)


def _render_self_contained_html(title: str, nodes: list[ArtifactNode]) -> str:
    """nodes 트리를 as-authored 그대로 직렬화한 self-contained HTML(외부 리소스 참조 0).
    html_blob 노드는 props.html을 그대로 삽입(임포트 raw HTML 계승), 그 외는 최소 wrapper."""
    import html as _html_mod
    import json as _json

    parts: list[str] = [
        "<!doctype html>", "<html>", "<head>",
        f"<meta charset=\"utf-8\"><title>{_html_mod.escape(title)}</title>",
        "</head>", "<body>",
    ]
    for n in sorted(nodes, key=lambda x: x.sort_order):
        if n.type == "html_blob":
            parts.append(str(n.props.get("html", "")))
        else:
            data_props = _html_mod.escape(_json.dumps(n.props, ensure_ascii=False))
            parts.append(
                f"<div data-node-type=\"{_html_mod.escape(n.type)}\" data-node-props=\"{data_props}\">"
                f"</div>"
            )
    parts.append("</body></html>")
    return "\n".join(parts)


@router.get("/{id}/exports")
async def list_artifact_exports(
    id: uuid.UUID,
    version_number: int | None = Query(default=None),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)

    q = select(ArtifactExport, ArtifactVersion.version_number).join(
        ArtifactVersion, ArtifactExport.version_id == ArtifactVersion.id,
    ).where(ArtifactExport.artifact_id == artifact.id).order_by(ArtifactExport.created_at.desc())
    if version_number is not None:
        q = q.where(ArtifactVersion.version_number == version_number)
    rows = (await session.execute(q)).all()

    container = _export_container()
    results = [
        (await _export_response(session, export, vn, container=container)).model_dump(mode="json")
        for export, vn in rows
    ]
    return _ok(results)


# ─── Edit (E-CANVAS C3-S7, story 940266db) ────────────────────────────────────
# crux: 휴먼 딸깍(REST)과 에이전트 MCP(POST 동일 엔드포인트)가 **같은 서비스 경로**를 경유해
# "같은 객체를 양쪽이 편집"을 보장한다(서로 다른 코드 경로면 drift 위험). 버전은 무-mutate
# 원칙(C1-S3) 계승 — 편집은 항상 새 버전을 만든다. ⚠️ node id는 버전 간 안정하지 않다
# (ArtifactNode.id가 테이블 전역 PK라 버전마다 독립 row=새 id 필수 — C1-S3의 "버전마다 자기
# 소유 node row 세트" 설계와 정합). update/delete op은 편집 시점 최신 버전의 id로 대상만
# 지정하고, 응답으로 돌아오는 새 id를 다음 편집에 사용한다.


async def _apply_artifact_edit(
    session: AsyncSession, artifact: VisualArtifact, operations: list[ArtifactNodeOperation],
    *, actor_id: uuid.UUID, summary: str | None, source_comment_id: uuid.UUID | None = None,
) -> ArtifactVersion:
    latest = await _get_version_or_404(session, artifact.id, artifact.latest_version_number)
    if latest is None:
        raise ValueError("latest version not found — artifact 상태 비정상")

    existing_rows = (await session.execute(
        select(ArtifactNode).where(ArtifactNode.version_id == latest.id)
    )).scalars().all()
    working: dict[uuid.UUID, dict] = {
        n.id: {
            "type": n.type, "props": n.props, "parent_id": n.parent_id,
            "sort_order": n.sort_order, "description": n.description,
        }
        for n in existing_rows
    }

    for op in operations:
        if op.op == "add":
            new_id = op.id or uuid.uuid4()
            working[new_id] = {
                "type": op.type or "text", "props": op.props or {}, "parent_id": op.parent_id,
                "sort_order": op.sort_order or 0, "description": op.description,
            }
        elif op.op == "update":
            if op.id is None or op.id not in working:
                raise ValueError(f"update 대상 node를 찾을 수 없습니다: {op.id}")
            node = working[op.id]
            if op.type is not None:
                node["type"] = op.type
            if op.props is not None:
                node["props"] = op.props
            if op.parent_id is not None:
                node["parent_id"] = op.parent_id
            if op.sort_order is not None:
                node["sort_order"] = op.sort_order
            if op.description is not None:
                node["description"] = op.description
        elif op.op == "delete":
            if op.id is None:
                raise ValueError("delete op에는 id가 필요합니다")
            working.pop(op.id, None)

    new_version_number = artifact.latest_version_number + 1
    new_version = ArtifactVersion(
        id=uuid.uuid4(), artifact_id=artifact.id, version_number=new_version_number,
        created_by=actor_id, summary=summary, source_comment_id=source_comment_id,
    )
    session.add(new_version)
    await session.flush()

    # ⚠️ ArtifactNode.id는 테이블 전역 PK다(버전별 복합키 아님) — C1-S3 "버전마다 자기 소유
    # node row 세트" 설계상 매 버전은 독립 row 집합이라 이전 버전의 id를 재사용하면 PK 충돌.
    # working 딕셔너리 키(현재 버전 id)는 연산 매칭(update/delete 대상 지정)에만 쓰고, 실제
    # INSERT는 새 id로 한다 — parent_id가 "같은 편집에서 새로 추가된 부모"를 가리키면 그 새
    # id로 리매핑(트리 구조 보존), 그 외(이전 버전에 이미 있던 parent)는 parent_id를 그대로
    # 둔다(과거 버전 트리 참조는 새 버전에서 무의미하므로 앱 레이어가 무시·FE는 매 버전 응답의
    # nodes[]를 그대로 신뢰).
    id_remap: dict[uuid.UUID, uuid.UUID] = {old_id: uuid.uuid4() for old_id in working}
    for old_id, data in working.items():
        parent_id = data["parent_id"]
        remapped_parent_id = id_remap.get(parent_id, parent_id) if parent_id is not None else None
        session.add(ArtifactNode(
            id=id_remap[old_id], artifact_id=artifact.id, version_id=new_version.id,
            type=data["type"], props=data["props"], parent_id=remapped_parent_id,
            sort_order=data["sort_order"], description=data["description"],
        ))

    artifact.latest_version_number = new_version_number
    await session.flush()
    return new_version


async def _notify_artifact_updated(
    session: AsyncSession, artifact: VisualArtifact, *, org_id: uuid.UUID, project_id: uuid.UUID,
    editor_id: uuid.UUID,
) -> None:
    """AC③: 어느 쪽 수정이든(휴먼/에이전트) artifact.updated 이벤트가 상대에게 도달 — 대상=
    artifact 생성자(편집자 본인 제외). C2-S6 comment.created 전파와 동형 패턴."""
    target_member_ids = list({artifact.created_by} - {editor_id}) if artifact.created_by else []
    if target_member_ids:
        await dispatch_notification(
            session, org_id=org_id, event_type="artifact.updated",
            target_member_ids=target_member_ids,
            title=f"산출물 수정됨: {artifact.title}",
            body="artifact가 새 버전으로 갱신됐습니다.",
            reference_type="visual_artifact", reference_id=artifact.id,
            source_project_id=project_id,
        )


@router.post("/{id}/edit", status_code=201)
async def edit_artifact(
    id: uuid.UUID,
    body: EditArtifactRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """딸깍 편집(FE) + MCP 편집(에이전트) 공용 엔드포인트 — 요소 add/update/delete를 적용해
    새 버전을 만든다(무-mutate 버전 원칙 계승)."""
    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)

    if body.source_comment_id is not None:
        # 결과 연결도 cross-artifact 위조 차단(오늘 계열 SEC 원칙 동형) — 남의 artifact
        # 코멘트를 내 편집 결과로 링크할 수 없음. 403(검증 오류 422와 구분되는 인가 축).
        comment_owner = (await session.execute(
            select(ArtifactComment.artifact_id).where(ArtifactComment.id == body.source_comment_id)
        )).scalar_one_or_none()
        if comment_owner != artifact.id:
            return _err("FORBIDDEN", "source_comment_id가 이 artifact 소속이 아닙니다", 403)

    actor_id = uuid.UUID(auth.user_id)
    try:
        new_version = await _apply_artifact_edit(
            session, artifact, body.operations, actor_id=actor_id, summary=body.summary,
            source_comment_id=body.source_comment_id,
        )
    except ValueError as exc:
        return _err("INVALID_OPERATION", str(exc), 422)

    await _notify_artifact_updated(session, artifact, org_id=org_id, project_id=project_id, editor_id=actor_id)

    detail = await _load_detail(session, artifact, new_version.version_number)
    if detail is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)
    return _ok(detail.model_dump(mode="json"), status=201)


# ─── Canonicalize (E-CANVAS C4-S8, story a5118cb0) ────────────────────────────
# crux(유나 handoff `e-canvas-c4-canonical-handoff`): 정본화 = 합의된 계약(§1, 감시 관문 아님).
# 기존 E-DG Decision Gate 재사용(신규 게이트 발명 금지) — 제안(이 엔드포인트)이 Gate를 만들고,
# 승인/반려는 **기존 범용** `POST /api/v2/gates/{id}/transition`이 처리(human-only authz 이미
# 강제됨). 여기서는 gate_service._resolve_artifact_canonicalize_gate가 해소를 anchor_version
# set(승인)/재논의 코멘트(반려)로 연결.


@router.post("/{id}/versions/{version_number}/canonicalize", status_code=201)
async def propose_canonical_version(
    id: uuid.UUID,
    version_number: int,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """정본으로 제안 — AI는 제안만(MCP도 동일 엔드포인트), 승인은 always-HITL(gate_service).
    이미 pending 제안이 있으면 멱등(create_gate 자체 멱등 재사용)."""
    from app.services.gate_service import create_gate

    org_id, project_id = _get_org_project(auth)
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    version = await _get_version_or_404(session, artifact.id, version_number)
    if version is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)

    proposer_id = uuid.UUID(auth.user_id)
    gate = await create_gate(
        session, org_id, artifact.id, "visual_artifact", "artifact_canonicalize",
        proposer_id, uuid.uuid4(),  # role_id: always-manual이라 disposition 미사용(placeholder)
        neutral_facts={
            "version_number": version_number, "requested_by_member_id": str(proposer_id),
            "artifact_title": artifact.title,
        },
    )
    await session.commit()
    return _ok({
        "gate_id": str(gate.id), "status": gate.status,
        "artifact_id": str(artifact.id), "version_number": version_number,
    }, status=201)
