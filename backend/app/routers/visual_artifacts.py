from __future__ import annotations

import base64
import binascii
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_scope_context, get_scope_context_no_key_scope_check
from app.dependencies.database import get_db
from app.models.asset import Asset
from app.services.artifact_image_url import _canonicalize_props, sign_image_srcs_in_nodes
from app.services.asset_registry import DEFAULT_CONTAINER
from app.services.storage import get_storage_provider
from app.models.visual_artifact import (
    ArtifactComment, ArtifactExport, ArtifactNode, ArtifactSpecPin, ArtifactVersion, VisualArtifact,
)
from app.schemas.visual_artifact import (
    ArtifactCommentResponse,
    ArtifactExportResponse,
    ArtifactNodeIn,
    ArtifactNodeOperation,
    ArtifactNodeOut,
    ArtifactVersionSummary,
    CanvasBounds,
    CompleteExportRequest,
    CreateArtifactCommentRequest,
    CreateArtifactRequest,
    CreateSpecPinRequest,
    EditArtifactRequest,
    ExportUploadUrlRequest,
    ExportUploadUrlResponse,
    ImportImageArtifactRequest,
    SpecPinResponse,
    UpdateSpecPinRequest,
    VisualArtifactDetail,
    VisualArtifactSummary,
)
from app.services.member_resolver import filter_org_member_ids
from app.services.notification_dispatch import dispatch_notification
from app.services.project_auth import assert_target_in_caller_org

# story 64010b05 FE 라우트(apps/web import-image/route.ts)와 동일 상수(포팅판 — 20MB, 첨부
# 100MB보다 보수적). 이 파일 안에서만 쓰는 로컬 상수라 GCS host 문자열도 artifact_image_url.py/
# asset_registry.py와 같은 값을 여기 한 번 더 든다(이 두 파일의 기존 중복 관례 그대로 — 새 SSOT
# 발명 0).
_MAX_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024
_GCS_HOST = "storage.googleapis.com"

router = APIRouter(prefix="/api/v2/visual-artifacts", tags=["visual-artifacts", "Work"])


def _ok(data: object, status: int = 200, meta: dict | None = None) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": meta}, status_code=status)


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


# story #2708(2026-08-17, 페드루 PO 판정) — _get_org_project(auth) 헬퍼를 걷어냈다. 그 헬퍼는
# auth.claims의 JWT app_metadata.project_id만 읽어 X-Project-Id 헤더를 아예 몰랐다(파라미터로도
# 안 받음) — 브라우저가 현재 보고 있는 프로젝트와 무관하게 JWT에 구워진(다른/기본) project_id로
# 조용히 스코프해, 아티팩트 갤러리가 실재 60+건을 두고 「No artifacts collected yet」로 빈
# 화면을 보였다(원 인시던트, 유나 라이브 판별). 이 파일 19곳 전부가 같은 헬퍼를 썼다 — 판정을
# 한 곳(get_scope_context, auth.py)으로 통일한다(들쭉날쭉 금지 원칙, story 22caa39b와 동형).
#
# get_scope_context()는 내부에서 get_verified_org_id(x_project_id=...)를 거치므로 헤더로 지정한
# 프로젝트가 has_project_access(team_member ∪ grant ∪ owner/admin)로 **이미 멤버십 검증**된다
# (auth.py get_verified_org_id 참조) — 헤더를 열어주는 대신 IDOR을 새로 여는 일은 없다. 19곳
# 전부 `scope: dict = Depends(get_scope_context)`를 받아 `scope["org_id"]`/`scope["project_id"]`로
# 읽는다(MCP/API키 경로는 x_project_id 헤더가 없으므로 기존처럼 키에 구운 JWT project_id가
# 그대로 이김 — get_scope_context 내부 `jwt_project_id or x_project_id` 순서 그대로).


_LINK_TABLES = {"story_id": "stories", "epic_id": "goals", "doc_id": "docs"}


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


