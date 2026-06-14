"""eb1a8f95: 팀 presence 집계 API — FE presence 패널이 소비할 단일 계약.

2축을 에이전트별로 합쳐 org-level 단일 응답 제공(채팅 밖 at-a-glance 가용성 표시):
- presence_status: online/idle/offline = 연결 축(P1 `team_members`·last_seen_at 도출 재사용)
- working: 작업 축(P2 `chat_presence` 를 **전 conversation 횡단 집계** — 어디든 working 이면 true)

선생님 B 결정: working 은 **여부만**(boolean) — for-whom(어느 conversation·누구와) 미포함.
⚠️ working 집계는 멀티인스턴스 per-instance best-effort(`chat_presence` in-memory 한계 동일).
마이그 불요(읽기 집계).

응답 계약(FE 정합):
  GET /api/v2/team-presence → [
    {member_id, name, avatar_url, agent_role, runtime_type,
     presence_status: "online"|"idle"|"offline", working: bool,
     active_story: {id,title,status}|null}
  ]
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.team_member import TeamMemberRepository
from app.routers.team_members import _inject_active_stories
from app.schemas.team_member import ActiveStorySummary
from app.services import chat_presence

router = APIRouter(prefix="/api/v2/team-presence", tags=["team-presence"])


class TeamPresenceItem(BaseModel):
    member_id: uuid.UUID
    name: str
    avatar_url: str | None = None
    agent_role: str | None = None
    runtime_type: str | None = None
    presence_status: str | None = None  # "online" | "idle" | "offline"
    working: bool = False  # B: 여부만 — 어느 conversation 이든 working 이면 true
    active_story: ActiveStorySummary | None = None


@router.get("", response_model=list[TeamPresenceItem])
async def get_team_presence(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[TeamPresenceItem]:
    """org 전 에이전트의 presence_status(연결) + global working(작업) 집계."""
    repo = TeamMemberRepository(session, org_id)
    agents = await repo.list(type="agent", is_active=True)

    # team_members 뷰는 멤버당 프로젝트별 행을 반환 → 멤버당 1로 dedup(presence/working 은 멤버 단위).
    seen: set[uuid.UUID] = set()
    unique = []
    for a in agents:
        if a.id in seen:
            continue
        seen.add(a.id)
        unique.append(a)

    # presence_status(computed) + active_story 주입은 team_members 경로 재사용(로직 중복 방지).
    responses = await _inject_active_stories(unique, session)
    working_ids = chat_presence.working_member_ids()

    return [
        TeamPresenceItem(
            member_id=r.id,
            name=r.name,
            avatar_url=r.avatar_url,
            agent_role=r.agent_role,
            runtime_type=r.runtime_type,
            presence_status=r.presence_status,
            working=str(r.id) in working_ids,
            active_story=r.active_story,
        )
        for r in responses
    ]
