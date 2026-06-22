"""E-CAGE-REFEREE P1 / E-H1-S6: PR·CI verdict 캡처 엔드포인트.

CRON 수동 캡처(capture-pr/capture-review·CRON_SECRET) + H1-S6 GitHub webhook(github-webhook·HMAC).
GitHub webhook이 R5 갭(capture_pr_ci_verdict 프로덕션 호출자 0)을 해소하는 실 runtime 경로다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.models.pm import Story
from app.routers.cron import CRON_SECRET, _err, _ok, verify_cron
from app.services.verdict_capture import (
    capture_pr_ci_verdict,
    capture_review_verdict,
    fetch_status_check_rollup,
    parse_story_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/internal/verdict", tags=["verdict-capture"])


class CaptureBody(BaseModel):
    pr_title: str
    pr_number: int
    repo: str = "moonklabs/sprintable"
    merged: bool = True
    ci_result: str | None = None


@router.post("/capture-pr")
async def capture_pr_verdict(
    request: Request,
    body: CaptureBody,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """머지된 PR 기준 PR·CI verdict 포착.

    [SID:story_uuid] 태그가 없거나 participation이 없으면 skip(거짓기록 금지).
    """
    verify_cron(request)

    # SID 파싱
    story_id = parse_story_id(body.pr_title)
    if story_id is None:
        return _ok({"skipped_reason": "no_sid_tag", "recorded": []})

    # story 조회 → org_id 획득
    story_r = await session.execute(
        select(Story).where(Story.id == story_id, Story.deleted_at.is_(None))
    )
    story = story_r.scalar_one_or_none()
    if story is None:
        return _ok({"skipped_reason": "story_not_found", "recorded": []})

    try:
        result = await capture_pr_ci_verdict(
            session=session,
            org_id=story.org_id,
            story_id=story_id,
            pr_number=body.pr_number,
            repo=body.repo,
            merged=body.merged,
            ci_result=body.ci_result,
        )
        await session.commit()
        return _ok(result)
    except Exception as exc:
        logger.exception("verdict capture failed: %s", exc)
        return _err("INTERNAL_ERROR", "verdict capture failed", 500)


# ── QA·디자인 게이트 verdict 캡처 ─────────────────────────────────────────────

_VALID_REVIEW_ROLES = frozenset({"qa", "design"})


class CaptureReviewBody(BaseModel):
    story_id: uuid.UUID
    role: str                # 'qa' | 'design'
    member_id: uuid.UUID
    result: str | None = None  # 'pass' | 'fail' | None
    rounds: int | None = None


@router.post("/capture-review")
async def capture_review(
    request: Request,
    body: CaptureReviewBody,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """QA·디자인 게이트 결과 → verdict 기록 (CRON_SECRET 인증).

    트리거 경위: send_chat_message review_type 자동 훅 불가(FastAPI 스키마 미노출·
    Conversation에 story_id 링크 없음)→ MVP 내부 엔드포인트 택일.
    role 없거나 story 없으면 skip(거짓기록 금지). uq(participation,source) 멱등.
    """
    verify_cron(request)

    if body.role not in _VALID_REVIEW_ROLES:
        return _err("INVALID_ROLE", f"role must be one of {sorted(_VALID_REVIEW_ROLES)}", 422)

    # story 조회 → org_id 획득
    story_r = await session.execute(
        select(Story).where(Story.id == body.story_id, Story.deleted_at.is_(None))
    )
    story = story_r.scalar_one_or_none()
    if story is None:
        return _ok({"skipped_reason": "story_not_found", "recorded": False})

    try:
        result = await capture_review_verdict(
            session=session,
            org_id=story.org_id,
            story_id=body.story_id,
            role_key=body.role,
            member_id=body.member_id,
            result=body.result,
            rounds=body.rounds,
        )
        await session.commit()
        return _ok(result)
    except Exception as exc:
        logger.exception("review verdict capture failed: %s", exc)
        return _err("INTERNAL_ERROR", "review verdict capture failed", 500)


# ── H1-S6: GitHub webhook (PR/CI runtime verdict 캡처·실 runtime 경로) ───────────
#
# capture_pr_ci_verdict의 R5 갭(프로덕션 호출자 0)을 해소한다 — GitHub PR/CI 이벤트가 도착하면
# PR title/body/branch서 [SID:uuid]를 파싱해 story→org를 잡고 verdict를 기록한다. HMAC(X-Hub-
# Signature-256) 검증. 시크릿 미설정이면 모든 webhook 거부(inert).

# CI 결론 정규화 — success|failure|cancelled로. capture_pr_ci_verdict가 다시 pass(=success)/fail로
# 환산하므로 success만 pass, 나머지(실패·취소)는 fail로 채점된다.
_CI_SUCCESS = frozenset({"success"})
_CI_FAILURE = frozenset({"failure", "timed_out", "action_required", "stale", "startup_failure", "error"})
_CI_CANCELLED = frozenset({"cancelled", "canceled", "skipped", "neutral"})


def _verify_github_signature(raw_body: bytes, signature_header: str | None) -> bool:
    """X-Hub-Signature-256 HMAC-SHA256 검증. 시크릿 미설정/서명 불일치면 False."""
    secret = settings.github_webhook_secret
    if not secret or not signature_header:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.removeprefix("sha256="))


def _normalize_ci(conclusion: str | None) -> str | None:
    """CI provider 결론 → success|failure|cancelled. 미완료(in_progress/queued 등)면 None(skip)."""
    if not conclusion:
        return None
    c = conclusion.strip().lower()
    if c in _CI_SUCCESS:
        return "success"
    if c in _CI_FAILURE:
        return "failure"
    if c in _CI_CANCELLED:
        return "cancelled"
    return None


def _candidate_texts(payload: dict) -> list[str]:
    """payload에서 [SID:] 태그가 있을 수 있는 텍스트들 — PR title/body/branch(이벤트 형태별)."""
    texts: list[str] = []
    pr = payload.get("pull_request") or {}
    texts += [pr.get("title") or "", pr.get("body") or "", (pr.get("head") or {}).get("ref") or ""]
    for node_key in ("workflow_run", "check_suite", "check_run"):
        node = payload.get(node_key) or {}
        texts.append(node.get("head_branch") or "")
        for p in node.get("pull_requests") or []:
            texts.append((p.get("head") or {}).get("ref") or "")
    texts.append(payload.get("ref") or "")  # push
    # status 이벤트는 ref 대신 branches[].name으로 브랜치를 싣는다.
    for b in payload.get("branches") or []:
        texts.append(b.get("name") or "")
    return [t for t in texts if t]


def _extract_pr_ci(event: str, payload: dict) -> tuple[int, bool, str | None, str | None]:
    """이벤트 형태에서 (pr_number, merged, ci_conclusion, head_sha) 추출.

    head_sha = native CI(statusCheckRollup) 조회용 PR head commit. 이벤트별 위치가 달라 함께 뽑는다.
    """
    pr_number = 0
    merged = False
    ci_conclusion: str | None = None
    head_sha: str | None = None
    if event == "pull_request":
        pr = payload.get("pull_request") or {}
        pr_number = int(pr.get("number") or 0)
        merged = bool(pr.get("merged")) and payload.get("action") == "closed"
        head_sha = (pr.get("head") or {}).get("sha") or None
    elif event in ("workflow_run", "check_suite", "check_run"):
        node = payload.get("workflow_run") or payload.get("check_suite") or payload.get("check_run") or {}
        ci_conclusion = _normalize_ci(node.get("conclusion"))
        prs = node.get("pull_requests") or []
        pr_number = int((prs[0].get("number") if prs else 0) or 0)
        head_sha = node.get("head_sha") or None
    elif event == "status":
        ci_conclusion = _normalize_ci(payload.get("state"))
        head_sha = payload.get("sha") or None
    return pr_number, merged, ci_conclusion, head_sha


@router.post("/github-webhook")
async def github_webhook(
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_github_event: str | None = Header(default=None),
    x_hub_signature_256: str | None = Header(default=None),
) -> JSONResponse:
    """GitHub PR/CI webhook → [SID:uuid] 파싱 → capture_pr_ci_verdict (H1-S6 실 runtime 경로).

    HMAC 검증 후 PR merge(=pr verdict)·CI 완료(=ci verdict)를 기록한다. SID 없거나(AC②) story
    없으면(AC③) skip. duplicate webhook은 uq(participation,source) upsert로 멱등(AC⑤).
    """
    raw = await request.body()
    if not _verify_github_signature(raw, x_hub_signature_256):
        return _err("INVALID_SIGNATURE", "GitHub webhook 서명 검증 실패", 401)

    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return _err("INVALID_PAYLOAD", "JSON 파싱 실패", 400)

    # AC②: [SID:] 태그 없으면 skip(거짓기록 금지).
    story_id = next((sid for t in _candidate_texts(payload) if (sid := parse_story_id(t))), None)
    if story_id is None:
        return _ok({"skipped_reason": "no_sid_tag", "recorded": []})

    # AC③: story 없으면 skip.
    story = (
        await session.execute(
            select(Story).where(Story.id == story_id, Story.deleted_at.is_(None))
        )
    ).scalar_one_or_none()
    if story is None:
        return _ok({"skipped_reason": "story_not_found", "recorded": []})

    repo = (payload.get("repository") or {}).get("full_name") or ""
    pr_number, merged, ci_conclusion, head_sha = _extract_pr_ci(x_github_event or "", payload)

    # 행동 가능한 신호(머지 또는 CI 완료)가 없으면 skip(in_progress 등).
    if not merged and ci_conclusion is None:
        return _ok({"skipped_reason": "no_actionable_signal", "recorded": []})

    # S5 Phase S: native CI 채움. story가 SID로 confident-resolve된(위 AC②/③ 통과) 상태에서, 이벤트에
    # CI 결론이 없으면(대표적으로 머지 이벤트) PR head SHA의 statusCheckRollup을 1콜 pull해 게이트에 실 CI를
    # 주입한다(CI unknown 박멸). 이벤트가 이미 CI 결론을 실었으면 그 값을 유지. 토큰 없음/미완료/실패는
    # None=무영향(미링크 CI unknown 유지). confident-link(exact PK)에서만 동작(여긴 SID resolve 後라 충족).
    if ci_conclusion is None and head_sha and repo:
        native_ci = await fetch_status_check_rollup(repo, head_sha)
        if native_ci is not None:
            ci_conclusion = native_ci

    try:
        result = await capture_pr_ci_verdict(
            session=session,
            org_id=story.org_id,
            story_id=story_id,
            pr_number=pr_number,
            repo=repo,
            merged=merged,
            ci_result=ci_conclusion,  # AC④: failure→capture가 fail로 채점.
        )
        await session.commit()
        return _ok(result)
    except Exception as exc:
        logger.exception("github webhook verdict capture failed: %s", exc)
        return _err("INTERNAL_ERROR", "verdict capture failed", 500)
