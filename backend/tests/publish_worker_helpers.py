"""story #4336 — 즉시 발행이 «요청 = 대기열 · 공급자 호출 = cron 워커»로 바뀐 뒤 테스트가 쓰는 공용 도우미.

예전 테스트는 `POST …/publish` 한 번으로 공급자 호출까지 끝났다고 보고 응답 본문(permalink · 공급자 오류 코드)을 단언했다. 이제
그 요청은 공급자 호출 전 검사(preflight)만 하고 «발행 중»(processing)으로 답한다. 공급자 결과는 워커 한 틱 뒤 명령 · 발행 행 · 초안
상세에 남는다 — 여기 도우미가 «요청 → 워커 한 틱»을 한 줄로 묶는다.
"""
from __future__ import annotations

from datetime import UTC, datetime


async def run_worker_tick(Session, *, at: datetime | None = None) -> dict:
    """발행 명령 워커 한 틱(예산은 운영 스케줄러 시한 1800 − 60과 같게 — 테스트 환경의 요청 시한 기본 300에 막히지 않게)."""
    from app.services.publication_command import process_due_publication_commands

    async with Session() as s:
        return await process_due_publication_commands(s, now=at or datetime.now(UTC), tick_budget_seconds=1740)


async def publish_and_run_worker(client, Session, url: str, **kwargs):
    """`POST …/publish` 뒤, 요청이 대기열에 넣었으면(processing) 워커 한 틱까지. 응답을 그대로 돌려준다(검사 거절 422 · 409 등은
    예전처럼 응답에 있다)."""
    r = await client.post(url, **kwargs)
    if r.status_code == 200 and (r.json() or {}).get("processing") is True:
        await run_worker_tick(Session)
    return r


async def draft_detail(client, org_id, draft_id) -> dict:
    """초안 상세(발행 결과 permalink · external_id · published_at · 명령 상태가 여기 모인다)."""
    r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    return body.get("data", body) if isinstance(body, dict) else body


async def publication_body(Session, draft_id) -> dict:
    """워커가 끝낸 뒤 이 초안의 발행 결과를 예전 즉시 발행 응답과 같은 모양(`processing` · `external_id` · `permalink` ·
    `publication_id` · `published_at`)으로 — 예전 응답 본문을 단언하던 테스트가 같은 단언을 그대로 쓰게."""
    import uuid as _uuid

    from sqlalchemy import select

    from app.models.channel_post_version import ChannelPostVersion
    from app.models.channel_publication import ChannelPublication

    async with Session() as s:
        version_ids = select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == _uuid.UUID(str(draft_id)))
        rows = (await s.execute(
            select(ChannelPublication)
            .where(ChannelPublication.version_id.in_(version_ids))
            .order_by(ChannelPublication.created_at.desc(), ChannelPublication.sequence.asc())
        )).scalars().all()
    head = next((r for r in rows if r.status == "published"), rows[0] if rows else None)
    if head is None:
        return {"processing": True, "external_id": None, "permalink": None, "publication_id": None, "published_at": None}
    return {
        "processing": head.status != "published",
        "external_id": head.external_id,
        "permalink": head.permalink,
        "publication_id": str(head.id),
        "published_at": head.published_at.isoformat() if head.published_at else None,
        "status": head.status,
    }