async def _notify_artifact_created(
    session: AsyncSession, artifact: VisualArtifact, *, org_id: uuid.UUID, project_id: uuid.UUID,
    creator_id: uuid.UUID,
) -> None:
    """§F4(이벤트 없는 기능 금지) 갭 봉인(story 04e059e5·미르코 그라운딩 PR #2119): create만
    dispatch_notification이 누락돼 있었다(edit/comment/export는 이미 전파). edit/comment 패턴
    ("생성자 - 편집자")은 여기 적용 불가(생성 시점엔 "이미 알고 있던 이전 당사자"가 없음) — 대신
    ①생성자 본인(자기 알림 — done-gate 라이브 실증이 자기 생성→자기 웹훅 도달을 검증하므로 제외
    하면 테스트 불가) ②연결된 story/epic/doc의 assignee(있으면·창작자와 다르면 타 사용자 도달,
    story/epic/doc 셋 다 assignee_id 컬럼 보유 확인)로 대상을 구성한다."""
    target_member_ids: set[uuid.UUID] = {creator_id}
    for field, table in _LINK_TABLES.items():
        link_id = getattr(artifact, field)
        if link_id is None:
            continue
        row = (await session.execute(
            text(f"SELECT assignee_id FROM {table} WHERE id = :id"),  # noqa: S608 — table은 고정 allowlist(_LINK_TABLES), 요청값 아님
            {"id": link_id},
        )).first()
        if row is not None and row.assignee_id is not None:
            target_member_ids.add(row.assignee_id)

    await dispatch_notification(
        session, org_id=org_id, event_type="artifact.created",
        target_member_ids=list(target_member_ids),
        title=f"새 산출물 생성됨: {artifact.title}",
        body="새 시각 산출물이 생성됐습니다.",
        reference_type="visual_artifact", reference_id=artifact.id,
        source_project_id=project_id,
        # story #2696: outbox 이관(동일 결함 클래스 예방).
        via_outbox=True,
    )


@router.post("", status_code=201)
async def create_artifact(
    body: CreateArtifactRequest,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    await _assert_link_target_in_scope(session, org_id, project_id, body)

    created_by = uuid.UUID(auth.user_id)
    # 뷰어 통합 재설계(story 1948d19d): canvas_bounds SSOT=버전(아래 version.canvas_bounds).
    # artifact.canvas_bounds는 latest_version_number와 동형 denorm 캐시 — 항상 최신 버전과 동기화.
    canvas_bounds_dict = body.canvas_bounds.model_dump() if body.canvas_bounds else None
    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=body.title,
        story_id=body.story_id, epic_id=body.epic_id, doc_id=body.doc_id,
        source=body.source, latest_version_number=1, created_by=created_by,
        canvas_bounds=canvas_bounds_dict,
    )
    session.add(artifact)
    await session.flush()

    version = ArtifactVersion(
        id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=created_by,
        summary=body.summary, canvas_bounds=canvas_bounds_dict,
    )
    session.add(version)
    await session.flush()

    nodes: list[ArtifactNode] = []
    for n in body.nodes:
        node = ArtifactNode(
            id=n.id or uuid.uuid4(), artifact_id=artifact.id, version_id=version.id,
            type=n.type, props=_canonicalize_props(n.props), parent_id=n.parent_id,
            sort_order=n.sort_order, description=n.description,
        )
        session.add(node)
        nodes.append(node)
    await session.flush()

    await _notify_artifact_created(session, artifact, org_id=org_id, project_id=project_id, creator_id=created_by)

    node_outs = [ArtifactNodeOut.model_validate(n) for n in nodes]
    await sign_image_srcs_in_nodes(node_outs)  # story #2711 AC1 — 응답 직전 신선 서명(url 미저장)

    detail = VisualArtifactDetail(
        id=artifact.id, org_id=artifact.org_id, project_id=artifact.project_id, title=artifact.title,
        story_id=artifact.story_id, epic_id=artifact.epic_id, doc_id=artifact.doc_id,
        source=artifact.source, latest_version_number=artifact.latest_version_number,
        anchor_version=artifact.anchor_version,
        created_by=artifact.created_by, created_at=artifact.created_at, updated_at=artifact.updated_at,
        version_number=version.version_number, version_summary=version.summary,
        version_source_comment_id=version.source_comment_id, canvas_bounds=version.canvas_bounds,
        nodes=node_outs,
    )
    return _ok(detail.model_dump(mode="json"), status=201)


