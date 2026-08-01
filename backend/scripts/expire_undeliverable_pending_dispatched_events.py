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

## 스코프 정정 2회(2026-08-01, PO 실측 두 번 다 반례로 잡음)
```sql
-- ①(#2761 최초 판) — 47건만 잡고 8건(content 있지만 seq 없음)을 놓쳤다:
event_type = 'dispatched' AND status = 'pending' AND NOT (payload ? 'content')
-- ②(#2764 1차 정정) — "human은 pending을 절대 안 거친다"를 근거로 recipient_type을 안 넣었다가
--   dev 실측에서 반례가 나왔다: human-recipient pending dispatched 6건 존재, 그중 5건이
--   PO가 측정하던 바로 그 순간(03:09:00~03:09:02) 방금 생성된 것 — 죽은 찌꺼기가 아니라
--   지금도 도는 살아 있는 경로. 그 경로가 뭔지는 이 스크립트의 관심사 밖(아래 참조).
event_type = 'dispatched' AND status = 'pending' AND recipient_seq IS NULL
-- ③(지금) — recipient_type='agent'를 조건에 직접 넣는다. dry-run 출력에 "찍는" 것과 WHERE에
--   "거는" 것은 다른 자리다: 찍히기만 하면 사람이 봐야 막히고, 조건에 있으면 구조적으로 안
--   걸린다. 이 스크립트가 애초에 다루려는 건 agent 쪽(#2764가 고친 그 축)뿐이다.
event_type = 'dispatched' AND status = 'pending' AND recipient_seq IS NULL AND recipient_type = 'agent'
```
이 fix(#2764) 이후 생성되는 모든 agent-recipient dispatched Event는 항상 recipient_seq를
받으므로, 이 조건은 향후에도 자동으로 "그 fix 이전 잔재"만 골라낸다 — 시간 컷오프 불필요.

## ⚠️별개로 남겨 두는 것 — 이 PR/스크립트가 안 다루는 것
human-recipient pending dispatched를 만드는 경로가 지금도 살아 있다(위 ② 참조,
`payload->>'event_type'`이 NULL이라 `dispatch_notification()`이 만든 게 아니다 — 다른 생성처).
그 seq=NULL이 human에게 정상(SSE를 안 타 애초에 불필요)인지, 아니면 그쪽도 별도 결함인지는
**미판정**이다. 이 스크립트는 agent 축만 만료하므로 그 human 행들은 손대지 않지만, 판정 자체는
별도로 추적해야 한다.

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
        Event.recipient_type == "agent",
    ]
    if args.org_id:
        where.append(Event.org_id == uuid.UUID(args.org_id))

    async with async_session_factory() as db:
        if not args.apply:
            rows = (await db.execute(
                select(Event.id, Event.org_id, Event.recipient_type, Event.created_at).where(*where)
            )).all()
            print(f"[dry-run] 만료 대상 {len(rows)}건 (--apply로 실제 만료)")
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
