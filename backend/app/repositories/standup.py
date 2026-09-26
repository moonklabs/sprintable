from __future__ import annotations

import uuid
from collections.abc import Collection
from datetime import date, datetime
from typing import Any

from sqlalchemy import exists, func, or_, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.standup import StandupEntry, StandupEntryProject, StandupFeedback
from app.repositories.base import BaseRepository

# story #3841(customer-zero·BE·목록 상한, 페드루 PO 確定 2026-09-14) — list_standups의
# 정렬은 (date DESC, created_at DESC)인 복합 키라 docs.py/goals.py의 단일-컬럼 cursor로는
# 못 미러링한다(docs.py encode_doc_cursor의 "(sort_order,id) 복합 커서" 선례를 여기서
# (date,created_at,id) 3-tuple로 확장 — id까지 넣는 이유도 동일: date+created_at만으로도
# 동석차 tie가 이론상 가능해 경계 행 누락/중복을 막는 2차·3차 정렬키가 필요하다).
# 구분자는 "|" — created_at의 ISO 표현 자체가 ":"를 포함해(예 04:50:00+00:00) ":" 구분자는
# 잘못 쪼개진다(docs.py의 단일 int 필드 커서에선 없던 함정).
def encode_standup_cursor(entry: StandupEntry) -> str:
    return f"{entry.date.isoformat()}|{entry.created_at.isoformat()}|{entry.id}"


