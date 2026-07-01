"""E-LOOP-LEDGER S3: /api/v2/loops 서비스 — CRUD(create/get/list). 블루프린트 §3 참고.

created_by_member_id는 client 입력이 아니라 caller(resolve_member)를 서버가 해소해 채운다
(hypotheses.created_by_member_id와 동일 컨벤션 — services/hypothesis.py 참고).
project 접근 인가는 project_auth.has_project_access(SSOT)를 단일 경로로 사용한다
(docs.py의 _require_doc_project_access와 동형 — org-scope 로드 후 project 접근 검증).
"""
from __future__ import annotations

import itertools
import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset, AssetLink
from app.models.loop import LoopArtifact, LoopRun
from app.repositories.loop import LoopArtifactRepository, LoopRunRepository
from app.schemas.loop import (
    LoopArtifactCreate,
    LoopArtifactResponse,
    LoopArtifactVariantGroup,
    LoopCreate,
    LoopResponse,
)
from app.services.member_resolver import ResolvedMember
from app.services.project_auth import has_project_access


class LoopServiceError(Exception):
    """도메인 오류 — 라우터가 code/message를 HTTPException dict-detail로 매핑한다."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _require_loop_project_access(
    session: AsyncSession, loop_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID
) -> LoopRun:
    """GET-by-id의 canonical project-scope authz. docs._require_doc_project_access와 동형:
    org-scope로 대상을 로드(없으면 404) → has_project_access로 그 loop의 project 접근을
    검증(무권한이면 403). id+org만으로 잡는 cross-project IDOR을 차단한다."""
    repo = LoopRunRepository(session, org_id)
    loop = await repo.get(loop_id)
    if loop is None:
        raise LoopServiceError("LOOP_NOT_FOUND", "루프를 찾을 수 없습니다.")
    if not await has_project_access(session, user_id, loop.project_id, org_id):
        raise LoopServiceError("LOOP_PROJECT_ACCESS_DENIED", "해당 루프의 프로젝트 접근 권한이 없습니다.")
    return loop


async def create_loop(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    payload: LoopCreate,
) -> LoopResponse:
    # resolve_member(project_id=...)가 이미 호출부(라우터)에서 caller의 project 접근을
    # 검증했으므로 여기서는 재검증하지 않는다(hypotheses.create_hypothesis와 동형).
    repo = LoopRunRepository(session, org_id)
    loop = await repo.create(
        project_id=payload.project_id,
        title=payload.title,
        hypothesis_id=payload.hypothesis_id,
        parent_loop_id=payload.parent_loop_id,
        recipe_slug=payload.recipe_slug,
        goal_tags=payload.goal_tags,
        status="draft",
        created_by_member_id=caller.id,
    )
    return LoopResponse.model_validate(loop)


async def get_loop(
    session: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID, loop_id: uuid.UUID
) -> LoopResponse:
    loop = await _require_loop_project_access(session, loop_id, user_id, org_id)
    return LoopResponse.model_validate(loop)


async def list_loops(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    *,
    status: str | None = None,
    parent_loop_id: uuid.UUID | None = None,
    goal_tag: str | None = None,
    limit: int = 100,
) -> list[LoopResponse]:
    repo = LoopRunRepository(session, org_id)
    rows = await repo.list_filtered(
        project_id=project_id,
        status=status,
        parent_loop_id=parent_loop_id,
        goal_tag=goal_tag,
        limit=limit,
    )
    return [LoopResponse.model_validate(r) for r in rows]


async def create_loop_artifact(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    loop: LoopRun,
    payload: LoopArtifactCreate,
) -> LoopArtifactResponse:
    """S4: 기존 asset을 loop의 variant 후보로 등록. loop project 접근은 호출부(라우터)의
    resolve_member(project_id=loop.project_id)가 선행 검증(root-fix #1815로 agent 분기도 보호)
    — 여기서는 두 번째 IDOR 축(asset 소유)만 검증한다.

    decision은 payload에 필드가 없으므로 항상 'pending' — client가 chosen/rejected로 직접
    생성할 방법이 스키마 레벨에서부터 없다(S5 게이트 전용 전이)."""
    asset = (await session.execute(
        select(Asset).where(Asset.id == payload.asset_id, Asset.org_id == org_id)
    )).scalar_one_or_none()
    if asset is None:
        raise LoopServiceError("ASSET_NOT_FOUND", "자산을 찾을 수 없습니다.")
    # ⭐크로스-리소스 IDOR: 타 프로젝트(또는 org-level=NULL) asset을 이 loop에 link 불가.
    if asset.project_id != loop.project_id:
        raise LoopServiceError(
            "ASSET_PROJECT_MISMATCH", "자산이 이 루프와 같은 프로젝트에 속하지 않습니다."
        )

    repo = LoopArtifactRepository(session, org_id)
    artifact = await repo.create(
        loop_id=loop.id,
        asset_id=payload.asset_id,
        variant_group=payload.variant_group,
        variant_label=payload.variant_label,
        generation_metadata=payload.generation_metadata,
        decision="pending",
        created_by_member_id=caller.id,
    )
    # AssetLink SSOT 와이어링(catch#4) — asset_registry.sync_attachment_assets의 idempotent-insert
    # 관용구 재사용. source_type='loop_artifact'는 0150에서 CHECK 확장됨.
    await session.execute(
        pg_insert(AssetLink)
        .values(
            org_id=org_id,
            asset_id=payload.asset_id,
            source_type="loop_artifact",
            source_id=artifact.id,
            created_by=caller.id,
        )
        .on_conflict_do_nothing(constraint="uq_asset_links_asset_source")
    )
    return LoopArtifactResponse.model_validate(artifact)


async def list_loop_artifacts(
    session: AsyncSession, org_id: uuid.UUID, loop_id: uuid.UUID
) -> list[LoopArtifactVariantGroup]:
    repo = LoopArtifactRepository(session, org_id)
    rows = await repo.list_by_loop(loop_id)
    groups: list[LoopArtifactVariantGroup] = []
    for variant_group, items in itertools.groupby(rows, key=lambda a: a.variant_group):
        groups.append(LoopArtifactVariantGroup(
            variant_group=variant_group,
            artifacts=[LoopArtifactResponse.model_validate(a) for a in items],
        ))
    return groups
