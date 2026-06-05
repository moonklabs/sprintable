import uuid
from datetime import date
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.standup import StandupEntry, StandupFeedback
from app.repositories.base import BaseRepository

# AC3-3: missing 산정 — "effective 휴먼 project access"를 canonical members.id로 열거(team_members
# 열거 대체). has_project_access 3-branch(owner/admin org-wide ∪ project_access grant ∪ 레거시 휴먼
# team_member→alias)와 정합. submitted는 alias 정규화로 마이그 전/후 모두 canonical 대조.
_MISSING_SQL = text(
    """
    WITH roster AS (
        -- 1) owner/admin org-wide 휴먼 (canonical = org_member.id)
        SELECT om.id AS cid
        FROM org_members om
        WHERE om.org_id = :org AND om.deleted_at IS NULL AND om.role IN ('owner','admin')
        UNION
        -- 2) project_access grant (휴먼: canonical = org_member.id). ⚠️ 실 grant 플로우
        --    (create_project_access)는 org_member_id만 세팅하고 member_id는 NULL로 둔다(0075 백필분만
        --    member_id 채워짐) → member_id 키는 신규 grant-only 휴먼을 누락. org_member_id로 집계.
        --    (에이전트 direct placement는 org_member_id NULL이라 자연 제외 — 휴먼 grant만.)
        SELECT pa.org_member_id AS cid
        FROM project_access pa
        JOIN org_members om2 ON om2.id = pa.org_member_id AND om2.deleted_at IS NULL
        WHERE pa.project_id = :proj AND pa.permission = 'granted' AND pa.org_member_id IS NOT NULL
        UNION
        -- 3) 레거시 휴먼 team_member → canonical(alias)
        SELECT a.member_id AS cid
        FROM team_members tm
        JOIN member_identity_aliases a ON a.alias_id = tm.id
        WHERE tm.project_id = :proj AND tm.type = 'human' AND tm.is_active = true
    ), submitted AS (
        SELECT DISTINCT COALESCE(a.member_id, se.author_id) AS cid
        FROM standup_entries se
        LEFT JOIN member_identity_aliases a ON a.alias_id = se.author_id
        WHERE se.org_id = :org AND se.project_id = :proj AND se.date = :date
    )
    SELECT r.cid FROM roster r WHERE r.cid NOT IN (SELECT cid FROM submitted)
    """
)


class StandupEntryRepository(BaseRepository[StandupEntry]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(StandupEntry, session, org_id)

    async def upsert(self, **data: Any) -> StandupEntry:
        """E-STANDUP 3b6b567c: org-level upsert — 키 **(org_id, author_id, date)**.

        프로젝트별 별도 행이 아니라 author+date 당 org 1엔트리. 프로젝트 surface 는
        standup_entry_projects link 로 projection(51447ca0). project_id(origin)는 컬럼 유지
        하되 더 이상 identity 키가 아니다. org_id 는 self.org_id(=get_verified_org_id 검증값,
        CP3) — 클라 바디 미수용.
        """
        existing = await self.session.execute(
            select(StandupEntry).where(
                self._org_filter(),
                StandupEntry.author_id == data["author_id"],
                StandupEntry.date == data["date"],
            )
        )
        entry = existing.scalar_one_or_none()
        if entry is not None:
            update_data = {k: v for k, v in data.items() if k not in ("author_id", "date")}
            updated = await self.update(entry.id, **update_data)
            assert updated is not None
            entry = updated
        else:
            entry = await self.create(**data)
        # projection link 유지 (project_id 제공 시 멱등 보장). 빈 링크/프로젝트 미선택 등
        # full write 링크 정책은 1c2be9db(write API) 스코프.
        project_id = data.get("project_id")
        if project_id is not None:
            await self.session.execute(
                text(
                    "INSERT INTO standup_entry_projects (id, entry_id, project_id, org_id) "
                    "VALUES (gen_random_uuid(), :e, :p, :o) "
                    "ON CONFLICT (entry_id, project_id) DO NOTHING"
                ),
                {"e": entry.id, "p": project_id, "o": self.org_id},
            )
        return entry

    async def get_missing(self, project_id: uuid.UUID, target_date: date) -> list[uuid.UUID]:
        """해당 날짜 standup 미제출 휴먼의 **canonical members.id** 목록 (AC3-3).

        effective 휴먼 project access(owner/admin ∪ grant ∪ 레거시 휴먼 team_member) − 제출분.
        멀티프로젝트 휴먼이 단일 canonical 신원으로 집계돼 N-project 중복이 사라진다(48e653e9).
        """
        rows = await self.session.execute(
            _MISSING_SQL,
            {"org": self.org_id, "proj": project_id, "date": target_date},
        )
        return [row[0] for row in rows.all()]


class StandupFeedbackRepository(BaseRepository[StandupFeedback]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(StandupFeedback, session, org_id)
