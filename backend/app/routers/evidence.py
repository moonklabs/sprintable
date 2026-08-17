"""E-VERIFY V0-S1(story 5a5ba27b): Evidence CRD(D 없는 U — 자기증명은 불변) — story/task 첨부."""
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, computed_field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.evidence import _CLIENT_CREATABLE_TYPES, Evidence
from app.models.pm import Story, Task
from app.models.visual_artifact import ArtifactVersion, VisualArtifact
from app.services.member_resolver import resolve_member
from app.services.project_auth import has_project_access
from app.services.reference_registry import _project_id_of_evidence

router = APIRouter(prefix="/api/v2/evidence", tags=["evidence", "Trust"])

_WORK_ITEM_TYPES = frozenset({"story", "task"})


class EvidenceCreateRequest(BaseModel):
    work_item_id: uuid.UUID
    work_item_type: str
    type: str
    ref: str
    source: str | None = None
    note: str | None = None
    # story #2722(아티팩트·evidence 버전 pin) — 이 evidence가 아티팩트를 근거로 삼을 때
    # 명시 필드로 준다(ref 문자열을 서버가 파싱해 추측하지 않는다 — 파싱 실패 시 조용한
    # 미기입 위험을 피하려는 의도적 선택, story 상신 스케치 참고). 버전은 여기서 선택하지
    # 않는다 — "그 시각의 latest"를 서버가 항상 resolve해 고정한다(③pin 시점 규칙, 클라
    # 위임 시 취지가 샌다).
    artifact_id: uuid.UUID | None = None

    @field_validator("work_item_type")
    @classmethod
    def _validate_work_item_type(cls, v: str) -> str:
        if v not in _WORK_ITEM_TYPES:
            raise ValueError(f"work_item_type must be one of {sorted(_WORK_ITEM_TYPES)}")
        return v

    @field_validator("type")
    @classmethod
    def _validate_type(cls, v: str) -> str:
        # gate_approval은 시스템(V0-S2 게이트 승인 훅) 전용 — 공개 API로 직접 생성 시 "이거
        # 승인됐음" 허위 서명 스푸핑 위험이라 여기서 차단(내부 서비스 호출은 이 검증을 안 탐).
        if v not in _CLIENT_CREATABLE_TYPES:
            raise ValueError(
                f"type must be one of {sorted(_CLIENT_CREATABLE_TYPES)} "
                "(gate_approval은 게이트 승인 시 시스템이 자동 생성)"
            )
        return v


class EvidenceResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    work_item_id: uuid.UUID
    work_item_type: str
    artifact_version_id: uuid.UUID | None = None
    """story #2722 — NULL="버전 미상"(구 데이터 또는 아티팩트 근거 아님), 값 있으면 evidence
    생성 시각에 서버가 고정한 그 버전."""
    artifact_id: uuid.UUID | None = None
    artifact_version_number: int | None = None
    """story #2722 — artifact_version_id 하나로는 FE가 기존 ArtifactExpandDialog 왕복
    (artifactId+versionNumber 필요, artifact-gallery-view.tsx의 handleOpenArtifact와 동일
    계약)을 못 채운다 — evidence.artifact_version_id → artifact_versions 1-hop 조인 결과를
    denorm으로 얹는다(둘 다 artifact_version_id가 있을 때만 채워짐, 새 컬럼 아님)."""
    type: str
    ref: str
    source: str | None
    note: str | None
    created_by: uuid.UUID
    created_at: Any
    resolved_story_id: uuid.UUID | None = None
    """story #2314 AC3② — embed 칩이 evidence의 «담긴 곳»으로 한 번에 건너뛸 자리.
    work_item_type='story'면 work_item_id 그 자체, 'task'면 그 task의 부모 story_id(2단
    조인) — FE가 evidence→task→story로 왕복 fetch하지 않도록 GET /{id} 응답에 얹는다."""

    # story #2642(웹·칩 공통, 2026-08-14) — resolved_story_id와 동일 스코프(GET /{id}만,
    # list는 미부착 — 기존 설계 그대로 유지). get_evidence가 이미 access 체크용으로
    # _project_id_of_evidence를 계산해 두므로 그 값을 그대로 재사용해 slug만 얹는다(추가
    # story join 불요, #2168 DocPreviewResponse와 동형 org_slug/project_slug 개념).
    org_slug: str | None = None
    project_slug: str | None = None

    model_config = {"from_attributes": True}

    # story #2314 AC5 — MCP mention 경로(_resolve_mention_content)가 title-미지정 mention을
    # 이 GET 응답의 reference_token으로 조립한다(DocResponse/StoryResponse와 동일 SSOT
    # builder). evidence엔 title이 없어 ref를 대신 쓴다 — "[pr] https://..." 형태.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def reference_token(self) -> str | None:
        from app.services.reference_token import build_reference_token
        return build_reference_token("evidence", self.id, f"[{self.type}] {self.ref}")


