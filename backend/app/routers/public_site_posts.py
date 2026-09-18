"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 공개 site-posts 읽기 API.

**비인증** 라우트(public_pageview.py/public_docs.py와 동형). 공개 API 계약은 story
15a18511(랜딩·미르코) 본문 "공개 API 계약" 절이 정본 — 이 파일은 그 절의 필드명·상태코드를
문자 그대로 따른다(필드명 하나라도 다르면 랜딩이 조용히 빈 화면을 낸다, PO 명시).

public_key = story #3354(PR#3728)의 org_metering_keys.public_key 그대로 재사용(새 키 개념
발명 0) — 조회수 beacon과 같은 값 하나로 두 API를 다 식별한다.

CORS·Cache-Control은 이 파일 책임 밖(전자는 app/core/public_api_cors.py, 후자는 각 핸들러가
직접 Response 헤더로).

에러 응답 형상 — 페드루 PO 판정(2026-09-03, 미르코군 랜딩 lib/site-posts.ts 실측: `res.ok`만
보고 본문은 안 읽음, PR#34 diff): 오류 본문은 계약 밖 — 다른 공개 라우트와 동일하게
`HTTPException`을 그대로 던져 앱 전역 `@app.exception_handler(HTTPException)`(main.py) 봉투
({"data","error","meta"})로 나가게 둔다(특수 케이스 하나 줄이는 쪽이 맞는 판단). 정본 계약도
"오류 본문 형상=앱 전역 봉투·소비자는 status만 본다"로 갱신됨."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.services.pageview_counter import resolve_org_by_public_key
from app.services.site_posts import get_published_site_post, list_published_site_posts

router = APIRouter(prefix="/api/v2/public/site-posts", tags=["public-site-posts"])

_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300"


class SitePostListItem(BaseModel):
    slug: str
    title: str
    summary: str | None
    tags: list
    lang: str
    published_at: str


class SitePostListResponse(BaseModel):
    posts: list[SitePostListItem]


class SitePostDetailResponse(BaseModel):
    slug: str
    title: str
    summary: str
    tags: list
    lang: str
    published_at: str
    body_md: str
    source_story_id: str


def _iso(dt) -> str:
    return dt.isoformat()


async def _resolve_org_or_404(db: AsyncSession, public_key: str) -> uuid.UUID:
    org_id = await resolve_org_by_public_key(db, public_key)
    if org_id is None:
        raise HTTPException(status_code=404, detail="not found")
    return org_id


@router.get("", response_model=SitePostListResponse)
async def list_site_posts_public(
    response: Response,
    public_key: str = Query(default=""),
    lang: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> SitePostListResponse:
    if not lang:
        raise HTTPException(status_code=400, detail="lang is required")
    org_id = await _resolve_org_or_404(db, public_key)
    response.headers["Cache-Control"] = _CACHE_CONTROL
    rows = await list_published_site_posts(db, org_id=org_id, lang=lang)
    return SitePostListResponse(posts=[
        SitePostListItem(
            slug=r.slug, title=r.title, summary=r.summary, tags=r.tags, lang=r.lang,
            published_at=_iso(r.published_at),
        )
        for r in rows
    ])


@router.get("/{slug}", response_model=SitePostDetailResponse)
async def get_site_post_public(
    slug: str,
    response: Response,
    public_key: str = Query(default=""),
    lang: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> SitePostDetailResponse:
    if not lang:
        raise HTTPException(status_code=400, detail="lang is required")
    org_id = await _resolve_org_or_404(db, public_key)
    post = await get_published_site_post(db, org_id=org_id, lang=lang, slug=slug)
    if post is None:
        raise HTTPException(status_code=404, detail="not found")
    response.headers["Cache-Control"] = _CACHE_CONTROL
    return SitePostDetailResponse(
        slug=post.slug, title=post.title, summary=post.summary, tags=post.tags, lang=post.lang,
        published_at=_iso(post.published_at), body_md=post.body_md, source_story_id=str(post.source_story_id),
    )
