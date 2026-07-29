"""story #2268(E-CONNECT, C-10) — 「세션 시작 컨텍스트」한 호출의 몸통.

AC1: 「여기까지 했고 · 전진 경계 · 내 것」을 한 호출로 준다 —
  ①내 것        = `dashboard_core.get_my_work` 그대로 재사용(재구현 0)
  ②판단과 정정   = `judgment_core.list_judgments`를 work_item마다 재사용(재구현 0) — active
                  원소가 이미 `correction_ids`로 철회를 인라인 표시한다(story #2308/#2611,
                  별도 목록으로 안 뺀다는 이 스토리의 요구를 이미 만족).
  ③전진 경계(부분) = `activity_logs`(PO 판정 2026-07-29, 스레드 e5c0d2ad 이후): 원래 "마지막
                  세션 이후 무엇이 «머지»됐는가"로 물었으나, PR은 「사실」이 아니라 「수단」이고
                  한 스토리에 여럿·에픽/문서엔 아예 없다 — `activity_logs`가 모든 엔티티 타입에
                  같은 모양(entity_type·entity_id·action·created_at)으로 있어 이 축을 전부
                  덮는다(PullRequestStoryLink 기반안은 폐기 — 아래 참고).

⛔폐기한 안: PullRequestStoryLink 테이블로 "최근 머지"를 구하는 것. 이 테이블의 유일한
쓰기처(routers/github_integration.py)가 link_source="explicit"를 하드코딩해 auto_match/sid
매치(실제 PR 대다수)는 애초에 저장되지 않는다 — 그 테이블로 재면 실제 머지 대부분이 빠진
거짓 0에 가까운 수가 된다. 이 갭 자체는 story #2327(trust_pipeline.batch_scope_violation의
동일 근본 결함)로 별도 트래킹.

AC4(모르는 것을 「없음」으로 주지 않는다): `since`가 주어지지 않으면 `recent_activity_by_work_item`
자체가 None이다 — 빈 dict `{}`는 안 쓴다("물어봤는데 없었다"와 "안 물어봤다"가 다른 사실이므로
같은 falsy 값으로 섞으면 그 자체가 거짓이 된다).

AC5(예산): my_stories/my_tasks는 이미 "지금 열린 것"(status != done)으로 좁혀진 집합이라
추가 상한을 두지 않는다. judgments_by_work_item의 `active`는 judgment_core 기존
recency-cap(20)을 그대로 물려받고 `meta.active_omitted_count`가 잘린 개수를 사실 그대로
보고한다(비율로 접지 않는다, PO 판정 2026-07-29 — "8건 중 4건"이 아니라 "4건은 안 실렸다").
recent_activity_by_work_item도 동일 원칙 적용 — 각 work_item의 값 자체에 `omitted_count`를
인라인으로 싣는다(별도 목록으로 안 뺀다는 원칙①을 여기도 동형 적용, 소비자가 한 자리만
읽어도 잘렸는지 알 수 있게). 조회 범위는 「내가 지금 손대려는 것과 교차하는 것만」(PO 지시)
— my_stories/my_tasks에 속한 work_item만 본다, 전체 activity_logs 나열은 하지 않는다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity_log import ActivityLog
from app.services.dashboard_core import get_my_work
from app.services.judgment_core import list_judgments

DEFAULT_RECENT_ACTIVITY_LIMIT = 10


async def _recent_activity_for_one(
    session: AsyncSession, *, org_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID,
    since: datetime, limit: int,
) -> dict:
    base_filters = [
        ActivityLog.org_id == org_id, ActivityLog.entity_type == entity_type,
        ActivityLog.entity_id == entity_id, ActivityLog.created_at >= since,
    ]
    total = (
        await session.execute(select(func.count()).select_from(ActivityLog).where(*base_filters))
    ).scalar_one()
    rows = (
        await session.execute(
            select(ActivityLog).where(*base_filters).order_by(ActivityLog.created_at.desc()).limit(limit)
        )
    ).scalars().all()
    return {
        "items": [
            {
                "id": r.id, "action": r.action, "actor_id": r.actor_id, "actor_type": r.actor_type,
                "created_at": r.created_at, "context": r.context,
            }
            for r in rows
        ],
        "omitted_count": max(0, total - len(rows)),
    }


async def get_session_context(
    session: AsyncSession, *, org_id: uuid.UUID, member_id: uuid.UUID, project_id: uuid.UUID | None,
    since: datetime | None, activity_limit: int = DEFAULT_RECENT_ACTIVITY_LIMIT,
) -> dict:
    """세션 시작 컨텍스트 「한 호출」 진입점. `dashboard_core.get_my_work`/`judgment_core.
    list_judgments`를 그대로 재사용(신규 테이블 0) — 이 함수 자체는 그 둘 + activity_logs를
    work_item 교집합으로 좁혀 묶는 것뿐이다."""
    my_stories, my_tasks = await get_my_work(
        session, org_id=org_id, member_id=member_id, project_id=project_id,
    )

    judgments_by_work_item: dict[str, dict] = {}
    for item in (*my_stories, *my_tasks):
        judgments_by_work_item[str(item.id)] = await list_judgments(
            session, org_id=org_id, work_item_id=item.id, method=None, scope=None,
        )

    recent_activity_by_work_item: dict[str, dict] | None = None
    if since is not None:
        recent_activity_by_work_item = {}
        for entity_type, items in (("story", my_stories), ("task", my_tasks)):
            for item in items:
                recent_activity_by_work_item[str(item.id)] = await _recent_activity_for_one(
                    session, org_id=org_id, entity_type=entity_type, entity_id=item.id,
                    since=since, limit=activity_limit,
                )

    return {
        "my_stories": my_stories,
        "my_tasks": my_tasks,
        "judgments_by_work_item": judgments_by_work_item,
        "recent_activity_since": since,
        "recent_activity_by_work_item": recent_activity_by_work_item,
    }
