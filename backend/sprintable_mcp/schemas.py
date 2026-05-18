"""Sprintable MCP 공통 입력 스키마 — Pydantic BaseModel 기반."""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict


class StoryStatus(str, Enum):
    backlog = "backlog"
    ready_for_dev = "ready-for-dev"
    in_progress = "in-progress"
    in_review = "in-review"
    done = "done"


class StoryPriority(str, Enum):
    critical = "critical"
    high = "high"
    medium = "medium"
    low = "low"


class SprintableInput(BaseModel):
    """모든 Sprintable 도구 입력 공통 베이스.

    project_id/org_id는 SprintableClient context에서 자동 주입하므로 스키마에서 제외.
    Optional 필드는 기본값 None → MCP schema required에서 제외.
    """

    model_config = ConfigDict(extra="ignore")