async def _assert_work_item_access(
    session: AsyncSession, work_item_id: uuid.UUID, work_item_type: str,
    caller_id: uuid.UUID, org_id: uuid.UUID,
) -> uuid.UUID:
    """work_item 존재 + caller의 project 접근권 검증(mutation 대상 project-scope 강제
    — [[feedback_mutation_target_resource_project_scope]] 동형).

    story #2722 — project_id를 반환하도록 확장(기존 호출부는 반환값 무시라 무회귀).
    create_evidence가 artifact_id를 받을 때 그 아티팩트가 이 work_item과 같은
    project 소속인지 검증하는 데 재사용(cross-project artifact 근거 금지 —
    _get_artifact_or_404의 project_id 필터와 동일 근거, visual_artifacts.py:190-200 참고)."""
    if work_item_type == "story":
        story = (await session.execute(
            select(Story).where(Story.id == work_item_id, Story.org_id == org_id)
        )).scalar_one_or_none()
        if story is None:
            raise HTTPException(status_code=404, detail="Story not found")
        project_id = story.project_id
    else:
        task = (await session.execute(
            select(Task).where(Task.id == work_item_id, Task.org_id == org_id)
        )).scalar_one_or_none()
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        story = (await session.execute(
            select(Story).where(Story.id == task.story_id)
        )).scalar_one_or_none()
        if story is None:
            raise HTTPException(status_code=404, detail="Parent story not found")
        project_id = story.project_id

    if not await has_project_access(session, caller_id, project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")

    return project_id


async def _resolve_latest_artifact_version_id(
    session: AsyncSession, artifact_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID,
) -> uuid.UUID:
    """story #2722 — evidence 생성 시각의 latest ArtifactVersion을 서버가 조회해 고정한다
    (③pin 시점 규칙: 클라이언트에 버전 선택을 맡기면 "그 순간 최신을 근거로 봤다"는 취지가
    샌다). org_id+project_id로 스코프(cross-org/cross-project artifact 근거 금지 —
    visual_artifacts.py:_get_artifact_or_404와 동일 근거)."""
    artifact = (await session.execute(
        select(VisualArtifact).where(
            VisualArtifact.id == artifact_id, VisualArtifact.org_id == org_id,
            VisualArtifact.project_id == project_id, VisualArtifact.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if artifact is None:
        raise HTTPException(status_code=404, detail="Artifact not found")

    latest = (await session.execute(
        select(ArtifactVersion).where(ArtifactVersion.artifact_id == artifact_id)
        .order_by(ArtifactVersion.version_number.desc()).limit(1)
    )).scalar_one_or_none()
    if latest is None:
        raise HTTPException(status_code=404, detail="Artifact has no versions")
    return latest.id


async def _attach_artifact_denorm(
    session: AsyncSession, items: list[Evidence],
) -> list[EvidenceResponse]:
    """story #2722 — artifact_version_id가 있는 evidence들의 artifact_id/version_number를
    한 번의 IN 쿼리로 조회해 붙인다(리스트 크기만큼 N+1 안 함)."""
    version_ids = {e.artifact_version_id for e in items if e.artifact_version_id is not None}
    version_map: dict[uuid.UUID, ArtifactVersion] = {}
    if version_ids:
        rows = (await session.execute(
            select(ArtifactVersion).where(ArtifactVersion.id.in_(version_ids))
        )).scalars().all()
        version_map = {v.id: v for v in rows}

    out = []
    for e in items:
        version = version_map.get(e.artifact_version_id) if e.artifact_version_id else None
        out.append(
            EvidenceResponse.model_validate(e, from_attributes=True).model_copy(
                update={
                    "artifact_id": version.artifact_id if version else None,
                    "artifact_version_number": version.version_number if version else None,
                }
            )
        )
    return out


@router.post("", response_model=EvidenceResponse, status_code=201)
async def create_evidence(
    body: EvidenceCreateRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EvidenceResponse:
    caller = await resolve_member(auth, org_id, session)
    project_id = await _assert_work_item_access(
        session, body.work_item_id, body.work_item_type, caller.id, org_id
    )

    artifact_version_id = None
    if body.artifact_id is not None:
        artifact_version_id = await _resolve_latest_artifact_version_id(
            session, body.artifact_id, org_id, project_id
        )

    evidence = Evidence(
        id=uuid.uuid4(),
        org_id=org_id,
        work_item_id=body.work_item_id,
        work_item_type=body.work_item_type,
        artifact_version_id=artifact_version_id,
        type=body.type,
        ref=body.ref,
        source=body.source,
        note=body.note,
        created_by=caller.id,
    )
    session.add(evidence)
    await session.commit()
    await session.refresh(evidence)
    [denorm] = await _attach_artifact_denorm(session, [evidence])
    return denorm


@router.get("", response_model=list[EvidenceResponse])
async def list_evidence(
    work_item_id: uuid.UUID = Query(...),
    work_item_type: str = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[EvidenceResponse]:
    if work_item_type not in _WORK_ITEM_TYPES:
        raise HTTPException(status_code=400, detail=f"work_item_type must be one of {sorted(_WORK_ITEM_TYPES)}")

    caller = await resolve_member(auth, org_id, session)
    await _assert_work_item_access(session, work_item_id, work_item_type, caller.id, org_id)

    result = await session.execute(
        select(Evidence).where(
            Evidence.org_id == org_id,
            Evidence.work_item_id == work_item_id,
            Evidence.work_item_type == work_item_type,
        ).order_by(Evidence.created_at.asc())
    )
    items = list(result.scalars().all())
    return await _attach_artifact_denorm(session, items)


@router.get("/{id}", response_model=EvidenceResponse)
async def get_evidence(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EvidenceResponse:
    """story #2314 AC1 — 형제 단건 라우트(get_story 등)와 같은 관례. AC2: 못 보는 evidence는
    「있다는 사실」도 새지 않는다 — org 안·project 밖도 404로 통일한다(#2322가 story 헬퍼에서
    막 세운 그 방향과 동형 — evidence.py는 #2322의 4개 헬퍼 목록엔 없지만, 신규 라우트는
    처음부터 그 방향을 따른다. 존재하지만 못 봄=404, 진짜 없음=404, 구분해 흘리지 않는다)."""
    evidence = (await session.execute(
        select(Evidence).where(Evidence.id == id, Evidence.org_id == org_id)
    )).scalar_one_or_none()
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    caller = await resolve_member(auth, org_id, session)
    project_id = await _project_id_of_evidence(session, org_id, id)
    if project_id is None or not await has_project_access(session, caller.id, project_id, org_id):
        raise HTTPException(status_code=404, detail="Evidence not found")

    resolved_story_id: uuid.UUID | None = None
    if evidence.work_item_type == "story":
        resolved_story_id = evidence.work_item_id
    elif evidence.work_item_type == "task":
        resolved_story_id = (await session.execute(
            select(Task.story_id).where(Task.id == evidence.work_item_id, Task.org_id == org_id)
        )).scalar_one_or_none()

    from app.services.entity_slug import resolve_org_slug, resolve_project_slugs

    org_slug = await resolve_org_slug(session, org_id)
    project_slug_map = await resolve_project_slugs(session, {project_id})

    [denorm] = await _attach_artifact_denorm(session, [evidence])
    return denorm.model_copy(
        update={
            "resolved_story_id": resolved_story_id,
            "org_slug": org_slug,
            "project_slug": project_slug_map.get(project_id),
        }
    )


@router.delete("/{id}", status_code=204)
async def delete_evidence(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> None:
    """생성자 본인만 철회 가능(타인의 서명을 지울 수 있으면 신뢰 표면이 무너짐) — org-admin도
    포함하지 않음(의도적, blueprint §0 감시-축 회피: admin이 에이전트 증거를 지울 수 있으면
    "누가 주어인가"가 다시 휴먼으로 뒤집힘)."""
    evidence = (await session.execute(
        select(Evidence).where(Evidence.id == id, Evidence.org_id == org_id)
    )).scalar_one_or_none()
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    caller = await resolve_member(auth, org_id, session)
    if evidence.created_by != caller.id:
        raise HTTPException(status_code=403, detail="Only the creator can retract evidence")

    await session.delete(evidence)
    await session.commit()
