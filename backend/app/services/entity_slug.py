"""story 139d2405(S-slug-infra): workspace(organization)/project slug 유일성·예약어·이력.

slugify 자체는 app.services.doc_slug.slugify 재사용(유니코드 NFC 계약 동일·발명 0) — 여기선
workspace(전역 유일)·project(org-scoped 유일) 두 스코프의 충돌 해소 + workspace 전용 예약어
denylist만 추가한다.
"""
from __future__ import annotations

import re
import unicodedata
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.doc_slug import MAX_SLUG_LEN, slugify

# 클라이언트가 직접 slug를 지정하는 경로(org/project 생성·rename) 용 형식 가드 — slugify()
# 산출물과 동형 문자 집합(소문자 라틴+숫자+하이픈, 앞뒤 하이픈 금지)만 허용.
_SLUG_FORMAT_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def is_valid_slug_format(slug: str) -> bool:
    return bool(slug) and bool(_SLUG_FORMAT_RE.match(slug))


# story #2039(P0): "유니코드 slug는 auto-derive 경로로만 나오게 한다"던 위 주석의 원래 가정이
# 틀렸다 — slugify()는 유니코드 letter/number(한글 포함)를 그대로 보존하므로, project 생성 시
# name→slug auto-derive(라우터가 slug 미지정 시 호출)가 실제로 한글 slug를 만들어낸다. org는
# 이 경로를 안 탄다(생성 시 client가 명시 slug 필수 + is_valid_slug_format 강제라 애초에 auto-
# derive 자체가 없음) — 그래서 조직 축만 우연히 무사했다. workspace/project slug는 URL path
# segment로 그대로 쓰이는데, 한글이 percent-encode된 상태로 FE 라우트 매처를 통과 못 해 클라이언트
# 사이드 404(서버 200·네트워크 요청 0·콘솔 에러 0이라 로그로 안 잡힘, PR #2039 실측)로 이어졌다.
#
# 해법 판단(음역/치환/id-fallback 3안 중 id-fallback 채택, 근거 기록):
#   - 음역(로마자 변환)은 별도 라이브러리 의존 + 기계 음역이 부정확/일관성 없을 위험(사람 이름·
#     상호명일수록 오역 체감이 큼) — 이 스토리 스코프에서 배제.
#   - 치환(예: 한글 문자를 'x'로 1:1 매핑)은 "장사왕"→"xxx"류로 여러 프로젝트가 동일 slug로
#     수렴해 유일화 suffix(-2,-3…)만 무의미하게 늘어남 — 식별력 0.
#   - id-fallback: ASCII만 남기고(라틴/숫자/공백/하이픈), 그 결과가 비면(순수 한글/일본어/이모지
#     이름 등) 짧은 랜덤 접미사로 폴백. GitHub/Linear/Vercel류가 쓰는 관례와 동형 — 라이브러리
#     의존 0·유일성 자연 보장·"한글 이름 자체를 막지 않는다"(PO 명시 제약)를 그대로 만족한다
#     (name 컬럼은 원문 그대로 저장·표시 — slug만 URL-safe로 별도 파생).
_ASCII_STRIP_RE = re.compile(r"[^a-z0-9\s-]")


