import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_trigger_type import WorkflowTriggerType

SYSTEM_TRIGGER_TYPES = [
    {"slug": "kickoff", "label": "Kickoff", "description": "스프린트 또는 에픽 킥오프"},
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
            .order_by(WorkflowTriggerType.is_system.desc(), WorkflowTriggerType.created_at.asc())
        )
        items = list(result.scalars().all())
        if not items:
            await self._seed_system_defaults()
            await self.session.flush()
            result2 = await self.session.execute(
                select(WorkflowTriggerType)
                .where(WorkflowTriggerType.org_id == self.org_id, WorkflowTriggerType.deleted_at.is_(None))
                .order_by(WorkflowTriggerType.is_system.desc(), WorkflowTriggerType.created_at.asc())
            )
            items = list(result2.scalars().all())
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
