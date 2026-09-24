"""story #4244 — 알림 대상(reference / source_entity)의 프로젝트와 문서 slug를 목록 조회 때 배치 해소한다(종류당 IN 쿼리 1개 · N+1 0).

인앱 알림(notifications · reference_type/id)과 종 알림(events · source_entity_type/id) 두 목록이 같이 쓴다. 종 알림의 events.project_id는
대상의 프로젝트가 아니다 — 사람 수신자 dispatched 이벤트는 수신자 멤버 행(team_members VIEW · 멀티프로젝트 N행)의 project_id를 싣는다
(notification_dispatch.py). 그래서 두 목록 모두 대상 자체에서 해소한다.

- gate: 게이트 대상 work item의 프로젝트(조직 전체 결재함 #4241과 같은 해소기) · 자기 참조 앵커는 neutral_facts.project_id.
- story · task · doc · visual_artifact · epic · sprint: 각자의 프로젝트(gate_service.resolve_work_item_project_ids_batch). conversation: Conversation.project_id.
- doc은 slug도(삭제된 문서는 slug 없음). 조직 단위(team_member) · 모르는 종류 · 다른 조직 · 없는 대상은 결과에 없다(호출부 .get → None).
표시·링크 전용 — 권한 판정에 쓰지 않는다(열린 뒤 대상 라우트가 권한을 본다).
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

_WORK_ITEM_REFERENCE_TYPES = frozenset({"story", "task", "doc", "visual_artifact", "epic", "sprint"})


@dataclass(frozen=True)
class ReferenceTarget:
    project_id: uuid.UUID | None
    doc_slug: str | None = None


async def resolve_reference_targets(
    db: AsyncSession, org_id: uuid.UUID, refs: Iterable[tuple[str | None, uuid.UUID | None]],
) -> dict[tuple[str, uuid.UUID], ReferenceTarget]:
    from app.models.conversation import Conversation
    from app.models.doc import Doc
    from app.models.gate import Gate
    from app.services.gate_service import (
        resolve_gate_project_ids_batch,
        resolve_work_item_project_ids_batch,
    )

    pairs = {(t, i) for t, i in refs if t and i}
    if not pairs:
        return {}
    project: dict[tuple[str, uuid.UUID], uuid.UUID | None] = dict(await resolve_work_item_project_ids_batch(
        db, org_id, ((t, i) for t, i in pairs if t in _WORK_ITEM_REFERENCE_TYPES),
    ))
    gate_ids = {i for t, i in pairs if t == "gate"}
    if gate_ids:
        gates = (await db.execute(select(Gate).where(Gate.id.in_(gate_ids), Gate.org_id == org_id))).scalars().all()
        project.update({("gate", gid): pid for gid, pid in (await resolve_gate_project_ids_batch(db, org_id, gates)).items()})
    conv_ids = {i for t, i in pairs if t == "conversation"}
    if conv_ids:
        rows = (await db.execute(
            select(Conversation.id, Conversation.project_id).where(Conversation.id.in_(conv_ids), Conversation.org_id == org_id)
        )).all()
        project.update({("conversation", cid): pid for cid, pid in rows})
    slug: dict[uuid.UUID, str] = {}
    doc_ids = {i for t, i in pairs if t == "doc"}
    if doc_ids:
        rows = (await db.execute(
            select(Doc.id, Doc.slug).where(Doc.id.in_(doc_ids), Doc.org_id == org_id, Doc.deleted_at.is_(None))
        )).all()
        slug = {did: s for did, s in rows}
    return {
        key: ReferenceTarget(project_id=pid, doc_slug=slug.get(key[1]) if key[0] == "doc" else None)
        for key, pid in project.items()
    }
