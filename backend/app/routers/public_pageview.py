"""story #3354(마케팅자동화·측정, 페드루 PO 확定 2026-09-03) — 공개 글 페이지 beacon.

**비인증** 라우트(public_docs.py와 동형 — 인증 Depends 의도적 생략). 개인정보 0(PO AC): UA는
해시해 레이트리밋 키로만 쓰고 어디에도 영속 저장 안 함, IP·쿠키 저장 0. org 식별은 body의
`public_key`(비밀 아닌 공개 식별자, org_metering_keys 참고) — 모르는 키는 침묵 204(존재
유출 안 함, public_docs.py의 unknown→에러 노출과 달리 이쪽은 beacon이라 클라이언트가 응답을
안 읽으므로 오히려 구분 없는 204가 더 안전한 선택).

CORS는 `app/core/public_api_cors.py::PublicApiCorsMiddleware`(공개 API 공용, story #3360이
`/site-posts` 추가하며 일반화)가 담당 — 이 파일엔 CORS 로직 없음."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.services.pageview_counter import record_pageview, record_pageview_utm, resolve_org_by_public_key
from app.services.rate_limiter import get_rate_limiter

router = APIRouter(prefix="/api/v2/public", tags=["public-pageview"])

# 최소 봇 필터(처방 3항) — UA 문자열 규칙만, 정교한 탐지는 스코프 밖(PO 확定 "최소").
_BOT_UA_RE = re.compile(r"bot|spider|crawl|slurp|headless", re.IGNORECASE)

_DEDUP_WINDOW_LIMIT = 1  # 레이트리밋 윈도우(rate_limiter.WINDOW_SECS=60s)당 같은 (org,path,ua) 1회만 — AC "1분 내 재요청 억제"

_UTM_MAX_LEN = 256  # UTM 파라미터 값 — referrer(1024)보다 훨씬 짧은 슬러그성 값이라 별도 상한.


def _normalize_utm(value: str | None) -> str | None:
    """story #3506(Phase2·마케팅운영) — utm_* 4필드는 referrer와 달리 «영속»된다(PO
    決定 (d)) — 소문자+trim 정규화(대소문자만 다른 같은 캠페인이 다른 그룹으로
    쪼개지지 않게) 후 빈 문자열이면 "차원 없음"(None)으로 접는다. 길이 상한 초과는
    거부가 아니라 잘라 저장(PO 明示 — beacon 페이지가 못 믿을 querystring을 그대로
    보낼 수 있어도 요청 자체를 실패시키지 않는다)."""
    if value is None:
        return None
    normalized = value.strip().lower()[:_UTM_MAX_LEN]
    return normalized or None


class PageviewBeaconRequest(BaseModel):
    public_key: str = Field(..., min_length=1, max_length=128)
    path: str = Field(..., min_length=1, max_length=512)
    referrer: str | None = Field(default=None, max_length=1024)
    # story #3506(Phase2·마케팅운영, 페드루 PO 決定 (d)) — referrer(버림)와 달리 이
    # 4필드는 실제 저장 대상이다(org_pageview_utm_daily). Field 자체엔 상한을 안
    # 두고(트렁케이션 vs 422 거부를 한 곳(_normalize_utm)에서만 결정 — Field
    # max_length는 초과 시 422라 "잘라 저장" 계약과 어긋난다) 정규화 함수가 자른다.
    utm_source: str | None = Field(default=None)
    utm_medium: str | None = Field(default=None)
    utm_campaign: str | None = Field(default=None)
    utm_content: str | None = Field(default=None)


@router.post("/pageview", status_code=204)
async def post_pageview(
    body: PageviewBeaconRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Response:
    # referrer는 받되 저장하지 않는다 — 페이지 querystring에 개인식별 정보가 실릴 수 있어
    # (개인정보 0 원칙) 집계 축(org, path, day)에 없는 차원은 지금 스코프에서 버린다(PO
    # 처방 1항이 body 필드로만 나열했지, 영속 컬럼으로 못박지 않았다 — 향후 "유입경로별"
    # 분석이 필요해지면 별도 스토리로 컬럼을 연다).
    _ = body.referrer

    org_id = await resolve_org_by_public_key(db, body.public_key)
    if org_id is None:
        return Response(status_code=204)

    ua = request.headers.get("user-agent", "")
    if not ua or _BOT_UA_RE.search(ua):
        return Response(status_code=204)
    ua_hash = hashlib.sha256(ua.encode()).hexdigest()

    limiter = get_rate_limiter()
    allowed, _remaining, _retry_after = await limiter.check(
        f"pv:{org_id}:{body.path}:{ua_hash}", _DEDUP_WINDOW_LIMIT,
    )
    if not allowed:
        return Response(status_code=204)  # 1분 내 같은 UA 재요청 — 중복으로 간주, 집계 안 늘림

    today = datetime.now(timezone.utc).date()
    await record_pageview(db, org_id=org_id, path=body.path, day=today)

    utm_source = _normalize_utm(body.utm_source)
    utm_medium = _normalize_utm(body.utm_medium)
    utm_campaign = _normalize_utm(body.utm_campaign)
    utm_content = _normalize_utm(body.utm_content)
    if any((utm_source, utm_medium, utm_campaign, utm_content)):
        # story #3506(Phase2·마케팅운영) — 적어도 하나라도 있을 때만 별도 집계(순수
        # pageview와 분리, org_pageview_daily 위 write와 별도 트랜잭션 — 이 write가
        # 실패해도 이미 커밋된 조회수 집계는 보존된다).
        await record_pageview_utm(
            db, org_id=org_id, path=body.path, day=today,
            utm_source=utm_source, utm_medium=utm_medium,
            utm_campaign=utm_campaign, utm_content=utm_content,
        )
    return Response(status_code=204)