def parse_standup_cursor(cursor: object) -> tuple[date, datetime, uuid.UUID] | None:
    """docs.py parse_doc_cursor와 동일 방어(story #2540 CI 정정) — FastAPI Query(...) 경유가
    아니라 이 함수를 직접 호출하는 자리(테스트 등)에서 인자를 생략하면 Query 센티널 객체
    그 자체가 들어올 수 있다 — 값의 존재가 아니라 타입으로 「커서 없음」을 가른다."""
    if not isinstance(cursor, str) or not cursor:
        return None
    try:
        date_str, created_at_str, id_str = cursor.split("|", 2)
        return date.fromisoformat(date_str), datetime.fromisoformat(created_at_str), uuid.UUID(id_str)
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Invalid cursor format") from exc

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
        -- 51447ca0: projection — 제출 여부는 entry.project_id 가 아니라 standup_entry_projects
        -- link 로 판정(org-level 엔트리가 링크된 프로젝트서 submitted). "org 1번 제출=linked
        -- 프로젝트 전부 not-missing". legacy 엔트리는 0099 백필 링크로 동일 커버.
        SELECT DISTINCT COALESCE(a.member_id, se.author_id) AS cid
        FROM standup_entries se
        JOIN standup_entry_projects sep ON sep.entry_id = se.id
        LEFT JOIN member_identity_aliases a ON a.alias_id = se.author_id
        WHERE se.org_id = :org AND sep.project_id = :proj AND se.date = :date
    )
    SELECT r.cid FROM roster r WHERE r.cid NOT IN (SELECT cid FROM submitted)
    """
)


class StandupEntryRepository(BaseRepository[StandupEntry]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(StandupEntry, session, org_id)

    async def list(self, limit: int = 1000, **filters: Any) -> list[StandupEntry]:
        """51447ca0: project_id 필터를 standup_entry_projects link join(projection)으로 해소.

        org-level 엔트리(project_id NULL·링크로 surface)도 링크된 프로젝트 뷰에 나타난다.
        EXISTS 라 double-count 없음. legacy 엔트리는 0099 백필 링크로 동일 커버(연속성).
        project_id 외 필터(author_id·sprint_id·date)는 기존대로 컬럼 일치.

        story #2412 AC1 — order_by 없이 limit만 있었다("최근"을 요구하면서 결정적 순서 보장이
        없었다, #2231 표 CAPPED-NO-NEXT-PAGE와 동형). #2248이 `/standups/history`(list_standup_history,
        routers/standups.py)를 raw 쿼리로 우회 고칠 때 "이 메서드는 list_standups(routers/standups.py:181)와
        공유하는 범용이라 여기서 손 안 댄다"고 명시 — 그 남겨둔 쪽을 여기서 고친다. 이 리포에서
        `.list()` 실호출처는 코드베이스 전체에 **routers/standups.py:181(list_standups) 1곳뿐**
        (grep 확認 — routers/sprints.py의 StandupEntryRepository 사용은 `.get_missing()`만, `.list()`
        미호출). 그 1곳이 FE `/api/standup` 화면 프록시 대상이자 MCP get_standup/list_standup_entries
        도구가 공유하는 자리라, 여기 한 번 고치면 셋 다 같이 고쳐진다(다른 소비처가 없어 "한쪽만
        고치는" 분기가 아예 없다). `date`(스탠드업 실제 날짜) 우선 정렬 — `created_at`(제출 시각)은
        같은 date 내 동석차 tiebreak로만(제출 늦은 순이 아니라 날짜 자체가 최근인 게 먼저).
        """
        project_id = filters.pop("project_id", None)
        q = select(StandupEntry).where(self._org_filter())
        for attr, val in filters.items():
            q = q.where(getattr(StandupEntry, attr) == val)
        if project_id is not None:
            q = q.where(
                exists().where(
                    StandupEntryProject.entry_id == StandupEntry.id,
                    StandupEntryProject.project_id == project_id,
                )
            )
        q = q.order_by(StandupEntry.date.desc(), StandupEntry.created_at.desc())
        result = await self.session.execute(q.limit(limit))
        return list(result.scalars().all())

    async def list_paginated(
        self, *, limit: int = 1000, cursor: tuple[date, datetime, uuid.UUID] | None = None,
        project_ids: Collection[uuid.UUID] | None = None, **filters: Any,
    ) -> tuple[list[StandupEntry], int]:
        """story #3841 — `.list()`(위)의 조용한 1000-cap을 true cursor 페이지네이션으로
        대체하는 신규 메서드(`.list()` 자신은 그대로 둔다 — 코드베이스 전체에서 그 메서드의
        실호출처는 없고 이 카드가 유일한 소비처인 list_standups만 옮겨 탄다, 회귀 표면 0).

        base.py::BaseRepository.list_paginated의 규약(total = 필터+**cursor** 適用 後의
        남은 전체 개수 — cursor 前 grand total이 아니다, #2537/페드루 AC 리뷰 정정 그대로
        이 신규 메서드에도 적용)을 그대로 따르되, 정렬이 (date,created_at) 복합키라 그
        범용 메서드(단일 monotonic 컬럼 전제)를 상속하지 않고 GoalRepository.
        _list_paginated_by_position과 동형으로 별도 구현한다."""
        project_id = filters.pop("project_id", None)
        conds = [self._org_filter()]
        for attr, val in filters.items():
            conds.append(getattr(StandupEntry, attr) == val)
        if project_id is not None:
            conds.append(
                exists().where(
                    StandupEntryProject.entry_id == StandupEntry.id,
                    StandupEntryProject.project_id == project_id,
                )
            )
        if project_ids is not None:
            # story #4350 — caller가 접근 가능한 프로젝트에 투영된 기록 + 어느 프로젝트에도 투영되지 않은 org 수준 기록만(SEC-S8).
            # 기록은 org 1행 · 프로젝트 표면은 standup_entry_projects 링크(51447ca0) — 링크로 가른다.
            linked_accessible = exists().where(
                StandupEntryProject.entry_id == StandupEntry.id,
                StandupEntryProject.project_id.in_(list(project_ids)),
            )
            any_link = exists().where(StandupEntryProject.entry_id == StandupEntry.id)
            conds.append(or_(linked_accessible, ~any_link))
        if cursor is not None:
            cursor_date, cursor_created_at, cursor_id = cursor
            conds.append(
                tuple_(StandupEntry.date, StandupEntry.created_at, StandupEntry.id)
                < tuple_(cursor_date, cursor_created_at, cursor_id)
            )

        count_result = await self.session.execute(
            select(func.count()).select_from(StandupEntry).where(*conds)
        )
        total = int(count_result.scalar_one() or 0)

        q = (
            select(StandupEntry).where(*conds)
            .order_by(StandupEntry.date.desc(), StandupEntry.created_at.desc(), StandupEntry.id.desc())
            .limit(limit)
        )
        result = await self.session.execute(q)
        return list(result.scalars().all()), total

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

    async def resync_project_links(self, entry_id: uuid.UUID, project_ids: list[uuid.UUID]) -> None:
        """1c2be9db: org-level write — entry 의 projection 링크를 project_ids 로 **full overwrite**.

        DELETE(entry_id) 후 INSERT — author 접근 프로젝트(accessible) 동기화 경로 전용
        (CP2-B). target 에 없는 기존 링크는 삭제(접근 변동 반영·stale 0). project_ids 는
        accessible_project_ids_in_org(canonical helper) 결과여야 한다(존재하는 project 만 — FK 안전).
        legacy project_id 명시 write 는 이 메서드를 호출하지 않고 upsert 의 additive(ON CONFLICT
        DO NOTHING·미삭제) 만 사용한다.
        """
        await self.session.execute(
            text("DELETE FROM standup_entry_projects WHERE entry_id = :e"),
            {"e": entry_id},
        )
        for pid in project_ids:
            await self.session.execute(
                text(
                    "INSERT INTO standup_entry_projects (id, entry_id, project_id, org_id) "
                    "VALUES (gen_random_uuid(), :e, :p, :o) "
                    "ON CONFLICT (entry_id, project_id) DO NOTHING"
                ),
                {"e": entry_id, "p": pid, "o": self.org_id},
            )

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
