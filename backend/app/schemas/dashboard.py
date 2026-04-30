from __future__ import annotations

import uuid
from typing import Any

from pydantic import BaseModel


class StoryItem(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    story_points: int | None = None


class TaskItem(BaseModel):
    id: uuid.UUID
    title: str
    status: str


class MemoItem(BaseModel):
    id: uuid.UUID
    title: str | None
    status: str


class DashboardResponse(BaseModel):
    my_stories: list[StoryItem]
    my_tasks: list[TaskItem]
    open_memos: list[MemoItem]