@router.post("/import-image", status_code=201)
async def import_image_artifact(
    body: ImportImageArtifactRequest,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """story b6b9c52d(#2707 부수) — MCP `sprintable_import_image_artifact` 전용 원콜 입구
    (base64 in → artifact out). FE import-image 라우트(story 64010b05, apps/web
    api/visual-artifacts/import-image/route.ts)의 서버사이드 GCS 업로드 로직을 포팅하고, 그 뒤를
    이어 `create_artifact()`를 내부 함수 호출로 그대로 재사용(DB write 로직 사본 발명 0 — 두
    갈래가 다시 어긋나면 create_artifact 한쪽만 고치고 여기를 잊는 사고가 난다는 뜻이니, 이
    엔드포인트를 건드릴 땐 그 함수도 같이 봐야 한다)."""
    if not body.content_type.startswith("image/"):
        return _err("VALIDATION_ERROR", "content_type must be an image/* type", 400)
    try:
        image_bytes = base64.b64decode(body.image_base64, validate=True)
    except (binascii.Error, ValueError):
        return _err("VALIDATION_ERROR", "image_base64 is not valid base64", 400)
    if len(image_bytes) > _MAX_IMPORT_IMAGE_BYTES:
        return _err("VALIDATION_ERROR", "image too large (max 20MB)", 413)

    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    safe_title = re.sub(r"[^\w.-]+", "_", body.title).strip("_")[:128] or "image"
    object_path = f"org/{org_id}/project/{project_id}/canvas-import/{uuid.uuid4()}-{safe_title}"
    uploaded = await get_storage_provider().put_object(
        DEFAULT_CONTAINER, object_path, image_bytes, content_type=body.content_type,
    )
    if not uploaded:
        return _err("UPSTREAM_ERROR", "image upload failed", 502)

    canonical_url = f"https://{_GCS_HOST}/{DEFAULT_CONTAINER}/{object_path}"
    create_body = CreateArtifactRequest(
        title=body.title, story_id=body.story_id, doc_id=body.doc_id, source="imported",
        nodes=[ArtifactNodeIn(type="html_blob", props={"src": canonical_url})],
    )
    return await create_artifact(create_body, auth=auth, scope=scope, session=session)


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


async def _count_unresolved_comments(
    session: AsyncSession, artifact_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    """story #2262 AC9②(PO 판정 2026-07-29): visual_artifact는 status 컬럼이 없다 — 「미결」이
    유일한 «다음 발» 재료(§②). 단위는 코멘트(root+reply 전부) — 스레드는 제품에 없는 개념이라
    (reply도 POST .../comments/{id}/resolve로 개별 resolve됨) 지어내지 않는다(오르테가 확정,
    필드명 `unresolved_comment_count`가 그 단위를 그대로 말한다).

    N+1 방지(#2619와 동형) — 호출자가 artifact_id 여러 개를 한 번에 넘기면 쿼리 1회로 전부
    해소한다(list_artifacts가 artifact마다 따로 왕복하지 않는다). 반환에 없는 id는 0건으로
    취급한다(호출자 책임 — fetch_stored_references와 동일 계약).

    ⛔스코프: artifact_id로만 필터한다 — org_id/project_id는 안 건다. artifact_comments가
    호출자의 org/project 안에서 이미 소유권 검증된 artifact_id 집합(`_get_artifact_or_404`·
    list_artifacts의 org_id/project_id where절)에서만 나오므로, 여기서 다시 걸면 이중 검증일
    뿐이다 — 그러나 **호출자가 이 함수에 넘기는 artifact_ids 자체가 이미 그 검증을 거친
    것이어야 한다**는 불변식이 이 함수 밖에 있다(계약 위반 시 이 함수가 아니라 호출부가
    새는 자리)."""
    if not artifact_ids:
        return {}
    rows = (await session.execute(
        select(ArtifactComment.artifact_id, func.count())
        # ⛔뮤테이션 자가검증(#2623)으로 실측: 이 `.in_(artifact_ids)`를 지워도 아래
        # `.group_by(ArtifactComment.artifact_id)`가 코멘트를 자기 artifact_id로만 묶어 주므로
        # 다른 artifact의 미해결 코멘트가 섞여 들지 않는다(6/6 GREEN 유지 — 격리를 보장하는
        # 것은 이 필터가 아니라 GROUP BY다). 그래도 지우지 않는 이유: 이 필터가 없으면 매
        # 호출마다 **org 전체**(다른 org 포함) artifact_comments를 스캔·집계한 뒤 파이썬에서
        # 필요한 id만 골라내는 꼴이 된다 — 스코프 축소(성능)가 이 줄의 실제 역할이지, 격리는
        # 아니다. "성능 최적화라 지워도 안전"으로 읽지 말 것 — 안전은 유지되지만 스캔 범위가
        # org 전체로 커진다.
        .where(ArtifactComment.artifact_id.in_(artifact_ids), ArtifactComment.resolved.is_(False))
        .group_by(ArtifactComment.artifact_id)
    )).all()
    return {artifact_id: count for artifact_id, count in rows}


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
    unresolved_counts = await _count_unresolved_comments(session, [artifact.id])
    # story #2642: org_id/project_id는 artifact 자기 행에 이미 있어(부모 hop 불필요) 여기서
    # 바로 slug 조회 — 이 함수는 항상 단건 artifact 1개로만 불려(3개 호출부 전부 루프 아님)
    # N+1 걱정 없이 요청당 2쿼리(#2168 DocPreviewResponse와 동형 비용).
    from app.services.entity_slug import resolve_org_slug, resolve_project_slugs

    org_slug = await resolve_org_slug(session, artifact.org_id)
    project_slug_map = await resolve_project_slugs(session, {artifact.project_id})
    node_outs = [ArtifactNodeOut.model_validate(n) for n in node_rows]
    await sign_image_srcs_in_nodes(node_outs)  # story #2711 AC1 — 응답 직전 신선 서명(url 미저장)
    return VisualArtifactDetail(
        id=artifact.id, org_id=artifact.org_id, project_id=artifact.project_id, title=artifact.title,
        story_id=artifact.story_id, epic_id=artifact.epic_id, doc_id=artifact.doc_id,
        source=artifact.source, latest_version_number=artifact.latest_version_number,
        anchor_version=artifact.anchor_version,
        created_by=artifact.created_by, created_at=artifact.created_at, updated_at=artifact.updated_at,
        version_number=version.version_number, version_summary=version.summary,
        version_source_comment_id=version.source_comment_id, canvas_bounds=version.canvas_bounds,
        nodes=node_outs,
        unresolved_comment_count=unresolved_counts.get(artifact.id, 0),
        org_slug=org_slug, project_slug=project_slug_map.get(artifact.project_id),
    )


@router.get("/preview")
async def get_artifact_preview(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """story #3208 — 아티팩트 직URL/채팅 임베드가 호출자의 «현재» project_id로만
    스코프된 `GET /{id}`(SEC-S8, project_id 필수 필터)에 의존하다 보니, 다른 프로젝트를
    보던 중 링크를 열면 대상이 실재해도 project_id 불일치로 404였다(`docs.py::
    get_doc_preview`와 동형 갭 — #2168이 doc에서 이미 고친 그 문제).

    처방도 doc과 동형: **org 스코프로만** 먼저 찾고, 그 artifact가 실제로 속한
    project에 대해 `has_project_access`로 **진짜 접근권**을 검증한 뒤에만 위치정보
    (project_id·org_slug·project_slug)를 내준다 — org 멤버라고 무조건 열어주면
    SEC-S8이 막은 것과 같은 계열의 IDOR이 되므로, project_id 필터를 없애는 게 아니라
    "어느 project인지 먼저 알아낸 뒤 그 project 접근권을 확認"으로 순서를 바꾼 것뿐이다
    (본문은 안 실어 나른다 — 위치만, 실제 상세는 여전히 `GET /{id}`가 그 project_id로
    스코프해 낸다).

    무권한/미존재는 404로 통일(존재 비노출 규율, doc과 동일 — story #2322/#2342)."""
    from app.services.entity_slug import resolve_org_slug, resolve_project_slugs
    from app.services.project_auth import has_project_access

    org_id = scope["org_id"]
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    artifact = (await session.execute(
        select(VisualArtifact).where(
            VisualArtifact.id == id, VisualArtifact.org_id == org_id,
            VisualArtifact.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    if not await has_project_access(session, uuid.UUID(auth.user_id), artifact.project_id, org_id):
        return _err("NOT_FOUND", "Artifact not found", 404)

    org_slug = await resolve_org_slug(session, artifact.org_id)
    project_slug_map = await resolve_project_slugs(session, {artifact.project_id})
    return _ok({
        "id": str(artifact.id),
        "project_id": str(artifact.project_id),
        "org_slug": org_slug,
        "project_slug": project_slug_map.get(artifact.project_id),
    })


@router.get("/{id}")
async def get_artifact(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    detail = await _load_detail(session, artifact, artifact.latest_version_number)
    if detail is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)
    return _ok(detail.model_dump(mode="json"))


@router.get("/{id}/backlinks")
async def get_artifact_backlinks(
    id: uuid.UUID,
    limit: int = Query(default=30, ge=1, le=200),
    before: str | None = Query(default=None),
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """GET /api/v2/visual-artifacts/{id}/backlinks — story #2721(아티팩트 원장 1급화 1단).
    이 artifact를 가리키는 chat_message/doc/story 목록(역방향) — stories.py의
    get_story_backlinks와 동형(`list_entity_backlinks` 코어 그대로 재사용, 새 쿼리 발명 0).
    TARGET 접근 게이트는 이 파일 기존 관례인 `_get_artifact_or_404`(org_id+project_id 404,
    story #2266 §8①이 요구하는 "호출부가 TARGET 접근을 이미 검증" 계약 충족).

    WRITE(entity_references에 target_type=artifact 저장)는 이미 배선돼 있었다(reference_
    registry.ENTITY_RESOLVERS에 artifact가 이미 등재 — 그라운딩 실PG 실증) — 이 엔드포인트가
    이 스토리의 유일한 신규 로직이다. 이 파일 다른 GET들과 동형으로 `get_scope_context_no_key_
    scope_check`(read 전용 — story #2708 판정) 사용."""
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)

    from app.services.backlinks import list_entity_backlinks
    result = await list_entity_backlinks(
        session, org_id=org_id, target_type="artifact", target_id=id,
        auth=auth, limit=limit, cursor=before,
    )
    return _ok(result["data"], meta=result["meta"])


@router.get("/{id}/versions")
async def list_artifact_versions(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    rows = (await session.execute(
        select(ArtifactVersion).where(ArtifactVersion.artifact_id == id)
        .order_by(ArtifactVersion.version_number.desc())
    )).scalars().all()
    # canvas_bounds는 이제 ArtifactVersion 실 컬럼(story 1948d19d §4 확定 — 버전 단위 SSOT)이라
    # model_validate(from_attributes)가 그대로 픽업 — 별도 세팅 불요.
    return _ok([ArtifactVersionSummary.model_validate(r).model_dump(mode="json") for r in rows])


@router.get("/{id}/versions/{version_number}")
async def get_artifact_version(
    id: uuid.UUID,
    version_number: int,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """무-mutate 버전 조회 — 미르코 §6-1 갭 지적 대응(mockup은 restore=즉시 라이브 덮어씀)."""
    org_id, project_id = scope["org_id"], scope["project_id"]
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
    ids: str | None = Query(default=None, description="comma-separated artifact ids — 배치 앵커 조회(정확한 집합, ORDER BY/limit 무관, story #2262 PR② 칩 상태 배치조회)"),
    limit: int = Query(default=500, ge=1, le=1000),
    cursor: str | None = Query(default=None, description="ISO 8601 created_at, fetch before this time — 이전 페이지 meta.next_cursor 값 그대로"),
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """story #2428 PR④(ⓐ) — 예전엔 limit이 아예 없어 project 전체 artifact가 조용히 다
    나왔다(무제한 위험). docs.py list_docs와 동일 규약(정본 규약 A — limit+1 오버페치 +
    has_more/next_cursor body meta, `_doc_page_envelope` 참조) — 이 라우터는 stories.py/
    goals.py 계열의 X-Total-Count 헤더 봉투가 아니라 이미 `{data,error,meta}` 자체 봉투를
    쓰고 있어(위 `_ok`) 그 家族(docs.py)을 그대로 따른다(새 규약 발명 0). COUNT 쿼리 없이
    limit+1개만 더 읽어 판정하므로 base.py list_paginated()류의 «count에 cursor 누락»
    결함 클래스 자체가 구조적으로 없다."""
    # E-SECURITY SEC-S8(story 83ea3d6a) G(N): project_id 필터가 아예 없어 story_id/epic_id/
    # doc_id 미지정 호출(파라미터 없는 목록 조회)이 org 전체 artifact를 반환했다(cross-project
    # 노출·미르코 라이브 실측). create_artifact/get_artifact와 동형으로 JWT/API키 컨텍스트의
    # project_id(비-caller-suppliable)로 항상 스코프.
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)

    cursor_dt: datetime | None = None
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except (ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=400, detail="invalid cursor: expected ISO 8601 datetime"
            ) from exc

    q = select(VisualArtifact).where(
        VisualArtifact.org_id == org_id, VisualArtifact.project_id == project_id,
        VisualArtifact.deleted_at.is_(None),
    )
    # story #2262 PR②(칩 상태 배치조회) — stories.py list_stories의 ids= 패턴 미러링. 이
    # 라우터는 이미 caller 컨텍스트의 project_id로만 스코프하므로(위 SEC-S8 fix) 별도
    # accessible_project_ids_in_org 조회 없이 그 org_id/project_id WHERE에 IN을 더하면 된다.
    # 카디르 QA(PR#2905, 2026-08-07): Query(...) 기본값 센티널 함정(goals.py/docs.py와 동형) —
    # isinstance로 실제 str만 통과시킨다.
    if isinstance(ids, str):
        try:
            artifact_ids = [uuid.UUID(x) for x in ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid artifact id in ids")
        if not artifact_ids:
            return _ok([], meta={"has_more": False, "next_cursor": None})
        if len(artifact_ids) > 200:
            raise HTTPException(status_code=422, detail="too many ids (max 200)")
        q = q.where(VisualArtifact.id.in_(artifact_ids))
        rows = (await session.execute(q)).scalars().all()
        unresolved_counts = await _count_unresolved_comments(session, [r.id for r in rows])
        for r in rows:
            r.unresolved_comment_count = unresolved_counts.get(r.id, 0)
        return _ok(
            [VisualArtifactSummary.model_validate(r).model_dump(mode="json") for r in rows],
            meta={"has_more": False, "next_cursor": None},
        )
    if story_id is not None:
        q = q.where(VisualArtifact.story_id == story_id)
    if epic_id is not None:
        q = q.where(VisualArtifact.epic_id == epic_id)
    if doc_id is not None:
        q = q.where(VisualArtifact.doc_id == doc_id)
    if cursor_dt is not None:
        q = q.where(VisualArtifact.created_at < cursor_dt)
    q = q.order_by(VisualArtifact.created_at.desc()).limit(limit + 1)
    fetched = (await session.execute(q)).scalars().all()
    has_more = len(fetched) > limit
    rows = fetched[:limit]
    next_cursor = rows[-1].created_at.isoformat() if has_more and rows else None
    # story #2262 AC9②: 페이지 전체를 쿼리 1회로 해소(N+1 방지, #2619와 동형) — artifact마다
    # 따로 COUNT 왕복하지 않는다.
    unresolved_counts = await _count_unresolved_comments(session, [r.id for r in rows])
    for r in rows:
        r.unresolved_comment_count = unresolved_counts.get(r.id, 0)
    return _ok(
        [VisualArtifactSummary.model_validate(r).model_dump(mode="json") for r in rows],
        meta={"has_more": has_more, "next_cursor": next_cursor},
    )


@router.delete("/{id}")
async def delete_artifact(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """생성자만 삭제 가능(Evidence 패턴 계승 — "누가 주어인가"). soft delete."""
    org_id, project_id = scope["org_id"], scope["project_id"]
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
    cursor: str | None = Query(default=None, description="ISO 8601 created_at, fetch after this time — 이전 페이지 meta.next_cursor 값 그대로(오래된순 정렬이라 forward-cursor)"),
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """story #2428 PR④(ⓐ) — limit은 있었으나 total/has_more가 없어 잘렸는지 호출자가 알 수
    없었다(활발한 토론 스레드는 챗 스레드와 동형 무한성장 위험). list_artifacts와 동일하게
    limit+1 오버페치 + has_more/next_cursor body meta(docs.py 정본 규약 A) — 정렬이 오래된순
    (asc)이라 next_cursor는 "이 시각 이후"로 이어가는 forward cursor."""
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)

    cursor_dt: datetime | None = None
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except (ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=400, detail="invalid cursor: expected ISO 8601 datetime"
            ) from exc

    q = select(ArtifactComment).where(ArtifactComment.artifact_id == id)
    if cursor_dt is not None:
        q = q.where(ArtifactComment.created_at > cursor_dt)
    q = q.order_by(ArtifactComment.created_at.asc()).limit(limit + 1)
    fetched = (await session.execute(q)).scalars().all()
    has_more = len(fetched) > limit
    rows = fetched[:limit]
    next_cursor = rows[-1].created_at.isoformat() if has_more and rows else None
    return _ok(
        [ArtifactCommentResponse.model_validate(r).model_dump(mode="json") for r in rows],
        meta={"has_more": has_more, "next_cursor": next_cursor},
    )


@router.post("/{id}/comments", status_code=201)
async def add_artifact_comment(
    id: uuid.UUID,
    body: CreateArtifactCommentRequest,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
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
            # story #2696: outbox 이관(동일 결함 클래스 예방).
            via_outbox=True,
        )

    return _ok(ArtifactCommentResponse.model_validate(comment).model_dump(mode="json"), status=201)


@router.post("/{id}/comments/{comment_id}/resolve")
async def resolve_artifact_comment(
    id: uuid.UUID,
    comment_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
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


# ─── Spec pins (편집 캔버스 핀 저작, story 7fe16274) ──────────────────────────
# 그라운딩(디디): ArtifactComment(코멘트 핀)와 캔버스 핀 레이어를 공유하되(FE 시각 구분) 신설
# 엔티티로 분리 — 버전 스코프(carry-forward 필요)·스레드/resolve 없음·명시 anchor_type 판별자가
# 코멘트 모델과 근본적으로 달라 재사용 시 무의미한 컬럼이 방치됨(ArtifactSpecPin 클래스 docstring
# 참조). 스펙 핀은 항상 artifact의 **latest version**을 대상으로 조회/생성/수정/삭제한다(과거
# 버전의 핀은 그 버전 스냅샷으로 고정·불변 — carry-forward는 _apply_artifact_edit에서만 발생).


@router.get("/{id}/pins")
async def list_spec_pins(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    latest = await _get_version_or_404(session, artifact.id, artifact.latest_version_number)
    if latest is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)
    rows = (await session.execute(
        select(ArtifactSpecPin).where(ArtifactSpecPin.version_id == latest.id)
        .order_by(ArtifactSpecPin.created_at.asc())
    )).scalars().all()
    return _ok([SpecPinResponse.model_validate(r).model_dump(mode="json") for r in rows])


@router.post("/{id}/pins", status_code=201)
async def create_spec_pin(
    id: uuid.UUID,
    body: CreateSpecPinRequest,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    latest = await _get_version_or_404(session, artifact.id, artifact.latest_version_number)
    if latest is None:
        return _err("NOT_FOUND", "Artifact version not found", 404)

    if body.anchor_type == "node":
        # cross-artifact 위조 차단 동형(source_comment_id·comment.node_id 패턴) + node는 반드시
        # **latest version** 소속이어야 함(구버전 node는 이번 edit 스냅샷 밖 — carry-forward
        # id_remap 대상이 아니라 즉시 stale).
        node_owner = (await session.execute(
            select(ArtifactNode.artifact_id).where(
                ArtifactNode.id == body.node_id, ArtifactNode.version_id == latest.id,
            )
        )).scalar_one_or_none()
        if node_owner != artifact.id:
            return _err("NOT_FOUND", "Node not found on the artifact's latest version", 404)

    pin = ArtifactSpecPin(
        id=uuid.uuid4(), artifact_id=artifact.id, version_id=latest.id,
        anchor_type=body.anchor_type, anchor_x=body.anchor_x, anchor_y=body.anchor_y,
        node_id=body.node_id, description=body.description,
    )
    session.add(pin)
    await session.flush()
    return _ok(SpecPinResponse.model_validate(pin).model_dump(mode="json"), status=201)


async def _get_latest_spec_pin_or_404(
    session: AsyncSession, artifact: VisualArtifact, pin_id: uuid.UUID,
) -> ArtifactSpecPin | None:
    latest = await _get_version_or_404(session, artifact.id, artifact.latest_version_number)
    if latest is None:
        return None
    return (await session.execute(
        select(ArtifactSpecPin).where(
            ArtifactSpecPin.id == pin_id, ArtifactSpecPin.artifact_id == artifact.id,
            ArtifactSpecPin.version_id == latest.id,
        )
    )).scalar_one_or_none()


@router.patch("/{id}/pins/{pin_id}")
async def update_spec_pin(
    id: uuid.UUID,
    pin_id: uuid.UUID,
    body: UpdateSpecPinRequest,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    pin = await _get_latest_spec_pin_or_404(session, artifact, pin_id)
    if pin is None:
        return _err("NOT_FOUND", "Spec pin not found on the artifact's latest version", 404)
    pin.description = body.description
    await session.flush()
    return _ok(SpecPinResponse.model_validate(pin).model_dump(mode="json"))


@router.delete("/{id}/pins/{pin_id}")
async def delete_spec_pin(
    id: uuid.UUID,
    pin_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        return _err("FORBIDDEN", "org_id/project_id required", 403)
    artifact = await _get_artifact_or_404(session, org_id, project_id, id)
    if artifact is None:
        return _err("NOT_FOUND", "Artifact not found", 404)
    pin = await _get_latest_spec_pin_or_404(session, artifact, pin_id)
    if pin is None:
        return _err("NOT_FOUND", "Spec pin not found on the artifact's latest version", 404)
    await session.delete(pin)
    await session.flush()
    return _ok({"ok": True, "id": str(pin_id)})


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
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    from datetime import datetime, timedelta, timezone

    from app.services.storage import get_storage_provider

    org_id, project_id = scope["org_id"], scope["project_id"]
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
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    from app.services.storage import get_storage_provider

    org_id, project_id = scope["org_id"], scope["project_id"]
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

    # story #2906(선생님 확定 2026-08-21) — 이 export 경로는 sync_attachment_assets가 아니라
    # 별도 _upsert_export_asset(자체 ON CONFLICT)를 쓰는 두 번째 asset-생성 choke point라
    # check_storage_capacity가 애초에 안 걸려 있었다(그라운딩에서 발견된 진짜 갭 ②).
    # chat/story/doc 첨부와 동일 규율(ee seam·SaaS only·OSS no-op)로 upsert 直前에 건다.
    from app.core.config import settings

    if settings.is_ee_enabled:
        from ee.plan_limits import check_storage_capacity  # type: ignore[import]
        await check_storage_capacity(session, org_id, [{"url": body.object_path}])

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
            # story #2696: outbox 이관(동일 결함 클래스 예방).
            via_outbox=True,
        )

    resp = await _export_response(session, export, version_number, container=container)
    return _ok(resp.model_dump(mode="json"), status=201)


@router.post("/{id}/versions/{version_number}/export/html", status_code=201)
async def create_html_export(
    id: uuid.UUID,
    version_number: int,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """self-contained HTML export — 렌더 불요(nodes 트리를 BE가 직렬화), client-trust 이슈 없어
    즉시 put_object(유나 UX②: as-authored — 별도 재테마 없이 저장된 props 그대로 직렬화)."""
    from app.services.storage import get_storage_provider

    org_id, project_id = scope["org_id"], scope["project_id"]
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

    # story #2906 — PNG export와 동일 갭·동일 규율(위 complete_png_export 주석 참고).
    from app.core.config import settings

    if settings.is_ee_enabled:
        from ee.plan_limits import check_storage_capacity  # type: ignore[import]
        await check_storage_capacity(session, org_id, [{"url": object_path}])

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
            # story #2696: outbox 이관(동일 결함 클래스 예방).
            via_outbox=True,
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
    scope: dict = Depends(get_scope_context_no_key_scope_check),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id, project_id = scope["org_id"], scope["project_id"]
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
    canvas_bounds: CanvasBounds | None = None,
) -> ArtifactVersion:
    latest = await _get_version_or_404(session, artifact.id, artifact.latest_version_number)
    if latest is None:
        raise ValueError("latest version not found — artifact 상태 비정상")

    # 뷰어 통합 재설계(story 1948d19d): 프레임 크기는 버전 SSOT — 이번 edit에서 명시 재선언
    # 안 하면 직전 버전 값을 그대로 이어받는다(node가 그대로 복제 계승되는 것과 동형).
    new_canvas_bounds = canvas_bounds.model_dump() if canvas_bounds is not None else latest.canvas_bounds

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
                "type": op.type or "text", "props": _canonicalize_props(op.props or {}),
                "parent_id": op.parent_id, "sort_order": op.sort_order or 0,
                "description": op.description,
            }
        elif op.op == "update":
            if op.id is None or op.id not in working:
                raise ValueError(f"update 대상 node를 찾을 수 없습니다: {op.id}")
            node = working[op.id]
            if op.type is not None:
                node["type"] = op.type
            if op.props is not None:
                # story #2711 ⓑ — 클라가 get으로 받은 서명 url을 그대로 되보내는 왕복이
                # 가장 흔한 경로(에이전트가 노드를 읽고 다른 필드만 고쳐 되보낼 때 props는
                # 건드리지 않았어도 그대로 전달되는 경우 포함) — 여기서 반드시 raw로 되돌린다.
                node["props"] = _canonicalize_props(op.props)
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
        canvas_bounds=new_canvas_bounds,
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

    # 스펙 핀 carry-forward(story 7fe16274) — node와 동형 이유로 새 버전이 자기 소유 pin row
    # 세트를 갖는다. coord 앵커는 그대로 계승·node 앵커는 id_remap으로 재해석(reflow-safe).
    # 이번 edit에서 삭제된 노드를 가리키던 pin은 계승 안 함(no-fiction — 죽은 앵커를 이어가지
    # 않음, 조용히 drop).
    existing_pins = (await session.execute(
        select(ArtifactSpecPin).where(ArtifactSpecPin.version_id == latest.id)
    )).scalars().all()
    for pin in existing_pins:
        if pin.anchor_type == "node":
            new_node_id = id_remap.get(pin.node_id)
            if new_node_id is None:
                continue
            session.add(ArtifactSpecPin(
                id=uuid.uuid4(), artifact_id=artifact.id, version_id=new_version.id,
                anchor_type="node", node_id=new_node_id, description=pin.description,
            ))
        else:
            session.add(ArtifactSpecPin(
                id=uuid.uuid4(), artifact_id=artifact.id, version_id=new_version.id,
                anchor_type="coord", anchor_x=pin.anchor_x, anchor_y=pin.anchor_y,
                description=pin.description,
            ))

    artifact.latest_version_number = new_version_number
    artifact.canvas_bounds = new_canvas_bounds
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
            # story #2696: outbox 이관(동일 결함 클래스 예방).
            via_outbox=True,
        )


@router.post("/{id}/edit", status_code=201)
async def edit_artifact(
    id: uuid.UUID,
    body: EditArtifactRequest,
    auth: AuthContext = Depends(get_current_user),
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """딸깍 편집(FE) + MCP 편집(에이전트) 공용 엔드포인트 — 요소 add/update/delete를 적용해
    새 버전을 만든다(무-mutate 버전 원칙 계승)."""
    org_id, project_id = scope["org_id"], scope["project_id"]
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

    # 뷰어 통합 재설계(story 1948d19d): canvas_bounds는 버전 단위 SSOT — 무-mutate 버전 원칙대로
    # operations 없이 canvas_bounds만 와도(model_validator가 둘 다 없는 요청은 거름) 새 버전을
    # 만든다. 미지정 시 _apply_artifact_edit이 직전 버전 값을 이어받는다.
    try:
        new_version = await _apply_artifact_edit(
            session, artifact, body.operations, actor_id=actor_id, summary=body.summary,
            source_comment_id=body.source_comment_id, canvas_bounds=body.canvas_bounds,
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
    scope: dict = Depends(get_scope_context),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """정본으로 제안 — AI는 제안만(MCP도 동일 엔드포인트), 승인은 always-HITL(gate_service).
    이미 pending 제안이 있으면 멱등(create_gate 자체 멱등 재사용)."""
    from app.services.gate_service import create_gate

    org_id, project_id = scope["org_id"], scope["project_id"]
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
        project_id=project_id,
    )
    await session.commit()
    return _ok({
        "gate_id": str(gate.id), "status": gate.status,
        "artifact_id": str(artifact.id), "version_number": version_number,
    }, status=201)
