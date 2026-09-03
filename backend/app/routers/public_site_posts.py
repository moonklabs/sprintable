"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 공개 site-posts 읽기 API.

**비인증** 라우트(public_pageview.py/public_docs.py와 동형). 공개 API 계약은 story
15a18511(랜딩·미르코) 본문 "공개 API 계약" 절이 정본 — 이 파일은 그 절의 필드명·상태코드를
문자 그대로 따른다(필드명 하나라도 다르면 랜딩이 조용히 빈 화면을 낸다, PO 명시).

public_key = story #3354(PR#3728)의 org_metering_keys.public_key 그대로 재사용(새 키 개념
발명 0) — 조회수 beacon과 같은 값 하나로 두 API를 다 식별한다.

CORS·Cache-Control은 이 파일 책임 밖(전자는 app/core/public_api_cors.py, 후자는 각 핸들러가
직접 Response 헤더로).

⚠️에러 응답 형상 — 이 앱의 전역 `@app.exception_handler(HTTPException)`(main.py)은 모든
HTTPException을 `{"data": None, "error": {"code", "message"}, "meta": None}` 봉투로
재포장한다(내부 API 전역 관례). 그런데 정본 계약(story 15a18511)은 raw FastAPI 기본형
`{"detail": "not found"}`을 명시했다 — 이 파일은 다른 조직 사이트가 소비하는 외부 공개
계약이라 내부 봉투를 강제할 이유가 없고, 계약이 이미 그렇게 pin됐으므로 `HTTPException`
대신 `JSONResponse`를 직접 반환해 전역 핸들러를 우회한다(다른 공개 라우트에 이 방식을
퍼뜨리자는 게 아니라, 이미 파트너와 문자 그대로 합의된 이 계약만의 예외)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse
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


def _not_found() -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": "not found"})


def _lang_required() -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": "lang is required"})


@router.get("", response_model=SitePostListResponse)
async def list_site_posts_public(
    public_key: str = Query(default=""),
    lang: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    if not lang:
        return _lang_required()
    org_id = await resolve_org_by_public_key(db, public_key)
    if org_id is None:
        return _not_found()
    rows = await list_published_site_posts(db, org_id=org_id, lang=lang)
    body = SitePostListResponse(posts=[
        SitePostListItem(
            slug=r.slug, title=r.title, summary=r.summary, tags=r.tags, lang=r.lang,
            published_at=_iso(r.published_at),
        )
        for r in rows
    ])
    return JSONResponse(
        status_code=200, content=body.model_dump(), headers={"Cache-Control": _CACHE_CONTROL},
    )


@router.get("/{slug}", response_model=SitePostDetailResponse)
async def get_site_post_public(
    slug: str,
    public_key: str = Query(default=""),
    lang: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    if not lang:
        return _lang_required()
    org_id = await resolve_org_by_public_key(db, public_key)
    if org_id is None:
        return _not_found()
    post = await get_published_site_post(db, org_id=org_id, lang=lang, slug=slug)
    if post is None:
        return _not_found()
    body = SitePostDetailResponse(
        slug=post.slug, title=post.title, summary=post.summary, tags=post.tags, lang=post.lang,
        published_at=_iso(post.published_at), body_md=post.body_md, source_story_id=str(post.source_story_id),
    )
    return JSONResponse(
        status_code=200, content=body.model_dump(), headers={"Cache-Control": _CACHE_CONTROL},
    )
