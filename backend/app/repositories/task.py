import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Task
from app.repositories.base import BaseRepository


class TaskRepository(BaseRepository[Task]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Task, session, org_id)
