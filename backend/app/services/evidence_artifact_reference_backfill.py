"""story #4141([E-RECIPE-1] Phase3, 페드루 PO 確定 2026-09-22) AC4(정정 라운드,
2026-09-22 04:50Z) — evidence/artifact entity_references 온보딩(routers/evidence.py::
_reconcile_evidence_entity_references·routers/visual_artifacts.py::_reconcile_artifact_
entity_references) 신설 前에 생성된 기존 행은 참조가 0건이다. 이 백필이 그 갭을 메운다.

⛔독립 CLI(scripts/jobs/) 대신 기존 `POST /api/v2/internal/cron/publication-commands`
tick에 피기백한다 — 페드루 PO 지적: scripts/jobs CLI는 Cloud Run Job을 gcloud로 돌릴
"사람"이 있어야 실행되는데 dev 실행 주체가 0(#4518과 같은 자리, insight_snapshots·
comment_collections 등 publication-commands가 이미 쓰는 "새 Cloud Scheduler 잡 0"
피기백 사상과 동형). 이 route는 dev에서 1분마다 실제로 도는 게 로그로 확認됨(PR 본문
gcloud logging read 근거) — `/entity-references-orphan-check`는 30일 조회 0건으로
dev 가동 흔적이 없어 탈락.

**멱등**: write-path와 같은 private reconcile 함수를 그대로 재사용(ON CONFLICT DO
NOTHING이 기저 `reconcile_entity_references`의 불변식) — 같은 행을 몇 번 다시 스윕해도
안전.

**bounded**: 매 tick LIMIT batch_size(기본 50)만 본다(publication_commands_tick의
다른 피기백 축들과 동일 상한 사상 — 무제한 스캔이 매 분 도는 cron의 요청 예산을 먹지
않게). WHERE 절에 "아직 참조가 0건"(NOT EXISTS) + "재구성 가능한 신호가 있다"
(evidence: artifact_version_id·payload.doc·payload.kind 중 하나 / artifact: story_id·
epic_id·doc_id 중 하나이거나 최신 버전에 description이 있는 노드가 있다)를 같이
걸어, **신호가 아예 없는 행은 후보 집합에서 원천 배제**한다 — 안 그러면 그런 행은
절대 참조가 안 생기니 `NOT EXISTS`가 영원히 참으로 남아 매 tick 큐 앞자리를 영구
점유해(created_at ASC) 뒤에 쌓인 진짜 대상을 굶길 수 있다(starvation).

⚠️잔여 한계(문서화, 완전 해소는 스코프 밖): payload.kind는 있지만 그 kind를 기대하는
게이트가 실제로는 없는(고아) evidence, 또는 description은 있지만 유효한 entity 토큰이
없는 artifact는 "신호 있음"으로 후보에 들어가지만 reconcile이 빈 결과로 no-op해
참조가 안 생겨 계속 재후보가 된다 — 이건 실제로 "됐어야 하는데 안 된" 새는 부분이
아니라(값 자체가 진짜 없다) 매 tick 반복 재시도되는 낭비일 뿐이고, 이런 행의 모집단은
유한(과거 생성분)해 batch_size 앞자리를 점유하는 정도가 시간이 지나며 줄어든다.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class SweepResult:
    scanned: int = 0
    processed: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {"scanned": self.scanned, "processed": self.processed, "errors": self.errors}


async def sweep_evidence_references(session: AsyncSession, *, batch_size: int = 50) -> SweepResult:
    """cron tick 1회분 — 참조 0건이면서 재구성 신호가 있는 Evidence 최대 batch_size건을
    골라 write-path와 동일한 reconcile을 돌린다."""
    from app.models.evidence import Evidence
    from app.models.reference import Reference
    from app.models.visual_artifact import ArtifactVersion
    from app.routers.evidence import _reconcile_evidence_entity_references

    result = SweepResult()

    has_ref = exists(
        select(Reference.id).where(
            Reference.org_id == Evidence.org_id,
            Reference.source_type == "evidence",
            Reference.source_id == Evidence.id,
        )
    )
    stmt = (
        select(Evidence)
        .where(
            ~has_ref,
            or_(
                Evidence.artifact_version_id.isnot(None),
                Evidence.payload["doc"].astext.isnot(None),
                Evidence.payload["kind"].astext.isnot(None),
            ),
        )
        .order_by(Evidence.created_at.asc())
        .limit(batch_size)
    )
    rows = (await session.execute(stmt)).scalars().all()
    result.scanned = len(rows)

    for ev in rows:
        payload = ev.payload if isinstance(ev.payload, dict) else {}
        # story #4141 — Evidence 자신은 artifact_id를 안 갖는다(EvidenceCreateRequest.
        # artifact_id는 생성 시점 요청 전용 필드 — routers/evidence.py 주석 참조). 백필은
        # 기존 행에서 거꾸로 artifact_version_id → ArtifactVersion.artifact_id로 되짚는다.
        artifact_id: uuid.UUID | None = None
        if ev.artifact_version_id is not None:
            version = await session.get(ArtifactVersion, ev.artifact_version_id)
            artifact_id = version.artifact_id if version is not None else None
        try:
            await _reconcile_evidence_entity_references(
                session, org_id=ev.org_id, evidence_id=ev.id, work_item_id=ev.work_item_id,
                work_item_type=ev.work_item_type, artifact_id=artifact_id, payload=payload,
                created_by=ev.created_by,
            )
            result.processed += 1
        except Exception as exc:  # noqa: BLE001 — 부분실패 graceful, 한 행 실패가 tick 전체를 안 죽인다.
            result.errors.append(f"evidence={ev.id}: {exc}")
    await session.commit()
    return result


async def sweep_artifact_references(session: AsyncSession, *, batch_size: int = 50) -> SweepResult:
    """cron tick 1회분 — 참조 0건이면서 재구성 신호가 있는 VisualArtifact 최대
    batch_size건을 골라 write-path와 동일한 reconcile을 돌린다(known_new=False —
    기존 행이라 "신규"가 아니다)."""
    from app.models.reference import Reference
    from app.models.visual_artifact import ArtifactNode, ArtifactVersion, VisualArtifact
    from app.routers.visual_artifacts import _reconcile_artifact_entity_references

    result = SweepResult()

    has_ref = exists(
        select(Reference.id).where(
            Reference.org_id == VisualArtifact.org_id,
            Reference.source_type == "artifact",
            Reference.source_id == VisualArtifact.id,
        )
    )
    # 최신 버전(latest_version_number denorm — GET 경로와 동일 SSOT)에 description이
    # 있는 노드가 하나라도 있는가(coarse 신호 — 유효한 entity 토큰인지는 reconcile
    # 자신이 판정, 위 모듈 docstring 잔여 한계 참조).
    has_described_node = exists(
        select(ArtifactNode.id)
        .join(ArtifactVersion, ArtifactVersion.id == ArtifactNode.version_id)
        .where(
            ArtifactVersion.artifact_id == VisualArtifact.id,
            ArtifactVersion.version_number == VisualArtifact.latest_version_number,
            ArtifactNode.description.isnot(None),
        )
    )
    stmt = (
        select(VisualArtifact)
        .where(
            ~has_ref,
            or_(
                VisualArtifact.story_id.isnot(None),
                VisualArtifact.epic_id.isnot(None),
                VisualArtifact.doc_id.isnot(None),
                has_described_node,
            ),
        )
        .order_by(VisualArtifact.created_at.asc())
        .limit(batch_size)
    )
    artifacts = (await session.execute(stmt)).scalars().all()
    result.scanned = len(artifacts)

    for art in artifacts:
        version = (await session.execute(
            select(ArtifactVersion).where(
                ArtifactVersion.artifact_id == art.id,
                ArtifactVersion.version_number == art.latest_version_number,
            )
        )).scalar_one_or_none()
        descriptions = []
        if version is not None:
            descriptions = list((await session.execute(
                select(ArtifactNode.description).where(ArtifactNode.version_id == version.id)
            )).scalars().all())
        try:
            await _reconcile_artifact_entity_references(
                session, org_id=art.org_id, artifact=art, node_descriptions=descriptions,
                created_by=art.created_by, known_new=False,
            )
            result.processed += 1
        except Exception as exc:  # noqa: BLE001 — 부분실패 graceful, 한 행 실패가 tick 전체를 안 죽인다.
            result.errors.append(f"artifact={art.id}: {exc}")
    await session.commit()
    return result
