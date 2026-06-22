"""E-CAGE-REFEREE P1 / E-H1-S6: PR·CI verdict 캡처 엔드포인트.

CRON 수동 캡처(capture-pr/capture-review·CRON_SECRET) + H1-S6 GitHub webhook(github-webhook·HMAC).
GitHub webhook이 R5 갭(capture_pr_ci_verdict 프로덕션 호출자 0)을 해소하는 실 runtime 경로다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.models.github_installation import GithubInstallation, GithubWebhookDelivery
from app.models.pm import Story
from app.routers.cron import CRON_SECRET, _err, _ok, verify_cron
from app.services.github_app import get_installation_token
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


_SIG_RE = re.compile(r"^sha256=[0-9a-f]{64}$")  # X-Hub-Signature-256 = 'sha256=<hex64>' 형식만 허용.
_app_inert_warned = False  # equal-secret misconfig warning 1회만(로그 스팸 방지).


def _hmac_match(raw_body: bytes, signature_header: str | None, secret: str) -> bool:
    """X-Hub-Signature-256 HMAC-SHA256 full-string constant-time 비교. secret 빈값/header 없음/형식
    오류(bare hex·wrong prefix)면 False. ⚠️secret/signature 원문은 로그에 남기지 않는다."""
    if not secret or not signature_header or not _SIG_RE.match(signature_header):
        return False
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)


def _resolve_webhook_source(raw_body: bytes, signature_header: str | None) -> str | None:
    """source 를 **검증된 secret match 로만** 결정(untrusted payload 금지). 'app'|'legacy'|None.

    - app secret(`github_app_webhook_secret`) 미설정 → app inert(app 검증 skip)·legacy 만.
    - app secret == legacy secret(둘 다 non-empty·misconfig) → **app inert + startup warning**(legacy
      무회귀 보존·silent app-우선 금지).
    - 그 외 → app 먼저 검증(match=app)·아니면 legacy(match=legacy)·둘 다 실패=None.
    """
    global _app_inert_warned
    legacy_secret = settings.github_webhook_secret
    app_secret = settings.github_app_webhook_secret
    equal_misconfig = bool(app_secret) and bool(legacy_secret) and app_secret == legacy_secret
    if equal_misconfig and not _app_inert_warned:
        logger.warning(
            "github_app_webhook_secret 가 github_webhook_secret 와 동일(misconfig) → app webhook inert; "
            "legacy 경로만 동작. 별도 App webhook secret 설정 필요."  # ⚠️secret 값/길이/해시 미노출.
        )
        _app_inert_warned = True
    app_inert = (not app_secret) or equal_misconfig
    if not app_inert and _hmac_match(raw_body, signature_header, app_secret):
        return "app"
    if _hmac_match(raw_body, signature_header, legacy_secret):
        return "legacy"
    return None


def warn_if_webhook_secret_misconfigured() -> None:
    """Startup config 검증(P3): app webhook secret 이 legacy 와 동일(misconfig)이면 **트래픽 前** 경고.
    app inert 로 동작해 보안 위험은 없으나 운영자가 secret 을 분리하도록 알린다. ⚠️secret 정보 미노출.
    """
    legacy = settings.github_webhook_secret
    app_s = settings.github_app_webhook_secret
    if app_s and legacy and app_s == legacy:
        logger.warning(
            "[startup] github_app_webhook_secret 가 github_webhook_secret 와 동일(misconfig) → "
            "App webhook inert(legacy 만 동작). 별도 App webhook secret 설정 필요."
        )


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


async def _process_webhook_event(
    session: AsyncSession, source: str, event: str, payload: dict, installation_id: int | None,
    delivery: GithubWebhookDelivery,
) -> tuple[dict, str]:
    """검증·dedup 통과한 이벤트 처리(legacy/app 라우팅). (result, status) 반환. status∈processed|ignored.

    org resolve: **legacy**=story.org_id(기존). **app**=installation.id→github_installation(suspended 제외)
    →그 org_id만(anti-IDOR·payload/repo-owner 추론 금지)·story 가 그 org 소속 아니면 거부(cross-org spoof).
    native CI(Bot-M.1)=installation 토큰. **caller 가 동일 트랜잭션으로 commit/rollback**(여기선 commit 안 함).
    """
    # AC②: [SID:] 태그 없으면 skip(거짓기록 금지).
    story_id = next((sid for t in _candidate_texts(payload) if (sid := parse_story_id(t))), None)
    if story_id is None:
        return {"skipped_reason": "no_sid_tag", "recorded": []}, "ignored"

    installation: GithubInstallation | None = None
    if source == "app":
        # ⭐app: **installation→org resolve 를 story 조회보다 먼저**(org context 확립 前 전역 story 조회 금지
        # — 미등록 installation 으로 story 존재 oracle 차단). org 는 installation DB 로만(payload 추론 금지).
        if installation_id is None:
            return {"skipped_reason": "no_installation_id", "recorded": []}, "ignored"
        installation = (
            await session.execute(
                select(GithubInstallation).where(
                    GithubInstallation.installation_id == installation_id,
                    GithubInstallation.suspended_at.is_(None),  # suspended → side-effect 금지.
                )
            )
        ).scalar_one_or_none()
        if installation is None:
            # 미등록/suspended installation → story 조회 없이 graceful ignore(side-effect 0·oracle 0).
            return {"skipped_reason": "installation_not_registered_or_suspended", "recorded": []}, "ignored"
        org_id = installation.org_id
        delivery.org_id = org_id
        # story 를 **resolved org 로 스코프** 조회 — cross-org 차단 + 존재 oracle 차단(타 org story 는 not_found).
        story = (
            await session.execute(
                select(Story).where(
                    Story.id == story_id, Story.org_id == org_id, Story.deleted_at.is_(None)
                )
            )
        ).scalar_one_or_none()
        if story is None:
            return {"skipped_reason": "story_not_found", "recorded": []}, "ignored"
    else:
        # legacy: 기존 동작 — Story.id 전역 조회 → org = story.org_id.
        story = (
            await session.execute(
                select(Story).where(Story.id == story_id, Story.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if story is None:
            return {"skipped_reason": "story_not_found", "recorded": []}, "ignored"
        org_id = story.org_id
        delivery.org_id = org_id

    repo = (payload.get("repository") or {}).get("full_name") or ""
    pr_number, merged, ci_conclusion, head_sha = _extract_pr_ci(event, payload)

    # 행동 가능한 신호(머지 또는 CI 완료)가 없으면 skip(in_progress 등).
    if not merged and ci_conclusion is None:
        return {"skipped_reason": "no_actionable_signal", "recorded": []}, "ignored"

    # Bot-M.1: native CI 채움 — **installation 토큰**(org-scope)으로 statusCheckRollup pull(⚠️PAT fallback 없음).
    # app source 는 위서 resolve된 installation(suspended 제외) 직접 사용·legacy 는 org→installation resolve.
    # 토큰 없음/미설치/실패/미완료 → ci unknown 유지(graceful·success 승격 금지). unknown(reason) 계약.
    native_ci_state: str | None = None
    native_ci_reason: str | None = None
    if ci_conclusion is None and head_sha and repo:
        inst_for_ci = installation
        if inst_for_ci is None:  # legacy: org→installation resolve(suspended 제외).
            inst_for_ci = (
                await session.execute(
                    select(GithubInstallation).where(
                        GithubInstallation.org_id == org_id,
                        GithubInstallation.suspended_at.is_(None),
                    )
                )
            ).scalar_one_or_none()
        if inst_for_ci is None:
            native_ci_state, native_ci_reason = "unknown", "no_installation"
        else:
            inst_token = await get_installation_token(inst_for_ci.installation_id)
            if not inst_token:
                native_ci_state, native_ci_reason = "unknown", "no_installation_token"
            else:
                ci, reason = await fetch_status_check_rollup(repo, head_sha, inst_token)
                if ci is not None:
                    ci_conclusion = ci
                    native_ci_state, native_ci_reason = ci, None
                else:
                    native_ci_state, native_ci_reason = "unknown", reason
        logger.info(
            "native CI story=%s source=%s state=%s reason=%s",
            story_id, source, native_ci_state, native_ci_reason,
        )

    result = await capture_pr_ci_verdict(
        session=session,
        org_id=org_id,
        story_id=story_id,
        pr_number=pr_number,
        repo=repo,
        merged=merged,
        ci_result=ci_conclusion,  # AC④: failure→capture가 fail로 채점.
    )
    if native_ci_state is not None:
        result = {**result, "native_ci": {"state": native_ci_state, "reason": native_ci_reason}}
    return result, "processed"


@router.post("/github-webhook")
async def github_webhook(
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_github_event: str | None = Header(default=None),
    x_hub_signature_256: str | None = Header(default=None),
    x_github_delivery: str | None = Header(default=None),
) -> JSONResponse:
    """GitHub 웹훅 통합 ingress(Bot-M.2) → [SID:uuid]/installation 라우팅 → capture_pr_ci_verdict.

    보안(산티아고 lock): ⭐**HMAC-before-parse**(검증 前 parse/DB/dedup/capture 0)·source 는 **검증된
    secret 으로만**(payload 금지)·dedup `(source, delivery_id)` insert+side-effect+status **동일 트랜잭션**
    (실패=rollback→GitHub retry 보존·중복=2xx no-op)·app=installation resolve 後 org-scope(anti-IDOR).
    """
    raw = await request.body()

    # 1) source 결정 = 검증된 secret(app/legacy). 실패면 401 — parse/DB/dedup 전부 0.
    source = _resolve_webhook_source(raw, x_hub_signature_256)
    if source is None:
        return _err("INVALID_SIGNATURE", "GitHub webhook 서명 검증 실패", 401)

    # 2) no-delivery-id → reject(sig 검증 後·DB insert 前). 멱등 불가하므로 감사가능하게 거부.
    if not x_github_delivery:
        return _err("MISSING_DELIVERY_ID", "X-GitHub-Delivery 헤더 없음", 400)

    # 3) parse(검증 後에만).
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return _err("INVALID_PAYLOAD", "JSON 파싱 실패", 400)
    if not isinstance(payload, dict):
        return _err("INVALID_PAYLOAD", "JSON object 아님", 400)

    event = x_github_event or ""
    inst_raw = (payload.get("installation") or {}).get("id")
    installation_id = inst_raw if isinstance(inst_raw, int) else None

    # 4) dedup insert — uq(source, delivery_id) 중복이면 2xx no-op(side-effect 0·세션 clean).
    delivery = GithubWebhookDelivery(
        source=source, delivery_id=x_github_delivery, event=event,
        installation_id=installation_id, status="received",
    )
    session.add(delivery)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()  # 중복 → 세션 clean + no-op(capture 0).
        return _ok({"skipped_reason": "duplicate_delivery", "recorded": []})

    # 5) 처리 + status 갱신 + commit 을 **동일 트랜잭션**으로. 실패=rollback(delivery row 도 함께 → retry 보존).
    try:
        result, status_label = await _process_webhook_event(
            session, source, event, payload, installation_id, delivery
        )
        delivery.status = status_label
        delivery.processed_at = datetime.now(timezone.utc)
        await session.commit()
        return _ok(result)
    except Exception as exc:
        await session.rollback()  # delivery insert 포함 전부 rollback → GitHub retry 가 재처리(영구 no-op 금지).
        logger.exception("github webhook 처리 실패 delivery=%s event=%s: %s", x_github_delivery, event, exc)
        return _err("WEBHOOK_PROCESSING_FAILED", "처리 중 오류(재시도 가능)", 500)
