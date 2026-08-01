"""#2375 AC2 — 이미 쌓인, 스트림에 영영 못 실리는 pending dispatched Event를 만료한다.

배경: notification_dispatch.py의 agent branch가 두 가지를 안 채워 왔다(둘 다 이 스토리에서
고쳤다 — #2761 content, #2764 recipient_seq):
1. payload에 `content` 키가 없어(#2761) 어댑터가 ack 前에 조용히 드롭.
2. **더 근본**: `recipient_seq`가 한 번도 배정되지 않아(#2764) agent_gateway.py `/stream`의
   커서 쿼리(`recipient_seq > :after_seq`)를 NULL이 절대 통과 못 한다 — content가 있어도
   스트림/backfill 어디에도 안 잡힌다. PO의 2026-08-01 dev 실측: 47건(content 없음)·8건(content
   있음, #2761 배포 後 생성분 포함) 전부 recipient_seq NULL, delivered 0건.
코드 fix는 **새로 생성되는** Event부터만 적용된다 — 이미 DB에 있는 행의 recipient_seq는 소급
배정되지 않는다.

## AC2 판정: 재전송하지 않고 만료한다 (변경 없음, #2761 판정 유지)
- 이 55건(47+8)은 story 상태변경 등 알림이고, PO가 이미 채팅으로 담당 에이전트에게 수동
  전달했다 — 정보 자체는 이미 도달했다.
- payload/seq를 소급 patch해 "재전송"하면, 이미 지나간 상태변경이 배포 시점에 갑자기 도착하는
  뒤늦은 알림이 된다.
- ⇒ **만료가 맞다.**

## 스코프 정정(2026-08-01, PO 지적) — content가 아니라 recipient_seq가 진짜 조건
```sql
-- 이전(#2761 최초 판) — 47건만 잡고 8건을 놓쳤다:
event_type = 'dispatched' AND status = 'pending' AND NOT (payload ? 'content')
-- 지금 — "스트림에 못 실린다" 그 자체를 조건으로:
event_type = 'dispatched' AND status = 'pending' AND recipient_seq IS NULL
```
human 수신자는 `dispatch_notification()`에서 항상 `status="delivered"`로 즉시 생성되고(SSE를
안 타 seq가 필요 없다) 결코 pending을 거치지 않으므로, `event_type='dispatched' AND
status='pending'`은 이미 사실상 agent 전용 스코프다 — `recipient_seq IS NULL`을 더해도 human
행을 잘못 잡을 여지가 없다(dry-run 출력에서 recipient_type을 같이 찍어 교차 확認한다).
이 fix(#2764) 이후 생성되는 모든 agent-recipient dispatched Event는 항상 recipient_seq를
받으므로, 이 조건은 향후에도 자동으로 "그 fix 이전 잔재"만 골라낸다 — 시간 컷오프 불필요.

## 실행
```
DATABASE_URL=postgresql+asyncpg://... python -m scripts.expire_undeliverable_pending_dispatched_events [--dry-run] [--org-id UUID]
```
기본은 `--dry-run`(카운트만 출력, 미변경) — 실 만료는 `--apply` 명시 필요.

⚠️ 디디(이 스토리 담당)는 dev DB 직접 접근이 막혀 있어(VPC private-IP, 세션 샌드박스에 라우트
없음 — [[reference_prod_db_query]] dev 항목) 이 스크립트를 스스로 실행하지 못했다. PO/QA가
dev에서 `--dry-run` 먼저 돌려 카운트를 대조(약 55건 근사 기대)한 뒤 `--apply`하는 것을 권한다.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid

from sqlalchemy import select, update


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL 미설정", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(
        description="recipient_seq 없는(=스트림에 영영 못 실리는) pending dispatched Event 만료(#2375 AC2)"
    )
    parser.add_argument("--org-id", type=str, default=None, help="특정 org로 스코프(기본: 전 org)")
    parser.add_argument("--apply", action="store_true", help="실제로 만료 처리(기본은 dry-run)")
    args = parser.parse_args()

    from app.core.database import async_session_factory
    from app.models.event import Event

    where = [
        Event.event_type == "dispatched",
        Event.status == "pending",
        Event.recipient_seq.is_(None),
    ]
    if args.org_id:
        where.append(Event.org_id == uuid.UUID(args.org_id))

    async with async_session_factory() as db:
        if not args.apply:
            rows = (await db.execute(
                select(Event.id, Event.org_id, Event.recipient_type, Event.created_at).where(*where)
            )).all()
            non_agent = [r for r in rows if r.recipient_type != "agent"]
            print(f"[dry-run] 만료 대상 {len(rows)}건 (--apply로 실제 만료)")
            if non_agent:
                print(f"  ⚠️ recipient_type != 'agent' 인 행 {len(non_agent)}건 — --apply 前 확認 필요")
            for r in rows[:30]:
                print(f"  event_id={r.id} org_id={r.org_id} recipient_type={r.recipient_type} created_at={r.created_at}")
            if len(rows) > 30:
                print(f"  ... 외 {len(rows) - 30}건")
            return 0

        result = await db.execute(update(Event).where(*where).values(status="expired"))
        await db.commit()
        print(f"만료 완료: {result.rowcount}건")
        return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
