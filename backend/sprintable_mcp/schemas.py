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


class TaskStatus(str, Enum):
    todo = "todo"
    in_progress = "in-progress"
    done = "done"


class EpicStatus(str, Enum):
    draft = "draft"
    active = "active"
    done = "done"
    archived = "archived"


class StoryPoints(int, Enum):
    one = 1
    two = 2
    three = 3
    five = 5
    eight = 8
    thirteen = 13
    twenty_one = 21


class SprintStatus(str, Enum):
    planning = "planning"
    active = "active"
    closed = "closed"


class HypothesisStatus(str, Enum):
    proposed = "proposed"
    active = "active"
    measuring = "measuring"
    verified = "verified"
    falsified = "falsified"
    killed = "killed"
    archived = "archived"


class HypothesisConfirmStatus(str, Enum):
    """confirm 도구 전용 — 휴먼 확정(active) 또는 폐기(killed)."""
    active = "active"
    killed = "killed"


class SprintableInput(BaseModel):
    """모든 Sprintable 도구 입력 공통 베이스.

    org_id는 SprintableClient context에서 자동 주입. project_id는 **선택적 per-call override** —
    org-agent 멀티프로젝트 grant(ProjectAccess) 시 특정 프로젝트를 타겟(미지정=키 default project·무회귀).
    설정 시 client.project_id(쿼리/바디) + X-Project-Id 헤더에 반영(85429ee0).
    Optional 필드는 기본값 None → MCP schema required에서 제외.
    """

    model_config = ConfigDict(extra="ignore")
    project_id: str | None = None
