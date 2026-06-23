"""E-GHAPP Bot-L.1: PR ↔ story resolver 체인 + auto-match 휴리스틱 + explicit link upsert.

**컨벤션-free 링킹의 심장.** 유저가 `[SID:uuid]` 를 박지 않아도 봇이 PR↔story 를 해소한다.

resolver 우선순위(deterministic): **explicit > auto_match(high only) > SID(_SID_RE) > auto_match(med/low
suggestion) > none**. `should_auto_close` 는 confident link(explicit·auto high·sid exact)에만 True —
close-on-merge 가 **오매치 done 을 못 내게** 한다(med/low/text 는 suggestion·done 금지).

per-org 격리(anti-IDOR): org 가 알려진 경우(app webhook) 전 조회를 org-scope. org 미상(legacy webhook)이면
SID 전역 조회로 story→org 를 도출(기존 무회귀). story 는 항상 `org_id AND deleted_at IS NULL` 재검증.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.models.pull_request_story_link import PullRequestStoryLink
from app.services.verdict_capture import parse_story_id  # _SID_RE 흡수(legacy 무회귀).

_VALID_SOURCES = ("explicit", "auto_match", "sid", "text")
_VALID_CONFIDENCE = ("high", "medium", "low")
# auto-match 후보 본문 토큰화(소문자 영숫자). story title/slug 와 PR title/branch/body 비교용.
_TOKEN_RE = re.compile(r"[a-z0-9]+")
# 잡음 토큰(매칭 신호 약화 방지) — 흔한 PR/branch 접두.
_STOP = {"feat", "fix", "chore", "refactor", "test", "docs", "the", "and", "for", "wip", "pr", "sid"}


@dataclass
class ResolvedLink:
    story_id: uuid.UUID | None
    org_id: uuid.UUID | None
    source: str | None           # explicit | auto_match | sid | text | None
    confidence: str | None       # high | medium | low | None
    should_auto_close: bool      # confident(explicit·auto high·sid)만 True — 오매치 done 방지.
    reason: str
    evidence: dict | None = None


def normalize_repo(repo: str | None) -> str:
    """repo_full_name 정규화(lowercase·strip). 저장/조회 일관성(대소문자 우회 차단)."""
    return (repo or "").strip().lower()


def _tokens(text: str) -> set[str]:
    return {t for t in _TOKEN_RE.findall((text or "").lower()) if t not in _STOP and len(t) >= 3}


def _slugify(text: str) -> str:
    return "-".join(_TOKEN_RE.findall((text or "").lower()))


async def _scoped_story(session: AsyncSession, story_id: uuid.UUID, org_id: uuid.UUID) -> Story | None:
    """org-scoped story 조회(anti-IDOR·타 org 미노출)."""
    return (
        await session.execute(
            select(Story).where(
                Story.id == story_id, Story.org_id == org_id, Story.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()


async def _global_story(session: AsyncSession, story_id: uuid.UUID) -> Story | None:
    """org 미상(legacy)일 때 전역 story 조회 → org 도출(기존 SID 흐름 무회귀)."""
    return (
        await session.execute(
            select(Story).where(Story.id == story_id, Story.deleted_at.is_(None))
        )
    ).scalar_one_or_none()


async def _auto_match(
    session: AsyncSession, org_id: uuid.UUID, texts: list[str]
) -> ResolvedLink | None:
    """org 내 active story 들과 PR title/branch/body 토큰을 비교해 후보 추론(per-org).

    high: title/slug exact match **& 후보 정확히 1개**. medium: partial token 다수 중복(후보 1). low/복수:
    ambiguous. ⭐**high 만 canonical link/close** — med/low 는 suggestion(영속·done 금지)으로 오매치 방지.
    """
    pr_tokens: set[str] = set()
    pr_slugs: set[str] = set()
    for t in texts:
        pr_tokens |= _tokens(t)
        pr_slugs.add(_slugify(t))
    if not pr_tokens:
        return None
    # 후보 풀: org 의 비-done active story(과도 스캔 방지 위해 done/삭제 제외).
    stories = (
        await session.execute(
            select(Story).where(
                Story.org_id == org_id,
                Story.deleted_at.is_(None),
                Story.status != "done",
            )
        )
    ).scalars().all()

    exact: list[Story] = []
    scored: list[tuple[int, Story]] = []
    for s in stories:
        title_slug = _slugify(s.title)
        # ⭐high 는 **exact slug equality** 만(story title slug == PR 텍스트(title/branch) 전체 slug).
        # substring/contains 는 high 아님 — partial token overlap(medium/low)로 내려 오매치 auto-close 차단.
        if title_slug and title_slug in pr_slugs:
            exact.append(s)
            continue
        overlap = len(_tokens(s.title) & pr_tokens)
        if overlap > 0:
            scored.append((overlap, s))

    if len(exact) == 1:
        s = exact[0]
        return ResolvedLink(
            s.id, org_id, "auto_match", "high", True, "auto_title_slug_exact",
            {"matched": "title_slug", "candidate_count": 1, "story_title": s.title},
        )
    if len(exact) > 1:
        return ResolvedLink(
            None, org_id, "auto_match", "low", False, "auto_ambiguous_exact",
            {"matched": "title_slug", "candidate_count": len(exact)},
        )
    if scored:
        scored.sort(key=lambda x: x[0], reverse=True)
        top, story = scored[0]
        # 단일 우세 후보(2위와 차이 있고 신호 충분) → medium suggestion(close 금지).
        ambiguous = len(scored) > 1 and scored[1][0] == top
        conf = "low" if (ambiguous or top < 2) else "medium"
        return ResolvedLink(
            None, org_id, "auto_match", conf, False, "auto_partial_token",
            {"matched": "token_overlap", "overlap": top, "candidate_count": len(scored)},
        )
    return None


async def resolve_story_for_pr(
    session: AsyncSession,
    org_id: uuid.UUID | None,
    repo_full_name: str,
    pr_number: int,
    texts: list[str],
) -> ResolvedLink:
    """PR → story 해소(우선순위 체인). org_id None=legacy(SID 전역). 반환 should_auto_close 가 close-on-merge
    가능 여부를 명시(구현 실수 방지)."""
    repo = normalize_repo(repo_full_name)

    # 1) explicit/저장된 canonical link(org-scoped). 명시연결이 최우선.
    if org_id is not None and repo and pr_number:
        link = (
            await session.execute(
                select(PullRequestStoryLink).where(
                    PullRequestStoryLink.org_id == org_id,
                    PullRequestStoryLink.repo_full_name == repo,
                    PullRequestStoryLink.pr_number == pr_number,
                    PullRequestStoryLink.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if link is not None:
            story = await _scoped_story(session, link.story_id, org_id)
            if story is not None:
                close = link.link_source == "explicit" or (
                    link.link_source in ("auto_match", "sid") and link.confidence == "high"
                )
                return ResolvedLink(
                    story.id, org_id, link.link_source, link.confidence, close,
                    "stored_explicit" if link.link_source == "explicit" else "stored_link",
                    link.evidence,
                )

    # 2) auto_match high(org 알 때만) — high 만 SID 위로.
    auto_suggestion: ResolvedLink | None = None
    if org_id is not None:
        am = await _auto_match(session, org_id, texts)
        if am is not None and am.story_id is not None and am.confidence == "high":
            return am
        auto_suggestion = am  # med/low/ambiguous → SID 아래로 보류(close 금지).

    # 3) SID(텍스트 태그·_SID_RE exact). org 알면 scoped·모르면 전역(legacy 무회귀).
    sid = next((s for t in texts if (s := parse_story_id(t))), None)
    if sid is not None:
        story = (
            await _scoped_story(session, sid, org_id) if org_id is not None
            else await _global_story(session, sid)
        )
        if story is not None:
            return ResolvedLink(
                story.id, story.org_id, "sid", "high", True, "sid_exact", {"sid": str(sid)}
            )

    # 4) auto_match med/low → suggestion(영속·done 금지). 아니면 legacy 호환 skip reason.
    if auto_suggestion is not None:
        return auto_suggestion
    # SID 있으나 story 미해소(org-scope 미매치 포함)=story_not_found·SID 없음=no_sid_tag(legacy 무회귀).
    reason = "story_not_found" if sid is not None else "no_sid_tag"
    return ResolvedLink(None, org_id, None, None, False, reason)


async def upsert_link(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    repo_full_name: str,
    pr_number: int,
    *,
    link_source: str,
    confidence: str,
    created_by: uuid.UUID | None = None,
    evidence: dict | None = None,
) -> PullRequestStoryLink:
    """canonical 단일 링크 upsert(uq org,repo,pr). 재링크=우선순위/소스 갱신. 호출자는 org-scope 검증 후 호출."""
    repo = normalize_repo(repo_full_name)
    existing = (
        await session.execute(
            select(PullRequestStoryLink).where(
                PullRequestStoryLink.org_id == org_id,
                PullRequestStoryLink.repo_full_name == repo,
                PullRequestStoryLink.pr_number == pr_number,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.story_id = story_id
        existing.link_source = link_source
        existing.confidence = confidence
        existing.created_by = created_by
        existing.evidence = evidence
        existing.deleted_at = None
        await session.flush()
        return existing
    link = PullRequestStoryLink(
        org_id=org_id, story_id=story_id, repo_full_name=repo, pr_number=pr_number,
        link_source=link_source, confidence=confidence, created_by=created_by, evidence=evidence,
    )
    session.add(link)
    await session.flush()
    return link
