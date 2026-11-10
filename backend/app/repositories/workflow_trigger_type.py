import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_trigger_type import WorkflowTriggerType

# story #4888 — the system «kickoff» description said «에픽» before it said «목표» (migration 0473 corrects the rows that exist). The migration runs BEFORE the old backend is swapped out,
# so during that window the old release can still seed a brand-new organization with the old text (`ON CONFLICT DO NOTHING` then keeps it). `list()` therefore corrects, with the
# same exact-text rule as the migration (system row · description exactly this text), any row that still carries it — a description a person edited is never touched.
_LEGACY_KICKOFF_DESCRIPTION = "스프린트 또는 에픽 킥오프"
_KICKOFF_DESCRIPTION = "스프린트 또는 목표 킥오프"

SYSTEM_TRIGGER_TYPES = [
    {"slug": "kickoff", "label": "Kickoff", "description": _KICKOFF_DESCRIPTION},
    {"slug": "review_request", "label": "Review Request", "description": "코드 리뷰 요청"},
    {"slug": "qa_request", "label": "QA Request", "description": "QA 검수 요청"},
    {"slug": "deploy_request", "label": "Deploy Request", "description": "배포 요청"},
    {"slug": "handoff", "label": "Handoff", "description": "담당자 간 인계"},
    {"slug": "status_changed", "label": "Status Changed", "description": "스토리 상태 전이"},
    {"slug": "assignee_changed", "label": "Assignee Changed", "description": "스토리 담당자 변경"},
    {"slug": "reply", "label": "Reply", "description": "메모 답신"},
]


class WorkflowTriggerTypeRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def _seed_system_defaults(self) -> None:
        for item in SYSTEM_TRIGGER_TYPES:
            await self.session.execute(
                pg_insert(WorkflowTriggerType)
                .values(
                    id=uuid.uuid4(),
                    org_id=self.org_id,
                    slug=item["slug"],
                    label=item["label"],
                    description=item["description"],
                    is_system=True,
                    is_enabled=True,
                )
                .on_conflict_do_nothing()
            )

    async def list(self) -> list[WorkflowTriggerType]:
        result = await self.session.execute(
            select(WorkflowTriggerType)
            .where(WorkflowTriggerType.org_id == self.org_id, WorkflowTriggerType.deleted_at.is_(None))
            .order_by(WorkflowTriggerType.is_system.desc(), WorkflowTriggerType.created_at.asc(), WorkflowTriggerType.id)
        )
        items = list(result.scalars().all())
        if not items:
            await self._seed_system_defaults()
            await self.session.flush()
            result2 = await self.session.execute(
                select(WorkflowTriggerType)
                .where(WorkflowTriggerType.org_id == self.org_id, WorkflowTriggerType.deleted_at.is_(None))
                .order_by(WorkflowTriggerType.is_system.desc(), WorkflowTriggerType.created_at.asc(), WorkflowTriggerType.id)
            )
            items = list(result2.scalars().all())
        healed = False
        for it in items:
            if it.is_system and it.description == _LEGACY_KICKOFF_DESCRIPTION:
                it.description = _KICKOFF_DESCRIPTION
                healed = True
        if healed:
            await self.session.flush()
        return items

    async def get(self, id: uuid.UUID) -> WorkflowTriggerType | None:
        result = await self.session.execute(
            select(WorkflowTriggerType).where(
                WorkflowTriggerType.id == id,
                WorkflowTriggerType.org_id == self.org_id,
                WorkflowTriggerType.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def create(self, slug: str, label: str, description: str | None = None) -> WorkflowTriggerType:
        obj = WorkflowTriggerType(
            org_id=self.org_id,
            slug=slug,
            label=label,
            description=description,
            is_system=False,
            is_enabled=True,
        )
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(self, id: uuid.UUID, **data: object) -> WorkflowTriggerType | None:
        obj = await self.get(id)
        if obj is None:
            return None
        for key, value in data.items():
            setattr(obj, key, value)
        await self.session.flush()
        return obj

    async def delete(self, id: uuid.UUID) -> WorkflowTriggerType | None:
        obj = await self.get(id)
        if obj is None:
            return None
        obj.deleted_at = datetime.now(timezone.utc)
        await self.session.flush()
        return obj
