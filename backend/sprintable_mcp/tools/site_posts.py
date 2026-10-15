"""story #4581(E-DESKTOP-2 · 1선, 페드루 PO 判定 2026-10-06 08:59Z) — 사이트 글(블로그) 초안 도구를
호스티드 MCP로 올린다(채널 글 도구와 같은 까닭 — tools/channel_posts.py의 #4581 절 참고). 플러그인
(0.9.20 connectors/site-posts.ts)이 부르던 같은 REST · 같은 body. `campaign_id` · `connection_id`는
「안 주면 body에 키 자체를 안 싣는다」 — 서버의 model_fields_set 캐리포워드(site_posts.py)를 지키는
플러그인과 같은 계약(null을 실으면 해제가 된다)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class CreateSitePostDraftInput(SprintableInput):
    work_item_id: str
    title: str
    slug: str
    lang: str
    summary: str
    body_md: str
    tags: list[str] | None = None
    media_manifest: list | None = None
    campaign_id: str | None = None
    connection_id: str | None = None


async def create_site_post_draft(args: CreateSitePostDraftInput) -> list[TextContent]:
    """작업 하나에 붙는 사이트 글(블로그) 초안을 만들거나 새 버전으로 고친다."""
    body: dict = {
        "work_item_id": args.work_item_id, "title": args.title, "slug": args.slug, "lang": args.lang,
        "summary": args.summary, "tags": args.tags or [], "body_md": args.body_md, "media_manifest": args.media_manifest or [],
    }
    # 준 것만 싣는다(안 주면 서버 캐리포워드) — 명시로 준 값은 그대로
    for key in ("campaign_id", "connection_id"):
        if key in args.model_fields_set:
            body[key] = getattr(args, key)
    try:
        result = await client.post(f"/api/v2/organizations/{client.org_id}/site-posts/drafts", json=body)
        return ok(result)
    except Exception as exc:
        return err(exc)


class SubmitSitePostDraftInput(SprintableInput):
    draft_id: str
    version_id: str | None = None


async def submit_site_post_draft(args: SubmitSitePostDraftInput) -> list[TextContent]:
    """사이트 글 초안 버전(생략=최신)을 external_publish 게이트에 올린다 — 발행은 승인 뒤 서버가 한다."""
    try:
        result = await client.post(
            f"/api/v2/organizations/{client.org_id}/site-posts/drafts/{args.draft_id}/submit",
            json={"version_id": args.version_id},
        )
        return ok(result)
    except Exception as exc:
        return err(exc)


class GetSitePostPublicationInput(SprintableInput):
    draft_id: str


async def get_site_post_publication(args: GetSitePostPublicationInput) -> list[TextContent]:
    """사이트 글 초안의 발행 결과(호스티드 사이트 발행 정보)를 서버가 준 그대로."""
    try:
        result = await client.get(f"/api/v2/organizations/{client.org_id}/site-posts/drafts/{args.draft_id}/publication")
        return ok(result)
    except Exception as exc:
        return err(exc)
