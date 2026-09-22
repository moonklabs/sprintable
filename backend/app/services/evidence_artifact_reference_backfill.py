"""story #4141([E-RECIPE-1] Phase3, 페드루 PO 確定 2026-09-22) AC4 — evidence/artifact
entity_references 온보딩(routers/evidence.py::_reconcile_evidence_entity_references·
routers/visual_artifacts.py::_reconcile_artifact_entity_references) 신설 前에 생성된
기존 행은 참조가 0건이다. 이 백필이 그 갭을 메운다.

멱등(write-path와 같은 `reconcile_entity_references`를 그대로 재사용 — ON CONFLICT DO
NOTHING이 기저 함수의 불변식이라 이 백필도 몇 번을 다시 돌려도 안전하다, reference_
backfill.py의 기존 관례와 동형). **dry-run 기본**(apply=False) — 스캔·집계만 하고
DB에 아무것도 안 쓴다. apply=True만 실제로 reconcile을 호출한다.

두 번째 파서/두 번째 reconcile 로직을 만들지 않는다 — write-path가 이미 쓰는 그 private
함수를 그대로 재사용(routers 모듈에서 import)한다. 이 백필이 새로 아는 것은 "어느 기존
행들을 스캔 대상으로 볼 것인가"뿐이다.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class BackfillTotals:
    evidence_scanned: int = 0
    evidence_with_refs_extracted: int = 0
    artifact_scanned: int = 0
    artifact_with_refs_extracted: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "evidence_scanned": self.evidence_scanned,
            "evidence_with_refs_extracted": self.evidence_with_refs_extracted,
            "artifact_scanned": self.artifact_scanned,
            "artifact_with_refs_extracted": self.artifact_with_refs_extracted,
            "errors": self.errors,
        }


async def backfill_evidence_references(
    session: AsyncSession, *, apply: bool, org_id: uuid.UUID | None = None,
) -> BackfillTotals:
    """기존 Evidence 행 전부(또는 org_id 스코프)를 스캔해 write-path와 동일한 3종 신호
    (artifact_id·payload.doc·payload.kind→게이트 핀)로 reconcile한다. `_reconcile_evidence_
    entity_references`가 payload가 비어 있거나 신호가 하나도 없으면 자체적으로 조용히
    no-op(early return)하므로 이 함수는 "신호를 뽑아냈는가"만 별도로 세지 않고 그 함수의
    반환을 신뢰한다 — 대신 호출 前 payload/artifact_id 유무로 "이번에 뭔가 쓸 게 있었는가"를
    집계해 dry-run에서도 유의미한 카운트를 보여준다."""
    from app.models.evidence import Evidence
    from app.models.visual_artifact import ArtifactVersion
    from app.routers.evidence import _reconcile_evidence_entity_references

    totals = BackfillTotals()
    stmt = select(Evidence)
    if org_id is not None:
        stmt = stmt.where(Evidence.org_id == org_id)
    evidences = (await session.execute(stmt)).scalars().all()

    for ev in evidences:
        totals.evidence_scanned += 1
        payload = ev.payload if isinstance(ev.payload, dict) else {}
        # story #4141 — Evidence 자신은 artifact_id를 안 갖는다(EvidenceCreateRequest.
        # artifact_id는 생성 시점에 artifact_version_id로 "그 시각의 latest"를 pin해
        # 저장하는 요청 전용 필드 — routers/evidence.py::EvidenceCreateRequest 주석 참조).
        # 백필은 기존 행에서 거꾸로 artifact_version_id → ArtifactVersion.artifact_id로
        # 되짚어야 write-path와 같은 신호를 재현한다.
        artifact_id: uuid.UUID | None = None
        if ev.artifact_version_id is not None:
            version = await session.get(ArtifactVersion, ev.artifact_version_id)
            artifact_id = version.artifact_id if version is not None else None
        has_signal = artifact_id is not None or bool(payload.get("doc")) or bool(payload.get("kind"))
        if not has_signal:
            continue
        totals.evidence_with_refs_extracted += 1
        if not apply:
            continue
        try:
            await _reconcile_evidence_entity_references(
                session, org_id=ev.org_id, evidence_id=ev.id, work_item_id=ev.work_item_id,
                work_item_type=ev.work_item_type, artifact_id=artifact_id, payload=payload,
                created_by=ev.created_by,
            )
        except Exception as exc:  # noqa: BLE001 — 부분실패 graceful(doc_asset_backfill.py 관례), 한 행 실패가 전체를 안 죽인다.
            totals.errors.append(f"evidence={ev.id}: {exc}")
    if apply:
        await session.commit()
    return totals


async def backfill_artifact_references(
    session: AsyncSession, *, apply: bool, org_id: uuid.UUID | None = None,
) -> BackfillTotals:
    """기존 VisualArtifact 행 전부(또는 org_id 스코프)를 스캔해 각 artifact의 **최신 버전**
    (latest_version_number denorm — GET 경로와 동일 SSOT)의 node description들로 write-path와
    동일한 reconcile을 돌린다. known_new=False(이미 존재하는 artifact라 "신규"가 아니다 —
    두 번째 실행에서도 stale diff가 정직하게 동작해야 한다)."""
    from app.models.visual_artifact import ArtifactNode, ArtifactVersion, VisualArtifact
    from app.routers.visual_artifacts import _reconcile_artifact_entity_references

    totals = BackfillTotals()
    stmt = select(VisualArtifact)
    if org_id is not None:
        stmt = stmt.where(VisualArtifact.org_id == org_id)
    artifacts = (await session.execute(stmt)).scalars().all()

    for art in artifacts:
        totals.artifact_scanned += 1
        version = (await session.execute(
            select(ArtifactVersion).where(
                ArtifactVersion.artifact_id == art.id,
                ArtifactVersion.version_number == art.latest_version_number,
            )
        )).scalar_one_or_none()
        if version is None:
            continue
        descriptions = (await session.execute(
            select(ArtifactNode.description).where(ArtifactNode.version_id == version.id)
        )).scalars().all()
        has_signal = (
            art.story_id is not None or art.epic_id is not None or art.doc_id is not None
            or any(descriptions)
        )
        if not has_signal:
            continue
        totals.artifact_with_refs_extracted += 1
        if not apply:
            continue
        try:
            await _reconcile_artifact_entity_references(
                session, org_id=art.org_id, artifact=art, node_descriptions=list(descriptions),
                created_by=art.created_by, known_new=False,
            )
        except Exception as exc:  # noqa: BLE001 — 부분실패 graceful, 한 행 실패가 전체를 안 죽인다.
            totals.errors.append(f"artifact={art.id}: {exc}")
    if apply:
        await session.commit()
    return totals