def slugify_ascii(title: str) -> str:
    """title → ASCII-only slug 시도. 비ASCII(한글 등)는 제거(치환 아님 — 남는 라틴/숫자만 이어
    붙임). 결과가 비면 빈 문자열(호출부가 id-fallback 처리 — slugify_ascii_or_fallback 참고)."""
    if not title:
        return ""
    s = unicodedata.normalize("NFC", title).strip().lower()
    s = re.sub(r"\s+", "-", s)
    s = _ASCII_STRIP_RE.sub("", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    if len(s) > MAX_SLUG_LEN:
        s = s[:MAX_SLUG_LEN].rstrip("-")
    return s


def slugify_ascii_or_fallback(title: str, *, fallback_prefix: str = "project") -> str:
    """workspace/project auto-derive 전용(§ 위 주석). ASCII 산출이 비면(순수 비ASCII 이름)
    `{fallback_prefix}-{8자 hex}`로 폴백 — 항상 is_valid_slug_format을 통과하는 값을 반환한다."""
    base = slugify_ascii(title)
    if base:
        return base
    return f"{fallback_prefix}-{uuid.uuid4().hex[:8]}"

# 유나 doc org-1st-class-surface-ia-design-b §2a — root bare workspace slug라 앱 라우트와
# 충돌 방지(GitHub org 예약어 관례). project slug는 workspace 하위(non-root)라 denylist 불요.
#
# 미르코 S-route-project 그라운딩 발견(근본 강화, 2026-07-15): §2a denylist가 FE 플랫
# 최상위 라우트명(apps/web/src/app 실측)을 전부 커버하지 않아 ws slug="board" 같은 생성이
# 허용되고 있었다 — /{ws}/... 마이그 이후 /board/...가 workspace로 오배정될 여지. 실측
# 근거(apps/web/src/app 디렉토리 직접 대조, 두 그룹 모두 반영 — 발견은 (authenticated) 하위
# 리소스 라우트만 지목했으나, 동일 충돌 메커니즘이 그 바깥 top-level 페이지(auth/dashboard 등)
# 에도 적용돼 함께 봉합):
#   (authenticated)/*: activity·artifacts·board·channel·chats·docs·epics·glance·inbox·
#     loops·meetings·mockups·org-briefing·retro·rewards·sprints·standup·storage
#   app/* top-level: auth·dashboard·forgot-password·internal-dogfood·invite·mfa·privacy·
#     register·reset-password·share·terms·verify-email
RESERVED_WORKSPACE_SLUGS: frozenset[str] = frozenset({
    "api", "login", "logout", "onboarding", "settings", "organization", "o", "admin",
    "help", "static", "_next", "404",
    "activity", "artifacts", "board", "channel", "chats", "docs", "epics", "glance",
    "inbox", "loops", "meetings", "mockups", "org-briefing", "retro", "rewards",
    "sprints", "standup", "storage",
    "auth", "dashboard", "forgot-password", "internal-dogfood", "invite", "mfa",
    "privacy", "register", "reset-password", "share", "terms", "verify-email",
})


class ReservedSlugError(ValueError):
    """workspace slug가 예약어 denylist에 해당."""


async def is_workspace_slug_taken(
    session: AsyncSession, slug: str, exclude_org_id: uuid.UUID | None = None,
) -> bool:
    """workspace(organization) slug는 root bare 네임스페이스라 org 무관 전역 유일."""
    from app.models.organization import Organization

    conds = [Organization.slug == slug]
    if exclude_org_id is not None:
        conds.append(Organization.id != exclude_org_id)
    row = await session.execute(select(func.count()).select_from(Organization).where(*conds))
    return (row.scalar() or 0) > 0


async def resolve_unique_workspace_slug(
    session: AsyncSession, base: str, exclude_org_id: uuid.UUID | None = None,
) -> str:
    """base가 예약어거나 충돌이면 `-2`,`-3`… suffix로 유일 slug 산출.

    base는 이미 slugify된 비어있지 않은 값 가정. 예약어인 base 자체는 무조건 suffix부터
    시작(그래야 "admin"이 "admin-2"로 자동 우회되지 재시도 없이 400 나지 않는다).
    """
    n = 2
    candidate = base
    while candidate in RESERVED_WORKSPACE_SLUGS or await is_workspace_slug_taken(
        session, candidate, exclude_org_id,
    ):
        suffix = f"-{n}"
        trimmed = base[: MAX_SLUG_LEN - len(suffix)].rstrip("-")
        candidate = f"{trimmed}{suffix}"
        n += 1
    return candidate


async def is_project_slug_taken(
    session: AsyncSession, org_id: uuid.UUID, slug: str, exclude_project_id: uuid.UUID | None = None,
) -> bool:
    """project slug는 workspace(org) 내 유일 — 다른 org의 동일 slug는 무관."""
    from app.models.project import Project

    conds = [Project.org_id == org_id, Project.slug == slug, Project.deleted_at.is_(None)]
    if exclude_project_id is not None:
        conds.append(Project.id != exclude_project_id)
    row = await session.execute(select(func.count()).select_from(Project).where(*conds))
    return (row.scalar() or 0) > 0


async def resolve_unique_project_slug(
    session: AsyncSession, org_id: uuid.UUID, base: str, exclude_project_id: uuid.UUID | None = None,
) -> str:
    if not await is_project_slug_taken(session, org_id, base, exclude_project_id):
        return base
    n = 2
    while True:
        suffix = f"-{n}"
        trimmed = base[: MAX_SLUG_LEN - len(suffix)].rstrip("-")
        candidate = f"{trimmed}{suffix}"
        if not await is_project_slug_taken(session, org_id, candidate, exclude_project_id):
            return candidate
        n += 1


# story #2642 — 엔티티 칩 "전체 보기" 착지가 뷰어의 현재 프로젝트로 새는 버그(BE 절반):
# 여러 엔티티 응답(story/goal/task/sprint/evidence/artifact/asset)에 org_slug/project_slug를
# additive로 실어 FE가 뷰어 컨텍스트 대신 «엔티티 자신의» org/project로 직행 URL을 짓게 한다
# (#2168 DocPreviewResponse가 이미 쓰던 패턴). 위 uniqueness 로직(write 축)과 달리 이건 순수
# read 축이라 별도 섹션으로 — 같은 Organization.slug/Project.slug 컬럼을 다루는 같은 도메인이라
# 파일은 공유한다.
#
# ⚠️N+1 주의(PO 판정, 2026-08-14): StoryResponse/TaskResponse 등은 list·단건 엔드포인트가
# 같은 response_model을 공유한다(예: GET /stories, GET /stories/{id} 둘 다 StoryResponse) —
# #2168 DocPreviewResponse의 "요청당 스칼라 쿼리 2개" 패턴을 list 직렬화 루프 안에서 행마다
# 반복하면 실 N+1이 된다. org_slug는 요청 전체에서 org_id가 상수이므로 1쿼리, project_slug는
# 그 응답에 등장하는 distinct project_id 집합 전체를 `IN (...)` 배치 1쿼리로 map해 dict 조회로
# 바꾼다 — 호출부는 반드시 이 두 헬퍼를 "요청당 1회씩"만 불러야 한다(행마다 부르면 배치의
# 의미가 없어진다).


async def resolve_org_slug(session: AsyncSession, org_id: uuid.UUID) -> str:
    """org_id → Organization.slug. org는 항상 slug를 가지므로(NOT NULL·unique) 존재가
    보장된 호출부(이미 org_id로 인가 통과한 요청)에서만 쓴다."""
    from app.models.organization import Organization

    return (await session.execute(
        select(Organization.slug).where(Organization.id == org_id)
    )).scalar_one()


async def resolve_project_slugs(
    session: AsyncSession, project_ids: set[uuid.UUID] | list[uuid.UUID] | list[uuid.UUID | None],
) -> dict[uuid.UUID, str | None]:
    """project_id 집합 → slug 배치 조회(N+1 회피, story #2642). 결과에 없는 project_id는
    호출부가 `.get(pid)`로 None 취급(project.slug nullable — #2039 이전 미백필 행 대응과
    동일 규약, DocPreviewResponse의 scalar_one_or_none()과 동형 의미)."""
    from app.models.project import Project

    ids = {pid for pid in project_ids if pid is not None}
    if not ids:
        return {}
    rows = (await session.execute(
        select(Project.id, Project.slug).where(Project.id.in_(ids))
    )).all()
    return {pid: slug for pid, slug in rows}


__all__ = [
    "slugify",
    "slugify_ascii",
    "slugify_ascii_or_fallback",
    "is_valid_slug_format",
    "RESERVED_WORKSPACE_SLUGS",
    "ReservedSlugError",
    "is_workspace_slug_taken",
    "resolve_unique_workspace_slug",
    "is_project_slug_taken",
    "resolve_unique_project_slug",
    "resolve_org_slug",
    "resolve_project_slugs",
]
