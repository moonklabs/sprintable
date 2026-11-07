import uuid

from sqlalchemy import case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation, ConversationMessage
from app.models.project import Project
from app.repositories.base import BaseRepository


class ProjectHasChatAttachments(Exception):
    """story #4846 — a project with a chat room that holds a message attachment is not deleted (yet).

    A room now outlives its project (conversations.project_id → NULL), but the asset rows of the files attached in its messages are deleted WITH the
    project (assets.project_id ON DELETE CASCADE) and nothing deletes the stored files — the room would keep messages pointing at files that no longer
    open, a loss the attachment PR of this story could not undo. The API answers 409 `PROJECT_HAS_CHAT_ATTACHMENTS` (main.py). Lifted by that PR."""

    code = "PROJECT_HAS_CHAT_ATTACHMENTS"
    message = "이 프로젝트의 채팅방에 첨부 파일이 있어 지금은 프로젝트를 지울 수 없어요. 첨부를 방과 함께 보존하는 기능이 들어온 뒤에 지울 수 있어요."


class ProjectRepository(BaseRepository[Project]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Project, session, org_id)

    async def delete(self, id: uuid.UUID) -> bool:
        """The one place a project is deleted through: refuses (ProjectHasChatAttachments) before anything is touched.

        The project row is locked FOR UPDATE first: registering an attachment inserts an asset row that references the project, which holds a key-share
        lock on it until that transaction commits — so the check below waits for a registration in flight and sees it, and a registration that comes
        after waits for this deletion (no «checked, then an attachment arrived, then deleted» window)."""
        await self.session.execute(select(Project.id).where(Project.id == id, Project.org_id == self.org_id).with_for_update())
        attachments = ConversationMessage.attachments
        has_chat_attachments = (await self.session.execute(
            select(ConversationMessage.id)
            .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
            .where(
                Conversation.project_id == id, Conversation.org_id == self.org_id,
                # a JSONB array with something in it (NULL, JSON null, an object or a scalar are not a list of attachments)
                func.jsonb_array_length(case((func.jsonb_typeof(attachments) == 'array', attachments), else_=text("'[]'::jsonb"))) > 0,
            )
            .limit(1)
        )).first() is not None
        if has_chat_attachments:
            raise ProjectHasChatAttachments()
        return await super().delete(id)
