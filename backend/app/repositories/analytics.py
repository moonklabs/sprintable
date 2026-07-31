from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.pm import Goal, Sprint, Story, Task
from app.models.team import TeamMember

logger = logging.getLogger(__name__)


def _gate_reason(evidence_status: str | None) -> str:
    """story #2224 후속(오르테가 판정, 2026-07-31) — 「막힘」의 화면 표시용 원인 하나. DB
    값은 식별자, 사람이 읽는 말은 FE 번역 몫(오늘 반복된 규율, #2328 relation_kind와 동일).

    ⛔실측(2026-07-31): requires_human+pending 게이트 32건 전부 evidence_status=
    'insufficient'라 지금은 이 함수가 사실상 "evidence_insufficient" 하나만 낸다 — 그래도
    구조를 열어 두는 이유: doc_approval/artifact_canonicalize/qa 타입처럼 evidence_status가
    구조적으로 항상 NULL인 게이트가 requires_human+pending으로 잡히는 날 "pending_approval"
    이 저절로 뜬다(그때 이 함수를 다시 안 고쳐도 된다). "안 잰 0"과 "잰 0"은 다르다(오늘
    규율) — 지금 한 값뿐인 것도 재서 나온 사실이라 화면이 말할 수 있어야 한다."""
    return "evidence_insufficient" if evidence_status == "insufficient" else "pending_approval"


class AnalyticsRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def _blocked_story_evidence(
        self, story_ids: list[uuid.UUID],
    ) -> dict[uuid.UUID, str | None]:
        """story #2224 후속(오르테가 판정, 2026-07-31) — 「막힘」의 «단일 정의» 자리.
        `get_epics_progress_lane`의 `lane["blocked"]`와 `get_epic_flow_nodes_batch`의
        `blocked_count`/`gate_pending`이 «각자» 조건을 적으면 갈릴 수 있다(오늘 규율:
        "값을 또 적지 말고 그 값 자체를 먹여라" — 여기서는 "조건을 또 적지 말고 같은
        조건을 쓰라"). 그래서 두 자리 모두 이 메서드 하나를 부른다.

        ⛔story #2224 후속(2026-07-31, PO 판정): 옛 필터는 `evidence_status='insufficient'`를
        못박아 doc_approval/artifact_canonicalize/qa 타입 게이트(evidence_status가 구조적으로
        항상 NULL — merge_verdict_gate만 그 필드를 채운다)를 «영영» 못 잡았다. "막힘"이라
        이름 붙여 놓고 실제로는 merge 게이트만 세고 있었다(이름이 약속하는 축과 실제 축이
        다른, 오늘 반복 관측된 병). 그 못박기를 뺐다 — 실측(2026-07-31): requires_human+
        pending 32건이 전부 evidence_status='insufficient'라 이 변경으로 «지금은» 수가 안
        바뀐다(회귀 없음, 아래 test_2224_blocked_definition_widened_no_count_change_realdb
        가 이걸 고정한다).

        반환: story_id -> evidence_status(원본 raw값, None 가능) — 호출자가 멤버십
        (dict의 key)과 원인 표시(`_gate_reason` 입력) 둘 다 이 결과 하나에서 뽑는다."""
        if not story_ids:
            return {}
        rows = (await self.session.execute(
            select(Gate.work_item_id, Gate.evidence_status).where(
                Gate.org_id == self.org_id,
                Gate.work_item_type == "story",
                Gate.work_item_id.in_(story_ids),
                Gate.status == "pending",
                Gate.requires_human.is_(True),
            )
        )).all()
        return {row.work_item_id: row.evidence_status for row in rows}

    async def get_overview(self, project_id: uuid.UUID) -> dict:
        sprints_r = await self.session.execute(
            select(Sprint.status).where(Sprint.project_id == project_id, Sprint.org_id == self.org_id)
        )
        sprint_rows = sprints_r.all()

        epics_r = await self.session.execute(
            select(func.count()).select_from(Goal).where(Goal.project_id == project_id, Goal.org_id == self.org_id)
        )
        epic_count = epics_r.scalar_one()

        stories_r = await self.session.execute(
            select(Story.status, Story.story_points).where(
                Story.project_id == project_id, Story.org_id == self.org_id, Story.deleted_at.is_(None)
            )
        )
        story_rows = stories_r.all()

        tasks_r = await self.session.execute(
            select(func.count()).select_from(Task).join(Story, Task.story_id == Story.id).where(
                Story.project_id == project_id, Task.org_id == self.org_id, Task.deleted_at.is_(None)
            )
        )
        task_count = tasks_r.scalar_one()

        members_r = await self.session.execute(
            select(TeamMember.type).where(
                TeamMember.project_id == project_id, TeamMember.org_id == self.org_id, TeamMember.is_active.is_(True)
            )
        )
        member_rows = members_r.all()

        return {
            "sprints": {
                "total": len(sprint_rows),
                "active": sum(1 for r in sprint_rows if r[0] == "active"),
            },
            "epics": epic_count,
            "stories": {
                "total": len(story_rows),
                "done": sum(1 for r in story_rows if r[0] == "done"),
                "total_points": sum((r[1] or 0) for r in story_rows),
            },
            "tasks": task_count,
            "memos": {"total": 0, "open": 0},
            "members": {
                "total": len(member_rows),
                "humans": sum(1 for r in member_rows if r[0] == "human"),
                "agents": sum(1 for r in member_rows if r[0] == "agent"),
            },
        }

    async def get_member_workload(self, project_id: uuid.UUID, member_id: uuid.UUID) -> dict:
        stories_r = await self.session.execute(
            select(Story.status, Story.story_points).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.assignee_id == member_id,
                Story.deleted_at.is_(None),
            )
        )
        story_rows = stories_r.all()

        tasks_r = await self.session.execute(
            select(Task.status).join(Story, Task.story_id == Story.id).where(
                Story.project_id == project_id,
                Task.org_id == self.org_id,
                Task.assignee_id == member_id,
                Task.deleted_at.is_(None),
            )
        )
        task_rows = tasks_r.all()

        return {
            "stories": {
                "total": len(story_rows),
                "in_progress": sum(1 for r in story_rows if r[0] == "in-progress"),
                "points": sum((r[1] or 0) for r in story_rows),
            },
            "tasks": {
                "total": len(task_rows),
                "in_progress": sum(1 for r in task_rows if r[0] == "in-progress"),
            },
        }

    async def get_velocity_history(self, project_id: uuid.UUID) -> list[dict]:
        result = await self.session.execute(
            select(Sprint.id, Sprint.title, Sprint.velocity, Sprint.status, Sprint.start_date, Sprint.end_date)
            .where(Sprint.project_id == project_id, Sprint.org_id == self.org_id, Sprint.status == "closed")
            .order_by(Sprint.end_date)
        )
        return [
            {"id": r[0], "title": r[1], "velocity": r[2], "status": r[3], "start_date": r[4], "end_date": r[5]}
            for r in result.all()
        ]

    async def get_recent_activity(self, project_id: uuid.UUID, limit: int = 10) -> dict:
        stories_r = await self.session.execute(
            select(Story.id, Story.title, Story.status, Story.updated_at)
            .where(Story.project_id == project_id, Story.org_id == self.org_id, Story.deleted_at.is_(None))
            .order_by(Story.updated_at.desc())
            .limit(limit)
        )
        story_rows = stories_r.all()

        agents_r = await self.session.execute(
            select(TeamMember.id).where(
                TeamMember.project_id == project_id, TeamMember.org_id == self.org_id,
                TeamMember.type == "agent", TeamMember.is_active.is_(True),
            )
        )
        agent_ids = [r[0] for r in agents_r.all()]

        agent_runs: list[dict] = []
        if agent_ids:
            runs_r = await self.session.execute(
                text(
                    "SELECT id, agent_id, trigger, status, created_at FROM agent_runs"
                    " WHERE agent_id = ANY(:ids)"
                    " ORDER BY created_at DESC LIMIT :lim"
                ),
                {"ids": agent_ids, "lim": limit},
            )
            agent_runs = [
                {"id": r[0], "agent_id": r[1], "trigger": r[2], "status": r[3], "created_at": r[4]}
                for r in runs_r.all()
            ]

        return {
            "recent_stories": [
                {"id": r[0], "title": r[1], "status": r[2], "updated_at": r[3]} for r in story_rows
            ],
            "recent_memos": [],
            "recent_agent_runs": agent_runs,
        }

    async def get_epic_progress(self, project_id: uuid.UUID, epic_id: uuid.UUID) -> dict:
        result = await self.session.execute(
            select(Story.status, Story.story_points).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.epic_id == epic_id,
                Story.deleted_at.is_(None),
            )
        )
        rows = result.all()
        total = len(rows)
        done = sum(1 for r in rows if r[0] == "done")
        total_pts = sum((r[1] or 0) for r in rows)
        done_pts = sum((r[1] or 0) for r in rows if r[0] == "done")
        return {
            "total_stories": total,
            "done_stories": done,
            "total_points": total_pts,
            "done_points": done_pts,
            "completion_pct": round((done / total) * 100) if total > 0 else 0,
        }

    async def get_epics_progress_lane(self, project_id: uuid.UUID) -> dict:
        """story #2224(S2-1, 갈래 화면) 좌측 레인 — 미르코 실측: `EpicProgress`에 진행/대기/
        막힘/멈춤 네 칸이 없어 레인이 반만 선다. 에픽마다 따로 부르면 N+1이라 «한 번의 호출»로
        project 전체 에픽의 네 칸을 낸다.

        분류 우선순위(겹치는 신호를 하나로 정리하는 순서 — 다른 순서를 쓰면 답이 달라진다):
          ①막힘(blocked)   = 그 story에 매인 pending Gate가 있고 requires_human=true다
                              (§4-5 "문". ⛔2026-07-31 정의 넓힘 — 옛 정의는 여기에
                              evidence_status='insufficient'까지 못박아 doc_approval/
                              artifact_canonicalize/qa 타입 게이트(evidence_status가
                              구조적으로 항상 NULL — merge_verdict_gate만 그 필드를
                              채운다)를 영영 못 잡았다. "막힘"이라 이름 붙여 놓고 실제로는
                              merge 게이트만 세고 있던 것 — 오늘 반복 관측된 "이름이
                              약속하는 축과 실제 축이 다른" 병. `_blocked_story_evidence`가
                              이 정의를 «한 곳»에서만 낸다(get_epic_flow_nodes_batch와
                              공유 — 두 화면이 각자 조건을 적으면 갈린다).
          ②대기(waiting)   = ①이 아니고 next_action_category=='waiting'(#2262 SSOT 재사용 —
                              verification_pending: self_reported=True·아직 human_verified 안 됨)
          ③진행(in_progress) = ①②가 아니고 status=='in-progress'
          ④멈춤(stalled)   = ①②③이 아니고 status!='done'이고 168시간(민 실측 — §7-③의 "48h"는
                              07-23 시안 값·미재측정, 문서로 남은 값은 168h) 넘게 updated_at 불변
          ⑤그 외(other)    = ①~④ 어디에도 안 잡힘 — ⛔PO 지적(2026-07-30): "합계≠total_stories는
                              의도했어도 화면에서는 거짓말이 된다" — 그래서 이 칸도 명시로 낸다.
                              in_progress+waiting+blocked+stalled+other == total_stories 항상 성립.

        ⛔`other`에 실제로 드는 것 둘(성질이 다름, PO 지적 2026-07-30 — dev 실측 2026-07-30):
          ㉠정상적으로 네 칸 밖(최근 168h 이내 변경된 backlog/ready-for-dev/in-review · done)
            — dev 실측 약 2050/2079건, 압도 다수.
          ㉡pending Gate가 매여 있는데 requires_human=false라 ①막힘에서 빠진 것(2026-07-31
            정의 넓힘 後 — requires_human=True인데 evidence_status가 'insufficient'가
            아닌 경우는 이제 ①에 들어간다). dev 실측 **1건**(requires_human=False·
            evidence_status=None). 「승인도 자동 통과도 안 되는 결재」류와 같은 냄새
            (#2261 계열)나 n=1이라 이 함수에서 별도 칸을 새로 만들지 않는다 — 필요해지면
            (건수가 늘면) 그때 쪼갠다. 지금은 ㉠과 ㉡을 `other` 하나로 합친 채 이 사실만
            기록해 둔다(다음 사람이 "other=잡동사니"로 오인하지 않게).
          참고(2026-07-31 재실측 — 정의 넓힘 前후 수 동일): 정의를 넓혀도 requires_human+
          pending 32건이 전부 evidence_status='insufficient'라 «지금은» 수가 안 바뀐다.
          이 함수(에픽 있는 story만)와 민 실측(org 전체)의 4건 차이는 여전히 epic_id
          유무 스코프 차이일 뿐(버그 아님, 이 엔드포인트 스코프가 "에픽에 속한 것"이라).

        ⛔이 우선순위·168h 임계 둘 다 «잠정»이다 — #2218(S0-1)이 임계를 실측(8~12건 나오는
        값)해 재확定하기 전까지 쓰는 값. 화면에 "이 수는 잠정"이라는 신호를 실어야 한다면
        이 함수가 아니라 호출부(FE 계약)의 몫이다.

        ⛔`stories_without_epic`(PO 판정 2026-07-30, dev 445건 실측 후 뒤집힘): 처음엔
        "미배정 레인을 만들지 않는다 + PO가 4건을 직접 붙인다"였으나, 전체 445건임이 실측되며
        "손으로 못 붙이는 규모"·"에픽 없음은 결함이 아니라 사실"로 판정이 바뀌었다. 레인은
        여전히 안 만들되(445를 한 줄에 담으면 화면을 그 줄이 먹는다), 그 수를 **응답에
        실어** 화면이 "에픽에 속한 것만 여기 있습니다 · 나머지 N건은 이 레인 밖입니다"를
        정직하게 말할 수 있게 한다 — 로그만으로는 화면이 그 말을 할 수 없다.

        ⛔`past_cnt`/`now_cnt`/`upcoming_cnt` + `title`/`done`/`total`/`pct`(급추가, 2026-07-30
        —선생님이 /flow 화면에서 직접 지적): 상단이 "지나온 것│지금│이어질 것"(시간축)을
        약속하는데 그 아래 막대는 그 축을 안 쓰는 진행률(%)이었다 — 이름이 약속하는 축과
        실제 축이 다른, 오늘 하루 반복 관측된 그 병의 또 다른 인스턴스. `epic-flow-nodes`가
        이미 확定한 시간축 정의를 그대로 재사용한다(다른 정의를 새로 만들면 같은 화면에
        "지금"이 두 벌 선다): past=status=='done', now=status in {in-progress, in-review},
        upcoming=나머지(ready-for-dev 포함 — "잡을 수 있는 것"과 "잡고 있는 것"을 안 섞음).
        ⛔에픽마다 `epic-flow-nodes`를 부르면 N+1(100개 에픽=100번) — 이 함수가 이미 한 번에
        긁어온 story 목록을 «재분류만» 해서 새 DB 호출 없이 계산한다. title/done/total/pct는
        Goal(에픽) 테이블 조회 1번을 추가한다(에픽마다가 아니라 project 전체 한 번) — 그래도
        총 쿼리 수는 story 1 + gate 1 + no_epic_count 1 + goal-title 1 = 4, 에픽 개수와 무관."""
        stories_r = await self.session.execute(
            select(Story.id, Story.epic_id, Story.status, Story.updated_at).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.deleted_at.is_(None),
                Story.epic_id.is_not(None),
            )
        )
        stories = stories_r.all()
        story_ids = [s.id for s in stories]

        # ⭐PO 판정(2026-07-30, 에픽 없는 막힘 4건 건): "미배정" 레인은 안 만든다(만들면 에픽
        # 안 다는 것이 "괜찮은 일"이 되어 그 줄이 계속 자란다) — 대신 «에픽 없는 story 전량»을
        # 셀 수 있게 로그로 남긴다(㉡류와 같은 방식 — 칸은 안 만들되 0이 아니면 누군가 안다).
        no_epic_count_r = await self.session.execute(
            select(func.count(Story.id)).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.deleted_at.is_(None),
                Story.epic_id.is_(None),
            )
        )
        no_epic_count = no_epic_count_r.scalar_one()
        if no_epic_count:
            logger.info(
                "get_epics_progress_lane: epic 없는 story count=%d project_id=%s "
                "(이 레인 자체에서 영영 안 보임 — story #2224 PO 판정: 미배정 레인을 만들지 "
                "않고 PO가 직접 에픽에 붙인다, 이 로그는 재발 감지용)",
                no_epic_count, project_id,
            )

        from app.services.evidence_service import batch_has_evidence, batch_human_verified

        evidence_ids = await batch_has_evidence(self.session, story_ids, "story")
        verified_map = await batch_human_verified(self.session, story_ids, "story")

        blocked_evidence = await self._blocked_story_evidence(story_ids)
        blocked_ids = set(blocked_evidence.keys())

        # ⭐PO 지적(2026-07-30) — 2026-07-31 정의 넓힘에 맞춰 갱신: ㉡류는 이제 "pending
        # Gate가 매였는데 requires_human=False라 blocked 밖으로 빠진 것" 하나뿐이다(예전엔
        # requires_human=True인데 evidence_status가 'insufficient'가 아닌 경우도 ㉡이었으나,
        # 그 경우는 이제 blocked에 들어간다 — 위 _blocked_story_evidence 참조). 늘어나는 것을
        # "누가 아는가"가 남아 매 호출마다 로그로 남긴다(dev 실측 2026-07-30: 1건).
        gated_not_blocked_r = await self.session.execute(
            select(func.count(Gate.work_item_id.distinct())).where(
                Gate.org_id == self.org_id,
                Gate.work_item_type == "story",
                Gate.work_item_id.in_(story_ids),
                Gate.status == "pending",
                Gate.requires_human.is_(False),
            )
        )
        gated_not_blocked_count = gated_not_blocked_r.scalar_one()
        if gated_not_blocked_count:
            logger.info(
                "get_epics_progress_lane: gated-but-not-blocked(㉡) count=%d project_id=%s "
                "(pending Gate 있으나 requires_human=False — other에 섞임, "
                "story #2224 PO 지적 — 늘면 별도 칸 분리 검토)",
                gated_not_blocked_count, project_id,
            )

        from app.services.next_action import next_action_category, verification_next_action

        now = datetime.now(timezone.utc)
        stall_threshold_hours = 168  # 민 실측(문서 기록값) — 48h는 07-23 시안의 미재측정 값

        # 급추가(2026-07-30): 에픽 title — 한 번에 전부(에픽마다 아님, N+1 회피).
        epic_ids_present = {s.epic_id for s in stories}
        titles_r = await self.session.execute(
            select(Goal.id, Goal.title).where(Goal.id.in_(epic_ids_present))
        )
        titles_by_id = {row.id: row.title for row in titles_r.all()}

        lanes: dict[str, dict] = {}
        zones: dict[str, dict] = {}
        for s in stories:
            epic_key = str(s.epic_id)
            lane = lanes.setdefault(
                epic_key,
                {"in_progress": 0, "waiting": 0, "blocked": 0, "stalled": 0, "other": 0},
            )
            zone = zones.setdefault(
                epic_key,
                {
                    "title": titles_by_id.get(s.epic_id), "total": 0, "done": 0,
                    "past_cnt": 0, "now_cnt": 0, "upcoming_cnt": 0,
                },
            )
            zone["total"] += 1
            # 시간축(epic-flow-nodes와 동일 정의 재사용) — 위 5분류축과는 다른 별개 축이다.
            if s.status == "done":
                zone["done"] += 1
                zone["past_cnt"] += 1
            elif s.status in ("in-progress", "in-review"):
                zone["now_cnt"] += 1
            else:
                zone["upcoming_cnt"] += 1

            if s.id in blocked_ids:
                lane["blocked"] += 1
                continue
            self_reported = s.id in evidence_ids
            human_verified = True if s.id in verified_map else None
            code = verification_next_action(self_reported=self_reported, human_verified=human_verified)
            if next_action_category(code) == "waiting":
                lane["waiting"] += 1
                continue
            if s.status == "in-progress":
                lane["in_progress"] += 1
                continue
            if s.status != "done":
                age_hours = (now - s.updated_at).total_seconds() / 3600
                if age_hours > stall_threshold_hours:
                    lane["stalled"] += 1
                    continue
            lane["other"] += 1  # done, 또는 backlog/ready-for-dev/in-review 중 최근 변경된 것

        for epic_key, zone in zones.items():
            zone["pct"] = round((zone["done"] / zone["total"]) * 100) if zone["total"] > 0 else 0

        return {"lanes": lanes, "zones": zones, "stories_without_epic": no_epic_count}

    async def get_epic_flow_nodes(
        self, project_id: uuid.UUID, epic_id: uuid.UUID, upcoming_limit: int = 15,
    ) -> dict:
        """story #2224(S2-1, 갈래 화면) 노드 계약 — 단일 에픽 편의 래퍼. 실 쿼리는
        `get_epic_flow_nodes_batch`(story #2679, 2026-07-30 — L3 캔버스가 여러 레인을
        «한 화면»에 동시에 그리게 되며 «에픽 하나»뿐이던 이 계약이 레인 수만큼 호출을
        요구하게 됐다, 오늘 금지한 그 패턴)가 하고, 이 메서드는 배치 결과에서 하나만 꺼낸다
        — 로직을 두 곳에 두지 않는다."""
        batch = await self.get_epic_flow_nodes_batch(project_id, [epic_id], upcoming_limit)
        return batch["epics"][0]

    # ⛔story #2679 AC1(2026-07-30, PO 급요청 — #2346보다 먼저): epic_ids 상한. 179개 에픽
    # 전체를 한 번에 받으면(에픽당 최대 141건 실측) 응답이 죽는다 — L3 캔버스가 실제로
    # 동시에 그리는 레인 수(오늘 예시 6개)보다 5배 넉넉히 잡는다. 넘으면 앞 N개만 처리하고
    # 잘린 epic_id들을 명시한다(오늘 규율 그대로 — "없앤 것"이 아니라 "안 그린 것").
    EPIC_FLOW_NODES_BATCH_MAX = 30

    async def get_epic_flow_nodes_batch(
        self, project_id: uuid.UUID, epic_ids: list[uuid.UUID], upcoming_limit: int = 15,
    ) -> dict:
        """story #2679 — epic_flow_nodes를 N개 에픽에 대해 «한 번의 호출»로 낸다(FE가
        이미 아는 epic_id 목록을 넘긴다 — lane과 다른 정렬을 새로 판정하지 않는다, PO 판정).

        N+1 없음: story 쿼리 1번(전체 epic_ids에 IN) + Gate 쿼리 1번(전체 story_ids에 IN) —
        에픽 개수와 무관하게 쿼리 수 고정, get_epics_progress_lane과 같은 패턴.

        세 구역(시간축) 정의는 get_epic_flow_nodes(단일)와 100% 동일(한 자리에서만 정의 —
        두 곳이 각자 정의하면 갈린다): ①지금=in-progress+in-review ②이어질=나머지(상위
        upcoming_limit만, 막힌 것>ready-for-dev>나머지 순) ③지나온=done(수만).

        ⛔story #2679 후속(2026-07-30, PO 판정 — /flow 초점 스트립 4종 수치 중 둘): 새 쿼리 없이
        이미 fetch한 stories/blocked_ids에서 파생만 한다.
          `blocked_count` — get_epics_progress_lane의 lane["blocked"]와 «같은 자리»
            (`_blocked_story_evidence`)에서 나온다 — 형제 화면과 갈릴 수 없다(조건을
            두 번 안 적는다, 2026-07-31 정의 넓힘 때 한 곳으로 합쳤다).
          `last_changed_at` — ⛔「멈춘 시간」의 옳은 정의는 「마지막 머지/배포 이후」이나 그
            소스가 없다(merged_at 저장 안 됨·배포 추적 테이블 없음, PR 본문 참조). 지금 잴 수
            있는 것은 Story.updated_at 최댓값뿐이라 이름을 「마지막 변경 이후」로 좁혀 낸다 —
            «재는 것보다 이름이 넓으면 화면이 거짓말한다»(오늘 규율). ISO 문자열 그대로 반환
            (시간→N시간 환산은 FE 몫, 화면에 시계가 있다).

        ⛔story #2224 후속(오르테가 판정, 2026-07-31) — 노드마다 `gate_pending`·`gate_reason`
        신설(미르코가 노드 위에 문을 그리려면 «어느 노드가 막혔는지»가 필요, blocked_count는
        에픽 단위 합계뿐이라 개별 노드에 못 붙는다). 새 쿼리 없음 — `_blocked_story_evidence`
        가 이미 story_ids 전체를 한 번에 조회해 두므로 `_node()`에서 dict 조회만 한다.
        """
        requested = list(dict.fromkeys(epic_ids))  # 순서 보존 중복 제거
        processed = requested[: self.EPIC_FLOW_NODES_BATCH_MAX]
        skipped = requested[self.EPIC_FLOW_NODES_BATCH_MAX:]

        stories_r = await self.session.execute(
            select(
                Story.id, Story.story_number, Story.title, Story.status,
                Story.assignee_id, Story.updated_at, Story.epic_id,
            ).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.epic_id.in_(processed),
                Story.deleted_at.is_(None),
            )
        )
        stories = stories_r.all()
        story_ids = [s.id for s in stories]

        blocked_evidence = await self._blocked_story_evidence(story_ids)
        blocked_ids = set(blocked_evidence.keys())

        def _node(s) -> dict:
            gate_pending = s.id in blocked_ids
            return {
                "id": str(s.id),
                "story_number": s.story_number,
                "title": s.title,
                "status": s.status,
                "assignee_id": str(s.assignee_id) if s.assignee_id else None,
                "updated_at": s.updated_at.isoformat(),
                "gate_pending": gate_pending,
                "gate_reason": _gate_reason(blocked_evidence[s.id]) if gate_pending else None,
            }

        by_epic: dict[uuid.UUID, dict] = {
            eid: {
                "now_items": [], "upcoming_all": [], "past_count": 0,
                "blocked_count": 0, "last_changed_at": None,
            }
            for eid in processed
        }
        for s in stories:
            bucket = by_epic[s.epic_id]
            # ⛔story #2679(2026-07-30, PO 판정) — 초점 스트립 「문 앞 N」: blocked_ids가
            # _blocked_story_evidence(위)에서 나와 get_epics_progress_lane의 lane["blocked"]와
            # «같은 조건»이다(그 형제 메서드와 갈리면 두 화면이 다른 수를 말한다).
            if s.id in blocked_ids:
                bucket["blocked_count"] += 1
            # ⛔story #2679 「멈춘 시간」 재료 — PO 판정(2026-07-30): 「최근 머지/배포 이후」가
            # 옳은 정의이나 그 소스가 없다(merged_at·배포 추적 테이블 전무, PR본문 참조).
            # 지금 잴 수 있는 것은 Story.updated_at 최댓값뿐이라 «마지막 변경 이후»로 이름을
            # 좁혀 낸다(재는 것보다 이름이 넓으면 화면이 거짓말한다 — 오늘 규율의 거울상).
            if bucket["last_changed_at"] is None or s.updated_at > bucket["last_changed_at"]:
                bucket["last_changed_at"] = s.updated_at
            if s.status == "done":
                bucket["past_count"] += 1
            elif s.status in ("in-progress", "in-review"):
                bucket["now_items"].append(_node(s))
            else:
                priority = 0 if s.id in blocked_ids else (1 if s.status == "ready-for-dev" else 2)
                bucket["upcoming_all"].append((priority, s.updated_at, _node(s)))

        epics_out = []
        for eid in processed:
            bucket = by_epic[eid]
            upcoming_all = bucket["upcoming_all"]
            upcoming_all.sort(key=lambda t: (t[0], -t[1].timestamp()))
            upcoming_shown = [n for _, _, n in upcoming_all[:upcoming_limit]]
            epics_out.append({
                "epic_id": str(eid),
                "now": {"total": len(bucket["now_items"]), "items": bucket["now_items"]},
                "upcoming": {
                    "total": len(upcoming_all), "shown": len(upcoming_shown), "items": upcoming_shown,
                },
                "past": {"total": bucket["past_count"]},
                "blocked_count": bucket["blocked_count"],
                "last_changed_at": (
                    bucket["last_changed_at"].isoformat() if bucket["last_changed_at"] else None
                ),
            })

        return {
            "epics": epics_out,
            "requested_count": len(requested),
            "processed_count": len(processed),
            "skipped_epic_ids": [str(eid) for eid in skipped],
        }

    async def get_agent_stats(self, project_id: uuid.UUID, agent_id: uuid.UUID) -> dict:
        member_r = await self.session.execute(
            select(TeamMember.id).where(
                TeamMember.id == agent_id,
                TeamMember.project_id == project_id,
                TeamMember.org_id == self.org_id,
                TeamMember.type == "agent",
            )
        )
        if member_r.scalar_one_or_none() is None:
            return None  # type: ignore[return-value]

        # stories 기반 실제 기여 지표 (is_excluded=true 오염 데이터 제외)
        stories_r = await self.session.execute(
            select(Story.status, Story.story_points, Story.created_at, Story.updated_at)
            .where(
                Story.assignee_id == agent_id,
                Story.org_id == self.org_id,
                Story.deleted_at.is_(None),
                Story.is_excluded.is_(False),
            )
        )
        all_stories = stories_r.all()
        done_stories = [s for s in all_stories if s[0] == "done"]

        done_sp = sum((s[1] or 0) for s in done_stories)

        lead_times_ms: list[int] = []
        for s in done_stories:
            created, updated = s[2], s[3]
            if created and updated:
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                if updated.tzinfo is None:
                    updated = updated.replace(tzinfo=timezone.utc)
                delta_ms = int((updated - created).total_seconds() * 1000)
                if delta_ms > 0:
                    lead_times_ms.append(delta_ms)
        avg_lead_time_ms = round(sum(lead_times_ms) / len(lead_times_ms)) if lead_times_ms else 0

        return {
            "completed": len(done_stories),
            "total_stories": len(all_stories),
            "done_story_points": done_sp,
            "avg_lead_time_ms": avg_lead_time_ms,
            # 스키마 하위 호환 필드
            "total_runs": len(all_stories),
            "failed": 0,
            "total_tokens": 0,
            "total_cost_usd": 0.0,
            "avg_duration_ms": 0,
        }

    async def get_project_health(self, project_id: uuid.UUID) -> dict:
        sprint_r = await self.session.execute(
            select(Sprint.id, Sprint.title, Sprint.start_date, Sprint.end_date, Sprint.duration)
            .where(Sprint.project_id == project_id, Sprint.org_id == self.org_id, Sprint.status == "active")
            .limit(1)
        )
        sprint_row = sprint_r.first()

        open_memo_count = 0

        unassigned_r = await self.session.execute(
            select(func.count()).select_from(Story).where(
                Story.project_id == project_id, Story.org_id == self.org_id,
                Story.assignee_id.is_(None), Story.status != "done", Story.deleted_at.is_(None),
            )
        )
        unassigned_count = unassigned_r.scalar_one()

        sprint_progress = 0
        if sprint_row:
            stories_r = await self.session.execute(
                select(Story.status).where(Story.sprint_id == sprint_row[0], Story.deleted_at.is_(None))
            )
            story_statuses = [r[0] for r in stories_r.all()]
            total = len(story_statuses)
            done = sum(1 for s in story_statuses if s == "done")
            sprint_progress = round((done / total) * 100) if total > 0 else 0

        return {
            "active_sprint": {
                "id": sprint_row[0], "title": sprint_row[1],
                "start_date": sprint_row[2], "end_date": sprint_row[3],
            } if sprint_row else None,
            "sprint_progress": sprint_progress,
            "open_memos": open_memo_count,
            "unassigned_stories": unassigned_count,
            "health": "warning" if open_memo_count > 10 or unassigned_count > 5 else "good",
        }

    async def get_burndown(self, sprint_id: uuid.UUID) -> dict | None:
        # E-SECURITY SEC-S8(story 83ea3d6a) DD(까심 라이브확定, CRITICAL·cross-org): 이 파일의
        # 다른 메소드는 전부 org_id를 필터에 넣는데(예: get_overview) 이 둘만 org_id 필터가
        # 없어 완전 무관 org가 sprint UUID만 알면 velocity/status를 그대로 열람할 수 있었다.
        sprint_r = await self.session.execute(
            select(Sprint).where(Sprint.id == sprint_id, Sprint.org_id == self.org_id)
        )
        sprint = sprint_r.scalar_one_or_none()
        if sprint is None:
            return None

        stories_r = await self.session.execute(
            select(Story.story_points, Story.status, Story.updated_at)
            .where(Story.sprint_id == sprint_id, Story.org_id == self.org_id, Story.deleted_at.is_(None))
        )
        stories = stories_r.all()

        total_pts = sum((r[0] or 0) for r in stories)
        done_pts = sum((r[0] or 0) for r in stories if r[1] == "done")
        remaining = total_pts - done_pts

        # 8a2bbda2: stored duration(default 14·날짜 무관) 대신 날짜에서 산출(dates 단일진실)
        from app.schemas.sprint import compute_sprint_duration
        duration = compute_sprint_duration(sprint.start_date, sprint.end_date, sprint.duration) or 14
        start_date = sprint.start_date

        ideal_line = []
        for day in range(duration + 1):
            if start_date:
                from datetime import timedelta
                day_date = (datetime.combine(start_date, datetime.min.time()) + timedelta(days=day)).strftime("%Y-%m-%d")
            else:
                day_date = str(day)
            ideal_line.append({"date": day_date, "points": round(total_pts * (1 - day / duration)) if duration else 0})

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        start_str = start_date.isoformat() if start_date else today
        actual_line = [
            {"date": start_str, "points": total_pts},
            {"date": today, "points": remaining},
        ]

        return {
            "sprint": {
                "id": sprint.id, "title": sprint.title, "status": sprint.status,
                "start_date": sprint.start_date, "end_date": sprint.end_date,
                "duration": compute_sprint_duration(sprint.start_date, sprint.end_date, sprint.duration),
                "velocity": sprint.velocity,
            },
            "total_points": total_pts,
            "done_points": done_pts,
            "remaining_points": remaining,
            "completion_pct": round((done_pts / total_pts) * 100) if total_pts > 0 else 0,
            "stories_count": len(stories),
            "done_count": sum(1 for r in stories if r[1] == "done"),
            "ideal_line": ideal_line,
            "actual_line": actual_line,
        }

    async def get_sprint_velocity(self, sprint_id: uuid.UUID) -> dict | None:
        # E-SECURITY SEC-S8(story 83ea3d6a) DD: get_burndown과 동형 cross-org 갭.
        result = await self.session.execute(
            select(Sprint.velocity, Sprint.title, Sprint.status).where(
                Sprint.id == sprint_id, Sprint.org_id == self.org_id
            )
        )
        row = result.first()
        if row is None:
            return None
        return {"velocity": row[0], "title": row[1], "status": row[2]}

    async def get_leaderboard(
        self,
        project_id: uuid.UUID,
        period: str = "all",
        limit: int = 50,
        cursor: str | None = None,
    ) -> list[dict]:
        limit = min(limit, 100)

        # S20 전수스캔(산티아고 SME fast-follow, sibling — reward.py:leaderboard와 동형):
        # reward_balances 뷰는 org_id 컬럼이 없어 SQL 필터 불가·caller가 project_id를 caller
        # org 소속인지 사전 검증해야 한다(현재 미라우팅 dead code지만 향후 재배선 landmine 방지).
        if period == "all":
            q = "SELECT member_id, balance FROM reward_balances WHERE project_id = :pid ORDER BY balance DESC"
            params: dict = {"pid": str(project_id), "lim": limit}
            if cursor:
                q += " AND balance < :cursor"
                params["cursor"] = float(cursor)
            q += " LIMIT :lim"
            result = await self.session.execute(text(q), params)
            return [{"member_id": r[0], "balance": float(r[1])} for r in result.all()]

        period_ms = {"daily": 86400, "weekly": 7 * 86400, "monthly": 30 * 86400}
        seconds = period_ms.get(period, 86400)
        params2: dict = {"pid": str(project_id), "org_id": str(self.org_id), "seconds": seconds}
        q2 = (
            "SELECT member_id, SUM(amount) AS balance FROM reward_ledger"
            " WHERE project_id = :pid AND org_id = :org_id"
            " AND created_at >= NOW() - (:seconds || ' seconds')::interval"
            " GROUP BY member_id ORDER BY balance DESC LIMIT :lim"
        )
        params2["lim"] = limit
        result2 = await self.session.execute(text(q2), params2)
        return [{"member_id": r[0], "balance": float(r[1])} for r in result2.all()]

    async def get_goal_edges(self, project_id: uuid.UUID) -> list[dict]:
        """story #2360 — 목표(에픽) 간 「낳음」 연결을 목표 쌍 단위로 집계한다. 지금까지
        유일한 읽기 길은 `GET /stories/{id}/backlinks`(스토리 한 건씩·limit 200·최대
        10페이지)뿐이라 목표 간 선 하나에 「스토리 수 × 1~10 콜」이 들었다 — 이 메서드는
        스토리 수·건수와 무관한 «고정 2쿼리»로 낸다(AC6 — 그게 이 메서드의 존재 이유다).

        두 소스를 합산한다(유나 축 판정 — 가르는 건 «사람이 봐야 하는가»이므로 둘 다
        실선이다):
          ① entity_references(relation='created_from') — 이 표엔 kind 축 자체가 없다
             (relation 컬럼은 'none'|'created_from'뿐, spawned/followed/superseded는
             reference_semantic_candidates에만 있는 별개 컬럼) — kind=None으로 집계.
          ② reference_semantic_candidates(status='declared') — relation_kind를 kind로.

        ⛔SQL에서 미리 GROUP BY 하지 않는다 — reference_semantic_candidates는 source_field
        (description/acceptance_criteria)가 유니크 키에 포함돼 같은 스토리 쌍이 두 field
        모두에서 발견되면 행이 2개일 수 있다. 그리고 같은 스토리 쌍이 entity_references와
        reference_semantic_candidates 양쪽에 «동시에» 걸릴 수도 있다(created_from으로도
        기록되고 별도로 declared로도 승격된 경우). "count = 스토리 «쌍»의 수"(AC 문구
        그대로)를 지키려면 스토리 쌍 단위로 먼저 dedup한 뒤에 목표 쌍으로 올려야 한다 —
        그래서 두 쿼리는 raw 행만 내고, dedup·kind 판정은 여기(파이썬)에서 한다(쿼리
        개수는 여전히 고정 2개 — AC6 위반 아님).

        A→A(같은 목표 안)·epic_id가 한쪽이라도 NULL인 쌍은 두 쿼리 WHERE 절에서 제외한다
        (목표 «간» 연결의 정의 그대로, AC4/5)."""
        from sqlalchemy.orm import aliased

        from app.models.reference import Reference
        from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

        src1, tgt1 = aliased(Story), aliased(Story)
        created_from_rows = (await self.session.execute(
            select(Reference.source_id, Reference.target_id, src1.epic_id, tgt1.epic_id)
            .select_from(Reference)
            .join(src1, src1.id == Reference.source_id)
            .join(tgt1, tgt1.id == Reference.target_id)
            .where(
                Reference.org_id == self.org_id,
                Reference.source_type == "story",
                Reference.target_type == "story",
                Reference.relation == "created_from",
                src1.project_id == project_id,
                tgt1.project_id == project_id,
                src1.epic_id.is_not(None),
                tgt1.epic_id.is_not(None),
                src1.epic_id != tgt1.epic_id,
            )
        )).all()

        src2, tgt2 = aliased(Story), aliased(Story)
        declared_rows = (await self.session.execute(
            select(
                ReferenceSemanticCandidate.source_id, ReferenceSemanticCandidate.target_id,
                ReferenceSemanticCandidate.relation_kind, src2.epic_id, tgt2.epic_id,
            )
            .select_from(ReferenceSemanticCandidate)
            .join(src2, src2.id == ReferenceSemanticCandidate.source_id)
            .join(tgt2, tgt2.id == ReferenceSemanticCandidate.target_id)
            .where(
                ReferenceSemanticCandidate.org_id == self.org_id,
                ReferenceSemanticCandidate.source_type == "story",
                ReferenceSemanticCandidate.target_type == "story",
                ReferenceSemanticCandidate.status == "declared",
                src2.project_id == project_id,
                tgt2.project_id == project_id,
                src2.epic_id.is_not(None),
                tgt2.epic_id.is_not(None),
                src2.epic_id != tgt2.epic_id,
            )
        )).all()

        # story-쌍 단위 dedup: (source_id, target_id) -> {kinds seen for that pair}.
        # created_from 기여분은 "종류 없음" sentinel로 None을 넣는다.
        pair_kinds: dict[tuple[uuid.UUID, uuid.UUID], set] = {}
        pair_epics: dict[tuple[uuid.UUID, uuid.UUID], tuple[uuid.UUID, uuid.UUID]] = {}

        for source_id, target_id, src_epic, tgt_epic in created_from_rows:
            key = (source_id, target_id)
            pair_kinds.setdefault(key, set()).add(None)
            pair_epics[key] = (src_epic, tgt_epic)

        for source_id, target_id, relation_kind, src_epic, tgt_epic in declared_rows:
            key = (source_id, target_id)
            pair_kinds.setdefault(key, set()).add(relation_kind)
            pair_epics[key] = (src_epic, tgt_epic)

        # 목표 쌍 단위 롤업 — 위에서 이미 스토리 쌍 단위로 dedup됐으므로 여기서는 그
        # 결과(쌍마다 정확히 1개)만 센다.
        agg: dict[tuple[uuid.UUID, uuid.UUID], dict] = {}
        for pair, kinds in pair_kinds.items():
            epic_pair = pair_epics[pair]
            bucket = agg.setdefault(epic_pair, {"count": 0, "kinds": set()})
            bucket["count"] += 1
            # 한 스토리 쌍 자체가 이미 여러 종류로 걸려 있으면(예: description은
            # created_from, acceptance_criteria는 declared·다른 kind) 그 쌍 자체가
            # 모호하다 — None으로 접어 목표 쌍 레벨의 「섞이면 null」로 자연히 흡수시킨다.
            resolved_kind = next(iter(kinds)) if len(kinds) == 1 else None
            bucket["kinds"].add(resolved_kind)

        result: list[dict] = []
        for (from_id, to_id), bucket in agg.items():
            kinds = bucket["kinds"]
            kind = next(iter(kinds)) if len(kinds) == 1 else None
            result.append({
                "from_goal_id": from_id, "to_goal_id": to_id,
                "count": bucket["count"], "kind": kind,
            })
        return result
