"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각②) — `hosted_site`
(CHANNEL_ADAPTERS 등재, kind="blog") BlogDestinationAdapter 구현체. WordPress·webhook이
나중에 여기 같은 모양(publish/unpublish)으로 붙는다(조각③·④) — 이 파일은 그 1호.

**동작 무변경**(PO 明示) — `site_posts.py::_upsert_site_post_row`/`unpublish_site_post`의
쓰기 로직을 문자 그대로 옮긴다(새 판정·새 분기 0). site_posts.py는 이제 이 모듈을
호출만 한다. URL 조립(`_resolve_public_url`·`_resolve_public_site_display_url`)은
옮기지 않는다 — hosted_site 전용 "표시" 정책(org `site` 커넥터 유무·public_site_base_url
설정)이라 "발행(글 행을 만든다)"과는 다른 축이고, `get_site_post_publication_info`
등 발행 그 자체를 안 하는 다른 호출부도 그 함수들을 그대로 쓴다 — publish() 안으로
욱여넣으면 그 호출부들과 중복이 생긴다.

credential_kind="none"(연결 불요)이라 이 모듈의 함수엔 `client`/`credentials` 파라미터가
없다 — WordPress(REST client+Application Password)·webhook(HTTP client+서명 비밀)이
조각③·④에서 그 파라미터를 실제로 쓰기 시작할 때, 이 모듈은 그 자리에 그냥 안 채운
채로 남는다(어댑터마다 자기 자격 형태만큼만 받는다 — 공통 인터페이스가 "안 쓰는 파라미터"
를 강제하지 않는다)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.site_post import SitePost


async def publish(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    gate_id: uuid.UUID,
    title: str,
    slug: str,
    lang: str,
    summary: str,
    tags: list,
    body_md: str,
    created_by_member_id: uuid.UUID,
) -> SitePost:
    """`site_posts.py::_upsert_site_post_row`(story #3369 추출)를 그대로 옮긴 것 —
    로직 무변경. `publish_site_post`(레거시)·`publish_site_post_from_draft`(신규
    draft 기반) 둘 다 같은 upsert가 필요해 갈렸던 자리 그대로. commit은 호출자 몫
    (신규 경로는 같은 트랜잭션에 activity_log를 얹는다)."""
    now = datetime.now(timezone.utc)
    stmt = pg_insert(SitePost).values(
        id=uuid.uuid4(), org_id=org_id, lang=lang, slug=slug, title=title, summary=summary,
        tags=tags, body_md=body_md, published_at=now, source_story_id=work_item_id,
        gate_id=gate_id, created_by_member_id=created_by_member_id, unpublished_at=None,
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_site_posts_org_lang_slug",
        set_={
            "title": title, "summary": summary, "tags": tags, "body_md": body_md,
            "published_at": now, "source_story_id": work_item_id, "gate_id": gate_id,
            "unpublished_at": None, "updated_at": now,
            # created_by_member_id는 최초 발행자 그대로 — 재발행이 저자를 안 바꾼다.
        },
    ).returning(SitePost)
    return (await db.execute(stmt)).scalar_one()


async def unpublish(*, post: SitePost) -> None:
    """`site_posts.py::unpublish_site_post`의 상태 전환 그 자체를 옮긴 것 — 행 삭제가
    아니라 `unpublished_at` 설정(로직 무변경). commit·ActivityLog 기록은 호출자 몫
    그대로(이 함수는 필드 하나만 건드린다 — 트랜잭션 경계를 이 모듈이 갖지 않는다)."""
    post.unpublished_at = datetime.now(timezone.utc)
