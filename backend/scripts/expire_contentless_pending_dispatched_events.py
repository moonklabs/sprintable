"""#2375 AC2 — 이미 쌓인 payload-content-키-없는 pending dispatched Event를 만료한다.

배경: notification_dispatch.py의 payload 구성에 `content` 키가 없어(이 스토리가 고치는 그
결함) fakechat/hermes 두 어댑터가 ack 前에 조용히 드롭 → 영구 pending으로 쌓였다(2026-07-31
02:42Z~13:45Z, 20건+ 실측). 코드 fix는 **새로 생성되는** Event부터만 적용된다 — 이미 DB에 있는
행의 payload JSON은 소급 변경되지 않는다.

## AC2 판정: 재전송하지 않고 만료한다
- 이 20건+은 story 상태변경 알림이고, PO가 오늘 채팅으로 담당 에이전트에게 이미 수동으로
  전달했다(story #2375 본문 "오늘 하루 종일 그렇게 돌았다") — 정보 자체는 이미 도달했다.
- payload를 소급 patch해 "재전송"하면, 이미 지나간 상태변경(수 시간~하루 전)이 배포 시점에
  갑자기 도착하는 뒤늦은 알림이 된다 — 신선하지 않은 정보를 새 알림처럼 재주입하는 것.
- 그대로 두면(아무 조치 없음) 기존 `POST /events/expire-stale`(30일 pending 컷오프)이 언젠가
  회수하지만, 그 사이 매 SSE 재연결마다 backfill이 이 20+건을 계속 재전송 시도한다(이 스토리가
  고친 AC5 ack-then-skip 경로를 아직 안 거친 구행 payload라 여전히 no-op이지만, 헛수고가 반복).
- ⇒ **만료가 맞다.** 30일 컷오프를 기다리지 않고, "payload에 content 키가 없다"는 구조적
  조건(=이 fix 이전에 생성됐다는 증거, 시간 기반 추측이 아님)으로 지금 바로 회수한다.

## 스코프 — 정밀 타겟팅(시간 창이 아니라 구조 조건)
```sql
event_type = 'dispatched' AND status = 'pending' AND NOT (payload ? 'content')
```
`payload ? 'content'`는 fix 이후 생성되는 모든 새 dispatched Event(content 키 항상 존재)를
자동으로 제외한다 — 시간 컷오프처럼 배포 타이밍에 의존하지 않는 멱등 조건.

## 실행
```
DATABASE_URL=postgresql+asyncpg://... python -m scripts.expire_contentless_pending_dispatched_events [--dry-run] [--org-id UUID]
```
기본은 `--dry-run`(카운트만 출력, 미변경) — 실 만료는 `--apply` 명시 필요.

⚠️ 디디(이 스토리 담당)는 dev DB 직접 접근이 막혀 있어(VPC private-IP, 세션 샌드박스에 라우트
없음 — [[reference_prod_db_query]] dev 항목) 이 스크립트를 스스로 실행하지 못했다. PO/QA가
dev에서 `--dry-run` 먼저 돌려 카운트를 대조(스토리가 실측한 20건+과 근사해야 함)한 뒤 `--apply`
하는 것을 권한다.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid

from sqlalchemy import select, text, update


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL 미설정", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(
        description="content 키 없는 pending dispatched Event 만료(#2375 AC2)"
    )
    parser.add_argument("--org-id", type=str, default=None, help="특정 org로 스코프(기본: 전 org)")
    parser.add_argument("--apply", action="store_true", help="실제로 만료 처리(기본은 dry-run)")
    args = parser.parse_args()

    from app.core.database import async_session_factory
    from app.models.event import Event

    where = [
        Event.event_type == "dispatched",
        Event.status == "pending",
        text("NOT (payload ? 'content')"),
    ]
    if args.org_id:
        where.append(Event.org_id == uuid.UUID(args.org_id))

    async with async_session_factory() as db:
        if not args.apply:
            rows = (await db.execute(select(Event.id, Event.org_id, Event.created_at).where(*where))).all()
            print(f"[dry-run] 만료 대상 {len(rows)}건 (--apply로 실제 만료)")
            for r in rows[:30]:
                print(f"  event_id={r.id} org_id={r.org_id} created_at={r.created_at}")
            if len(rows) > 30:
                print(f"  ... 외 {len(rows) - 30}건")
            return 0

        result = await db.execute(update(Event).where(*where).values(status="expired"))
        await db.commit()
        print(f"만료 완료: {result.rowcount}건")
        return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
