import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.project import Project
from app.repositories.base import BaseRepository


class ProjectRepository(BaseRepository[Project]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Project, session, org_id)

    async def delete(self, id: uuid.UUID) -> bool:
        """The one place a project is deleted through. A room outlives its project (conversations.project_id → NULL), and so must the files attached in its
        messages: their asset rows hang on the project (assets.project_id ON DELETE CASCADE) and nothing deletes the stored files, so the rows are first
        re-homed to NO project — every file that carries a chat-message link is the ROOM's (it is read by the room rule, whatever other link it has: a file with no
        project and a chat link is never read as the organization's), and its path stays readable because a room without a project accepts the project-pathed files it
        already holds. Everything else of the project goes with it, as before.

        The project row is locked FOR UPDATE first: registering an attachment inserts an asset row that references the project, which holds a key-share lock
        on it until that transaction commits — so this waits for a registration in flight and re-homes it too, and one that comes after waits for this deletion."""
        await self.session.execute(select(Project.id).where(Project.id == id, Project.org_id == self.org_id).with_for_update())
        from app.services.chat_asset_scope import chat_linked_clause   # the room rule's own test for «this file is carried by a chat message»

        # lock the project's asset rows BEFORE reading their links: a registration that attaches an existing file to a message inserts a link that references the asset row
        # (it takes a key-share lock on it), so it either finished before this lock — and its chat link is seen below — or waits for this deletion; a statement that
        # reads the links first could miss a link that is being committed and let a file the message now carries go with the project
        await self.session.execute(
            select(Asset.id).where(Asset.org_id == self.org_id, Asset.project_id == id).order_by(Asset.id).with_for_update()
        )
        await self.session.execute(
            update(Asset)
            .where(Asset.org_id == self.org_id, Asset.project_id == id, chat_linked_clause())
            .values(project_id=None)
        )
        return await super().delete(id)
