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

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.models.github_installation import GithubInstallation, GithubWebhookDelivery
from app.models.pm import Story
from app.routers.cron import CRON_SECRET, _err, _ok, verify_cron
from app.services.github_app import get_installation_token
from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence
from app.services.pr_story_link import merge_link_evidence, resolve_story_for_pr
from app.services.verdict_capture import (
    capture_pr_ci_verdict,
    capture_review_verdict,
    check_scope_violation,
    fetch_pr_changed_files,
    fetch_status_check_rollup,
    parse_story_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/internal/verdict", tags=["verdict-capture", "Trust"])


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


def _repo_owner(repo: str) -> str | None:
    """`owner/repo` → `owner`. 형식 아니면 None(추측 금지)."""
    if not repo or "/" not in repo:
        return None
    owner = repo.split("/", 1)[0]
    return owner or None


async def _resolve_legacy_org_by_repo_owner(
    session: AsyncSession, repo: str
) -> tuple[uuid.UUID | None, str]:
    """legacy webhook(이미 legacy_secret HMAC 을 통과한 «검증된» 요청)에서 org_id 를 repo owner 로 해소.
    (org_id, reason) 반환 — reason ∈ {org_resolved_via_repo_owner, repo_owner_ambiguous, repo_owner_unknown}.

    ①왜 이 길을 열었나: story #2327 후속 실측(2026-07-30) — legacy 는 서명검증을 이미 통과했는데
    org_id 를 못 풀어 story_number/PR-link/auto_match 등 org-scope 필요 경로 전체가 막혀 있었다
    (`GITHUB_APP_WEBHOOK_SECRET` 미설정 확認 — app 경로 자체가 전무·2575건 legacy ignored 다수가
    이 갭). repository.full_name 의 owner 는 모든 webhook payload 에 항상 있고, PO 판정(2026-07-30):
    「검증된 요청인데 org 를 못 푼다」는 보안 경계가 아니라 결함이라 이 매치는 우회가 아니라 정공이다.
    ②무엇을 안 하는가: 서명검증을 건너뛰지 않는다(이 함수는 `_resolve_webhook_source`가 이미
    source='legacy'로 확정한 요청에만 불린다) · source 를 'app'으로 바꿔치지 않는다(그대로 legacy로
    기록) · **정확히 1건 매치일 때만** 해소한다(0건·2건+ 는 거부 — 「첫 것을 고른다」 금지).
    ③⭐만료 조건: `GITHUB_APP_WEBHOOK_SECRET` 이 설정돼 app 경로가 라이브로 도는 것이 확認되면,
    이 폴백은 다중 org 안전성(exactly-1-match 전제가 org 여러 개일 때도 유지되는지 — 지금은
    `github_installation` 이 1행이라 위험 없음)을 다시 재고 그때 유지 여부를 정한다."""
    owner = _repo_owner(repo)
    if owner is None:
        return None, "repo_owner_unknown"
    rows = (
        await session.execute(
            select(GithubInstallation.org_id).where(
                func.lower(GithubInstallation.account_login) == owner.lower(),
                GithubInstallation.suspended_at.is_(None),
            )
        )
    ).scalars().all()
    if len(rows) == 0:
        return None, "repo_owner_unknown"
    if len(rows) > 1:
        return None, "repo_owner_ambiguous"
    return rows[0], "org_resolved_via_repo_owner"


async def _process_webhook_event(
    session: AsyncSession, source: str, event: str, payload: dict, installation_id: int | None,
    delivery: GithubWebhookDelivery,
    *,
    gate_check_publish: list[dict] | None = None,
) -> tuple[dict, str]:
    """검증·dedup 통과한 이벤트 처리(legacy/app 라우팅·Bot-L.1 resolver 체인). (result, status) 반환.

    org resolve: **app**=installation.id→github_installation(suspended 제외)→그 org_id만(anti-IDOR·payload
    추론 금지·resolve 先). **legacy**=repo owner→account_login exactly-1-match 시도(story #2327 후속) →
    실패시 resolver 가 SID 전역→story.org_id(무회귀). story 해소=resolver 체인(explicit>auto high>SID>text).
    **close-on-merge**=should_auto_close(confident)+merge → advance_story_to_done(단일 idempotent 헬퍼).
    native CI(Bot-M.1)=installation 토큰. caller 가 동일 트랜잭션으로 commit/rollback.

    P0-05 후속(doc scope-violation-signal-design §2): scope-violation 판정은 머지/CI 액션가능신호와
    **독립**(PR 자체 이벤트에서 판정) — resolver를 그 skip보다 먼저 실행해 두 판정이 서로를 막지 않게 한다.

    ``gate_check_publish``(story #2813, ccbcd9da A-1 `pending_deliveries`와 동형 outparam): 넘기면
    PR 라이프사이클 이벤트(opened/reopened/ready_for_review/synchronize)가 발행해야 할 GitHub
    check-run 정보를 append — 호출자(github_webhook)가 **commit 後** 배경 태스크로 발행(fail-closed:
    GitHub 외부 API 호출을 DB 트랜잭션 성공 확정 前에 하지 않는다).
    """
    texts = _candidate_texts(payload)
    repo = (payload.get("repository") or {}).get("full_name") or ""
    pr_number, merged, ci_conclusion, head_sha = _extract_pr_ci(event, payload)
    pr_action = payload.get("action") if event == "pull_request" else None

    installation: GithubInstallation | None = None
    org_id: uuid.UUID | None = None
    if source == "app":
        # ⭐app: installation→org resolve 先(미등록 installation 으로 story 존재 oracle 차단·payload 추론 금지).
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
            return {"skipped_reason": "installation_not_registered_or_suspended", "recorded": []}, "ignored"
        org_id = installation.org_id
        delivery.org_id = org_id
    elif source == "legacy":
        # ⭐story #2327 후속(PO 판정 2026-07-30): legacy 도 검증된 요청 — repo owner 로 org 해소
        # 시도(exactly-1-match 만). 실패해도 아래 resolver 는 org_id=None 무회귀 경로로 그대로 진행.
        repo_owner_org_id, repo_owner_reason = await _resolve_legacy_org_by_repo_owner(session, repo)
        logger.info(
            "legacy org resolve: repo=%s reason=%s org_id=%s", repo, repo_owner_reason, repo_owner_org_id,
        )
        if repo_owner_org_id is not None:
            org_id = repo_owner_org_id
            delivery.org_id = org_id

    # Bot-L.1 resolver 체인: explicit>auto high>SID>text. app/repo-owner-resolved legacy=org-scoped·
    # 그 외 legacy=SID 전역→story.org_id(무회귀).
    # ⚠️행동가능신호(merged/ci) skip **前**에 실행 — scope-check(§2)가 그 신호와 무관하게 판정돼야 함.
    rl = await resolve_story_for_pr(session, org_id, repo, pr_number, texts)
    if rl.story_id is None:
        skipped_reason = rl.reason
        # legacy 에서 org 해소 자체가 실패(ambiguous/unknown)했고 resolver 가 바로 그 이유(org 없어서
        # story_number 시도조차 못 함)로 skip했으면, 더 구체적인 새 이유로 대체 — 「조용히 안 붙는」
        # 것 방지(PO 지적, story #2327 후속): skipped_reason 이 세지는 이름이어야 나중에 판단 가능.
        if (
            source == "legacy"
            and org_id is None
            and repo_owner_reason in ("repo_owner_ambiguous", "repo_owner_unknown")
            and rl.reason == "story_number_requires_org_scope"
        ):
            skipped_reason = repo_owner_reason
        return {"skipped_reason": skipped_reason, "recorded": []}, "ignored"  # no_match/auto suggestion 등.
    story_id = rl.story_id
    org_id = rl.org_id  # app=입력 org·legacy=story.org_id(resolver 검증). 단일 진실원.
    delivery.org_id = org_id

    # story #2813 — PR 라이프사이클 자체(opened/reopened/ready_for_review/synchronize)는 CI/merge
    # 증거와 무관하게 merge 게이트를 GitHub check-run으로 반영한다. 설계 doc §2-1(PO 승인): 카드
    # 원안 "push 이벤트" 대신 `pull_request.synchronize`를 쓴다 — PR번호+head_sha가 payload에
    # 이미 있어 브랜치→PR 매칭 추가조회가 불요. synchronize는 SHA 재-pending(§2-2)도 겸한다.
    #
    # ⛔카디르 QA(PR#3243)③-b — 재-pending 가드를 synchronize 하나에만 걸면, PR이 **다른
    # head로 재오픈**(close→reopen 사이 강제 push 등)되거나 draft→ready_for_review로 전환되며
    # 그새 커밋이 바뀐 경우를 못 잡는다. 네 액션 전부에서 동일 가드를 돌린다(비교 비용은 동일).
    if (
        event == "pull_request"
        and pr_action in ("opened", "reopened", "ready_for_review", "synchronize")
        and head_sha
        and gate_check_publish is not None
    ):
        from app.models.gate import Gate as _Gate
        from app.services.gate_github_check import reopen_gate_if_new_sha
        from app.services.merge_verdict_gate import MERGE_GATE_TYPE as _MERGE_GATE_TYPE

        merge_gate = (
            await session.execute(
                select(_Gate).where(
                    _Gate.org_id == org_id, _Gate.work_item_id == story_id,
                    _Gate.work_item_type == "story", _Gate.gate_type == _MERGE_GATE_TYPE,
                )
            )
        ).scalar_one_or_none()
        if merge_gate is not None:
            await reopen_gate_if_new_sha(
                session, org_id, merge_gate, head_sha,
                repo_full_name=repo, pr_number=pr_number,
            )
            gate_check_publish.append({
                "org_id": org_id, "gate_id": merge_gate.id,
                "head_sha": head_sha, "repo_full_name": repo, "pr_number": pr_number,
            })

    # P0-05 후속(doc scope-violation-signal-design §2·§3): PR 자체 이벤트(opened/synchronize/reopened)
    # + confident link(should_auto_close 동일 신뢰 등급)일 때만 판정. 3중 침묵 조건은 헬퍼 내부.
    scope_result: dict | None = None
    if pr_action in ("opened", "synchronize", "reopened") and rl.should_auto_close:
        scope_result = await _maybe_check_scope_violation(
            session, org_id, story_id, repo, pr_number, installation, rl,
        )

    # 행동 가능한 신호(머지 또는 CI 완료)가 없으면 verdict capture는 skip — scope_result는 이미 반영됐다.
    if not merged and ci_conclusion is None:
        result: dict = {"skipped_reason": "no_actionable_signal", "recorded": []}
        if scope_result is not None:
            result["scope_check"] = scope_result
        return result, ("processed" if scope_result is not None else "ignored")

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

    # story #2156 AC2(2026-08-07) — 위 capture_pr_ci_verdict가 Verdict(신뢰축)엔 이미 실
    # 증거를 정확히 기록했는데, resolve_gate_from_verdict(capture_pr_ci_verdict 내부)의
    # _SOURCE_TO_GATE_TYPE엔 merge 매핑이 없어 그 증거가 merge-type 게이트엔 안 닿았다 —
    # pending/auto_passed merge 게이트가 있을 때만 evaluate_merge_gate를 실 증거로 재호출해
    # 반영한다. ⚠️capture_pr_ci_verdict 리턴 後 별도 호출(evaluate_merge_gate가 내부에서
    # capture_pr_ci_verdict를 다시 부르므로, 그 함수 안에서 이걸 부르면 무한 재귀가 된다).
    #
    # story #2520(2026-08-08) 근본수정 — 이전엔 이 호출을 `merge_gate_active(org_id)`(H1
    # 레거시 플래그+allowlist)로 게이팅했는데, merge-type Gate row는 H1 경로(board preflight·
    # report-done)뿐 아니라 workflow_line_engine._merge_gate_wrapper(라인엔진 merge-gate step,
    # `line_merge_gate_active()` — H1과 **완전히 별개**인 runtime_mode+published_config
    # 활성판정)에서도 만들어진다(evaluate_merge_gate→create_gate가 둘의 단일 chokepoint,
    # gate_type="merge" 공유). H1_MERGE_GATE_ENABLED=False인 org라도 라인 merge-gate step이
    # enforcing이면 실제 Gate row가 생기는데, 그 org는 merge_gate_active()가 항상 False라
    # 이 reconcile이 영원히 스킵됐다 — #2156이 고치려던 "증거 기록됐는데 게이트에 CI unknown"
    # 증상이 라인 경로서 그대로 재현(카디르 #2902 QA·codex 019fdc4f 적출). reconcile 자신의
    # 쿼리(아래 existing Gate row: org_id+story_id+gate_type="merge"+status pending/auto_passed)가
    # 이미 "이 story에 실제로 반영할 게이트가 있는가"를 정확히 판별하므로(없으면 즉시 None
    # 반환, 저렴한 단건 조회) 바깥에서 org-level 활성판정으로 다시 게이팅할 필요가 없다 —
    # H1도 라인도 「Gate row 존재」라는 같은 사실로 자연히 커버된다(두 활성판정 통합 = 애초에
    # 이 바깥 게이트가 불필요했다는 것).
    #
    # ⭐카디르 QA(PR#2902, 2026-08-07)③: try/except로 여기서 삼키면 일시적 DB 오류가 "이번
    # 배달은 영구 no-op(processed로 커밋)"이 돼 GitHub 재시도를 못 받는다(delivery 모델
    # 자체 계약 — "실패=rollback→retry 보존"). 이 함수 밖(github_webhook)이 이미 예외를
    # 전체 rollback+500으로 처리해 GitHub가 재시도하므로, 여기서 삼키지 않고 그대로 올린다.
    # story #2813(카디르 R2) — head_sha를 넘겨 auto_passed 판정 시 anchor(gate.approved_head_sha)
    # 즉시 확定(merge_verdict_gate.evaluate_merge_gate 참고).
    await reconcile_merge_gate_with_real_evidence(
        session, org_id, story_id,
        pr_number=pr_number, repo=repo, ci_result=ci_conclusion, merged=merged,
        head_sha=head_sha,
    )

    # ⭐story #2327 후속(PO 판정, 2026-07-30, PR#2685 실 웹훅 시험대가 드러낸 갭) — merge 시
    # PullRequestStoryLink 에도 쓴다. `Verdict`(record_verdict, 위 capture_pr_ci_verdict 안)에도
    # 쓰고 `PullRequestStoryLink`(여기)에도 쓴다 — 전자는 «신뢰/게이트 축» · 후자는 «UI 가 읽는
    # 링크 축»(GET /api/v2/integrations/github/links, github_integration.py). **둘이 갈리면 화면과
    # 판정이 다른 말을 한다** — 그래서 같은 이벤트에서 둘 다 쓴다(중복이 아니라 각자 다른 소비처).
    # ⛔여기서 도달한 story_id는 항상 confident 매치(explicit/auto-high/sid)뿐이라 rl.source가
    # 'sid'/'auto_match'/'explicit' 중 하나 — 사람이 명시한 게 아닌 이상 'explicit'로 «절대» 안
    # 찍힌다(오늘 소급 205건과 동일 라벨 규율). merge_link_evidence는 이미 있는 함수(scope-check
    # 용도로 open/synchronize에서 이미 쓰임)를 그대로 재사용 — 새 함수 0개, org+repo+pr_number
    # 존재 확인 후 upsert(멱등 — synchronize 뒤 merge가 와도 행 하나).
    # ⭐만료 조건: #2327의 「Verdict를 정본으로 삼고 PullRequestStoryLink를 은퇴」 판단이 실행되면,
    # 이 두 번째 쓰기(PullRequestStoryLink)는 그때 정리 대상이 된다.
    if merged:
        await merge_link_evidence(
            session, org_id, story_id, repo, pr_number,
            link_source=rl.source, confidence=rl.confidence,
            patch={"webhook_merge": {"recorded_at": datetime.now(timezone.utc).isoformat()}},
        )

    # ⛔story #2327 후속(PO 판정, 2026-07-30) — close-on-merge **정지**. 「머지 ≠ done, done은
    # 사람 확認 後」가 팀 규율인데 이 블록은 explicit/auto-high/sid confident link + merge만으로
    # 사람 확認 없이 즉시 done을 밀었다(advance_story_to_done 직접 호출) — 규율과 정면 충돌.
    # 지금까지는 SID 링크 해소 자체가 거의 항상 실패해(story #2202/#2327 실측) 이 분기에 실제로
    # 도달한 적이 드물어 드러나지 않았을 뿐, «게이트»가 아니라 **스위치 자체가 없는 무조건 실행**
    # 이었다(should_auto_close는 org/workflow 설정이 아니라 매 PR confidence로 즉석 계산되는 값).
    # SID 정규식 fix(story_number 인식, 이 PR)가 이 분기의 도달률을 정상적으로 되돌리면, 그 순간
    # «거짓 done 자동화»가 라이브에서 돌기 시작한다 — 그래서 fix와 같은 PR에서 정지시킨다.
    # ⛔advance_story_to_done()은 gate-approve(_advance_story_on_merge_approve)와 공유 헬퍼라
    # 그 함수 자체는 손대지 않는다 — 이 호출부(webhook merge 분기) 하나만 멈춘다. `would_close`로
    # "정지 안 했으면 벌어졌을 일"은 계속 보이게 남겨(관측 가능·소급 판단 재료), 실제 mutation만 뺀다.
    #
    # ⛔PO 지적(2026-07-30, em-dash PR#2668/2670 되돌림과 같은 교훈 — "지운 이유를 안 남기면
    # 다음 사람이 «자동 done이 빠졌네」로 되살린다"): 여기 다시 advance_story_to_done()을 넣기
    # 前에 반드시 확認할 것 —
    #   ①왜 뺐나: 「머지 ≠ done. done은 AC 전량 대조 실측 後」가 이 조직의 규율이고, 이 블록은
    #     explicit/auto-high/sid confident link + merge만으로 사람 확認 없이 즉시 done을 밀었다.
    #   ②무엇이 없어졌나: explicit SID + merged → 자동 done. 지금은 사람이 판단한다(auto_close.
    #     would_close로 "됐을 일"만 관측 가능하게 남김, 실제 전이는 0).
    #   ③⭐만료 조건(되살릴 문): 조직이 "자동 done을 켜고 끄는" 설정(org/workflow 단위)을 갖게
    #     되면, 그 설정을 읽어 조건부로 되살린다 — 그 설정 자체가 아직 없다(이 파일 존재 확認,
    #     별건으로 PO가 세운다). 설정 없이 이 줄만 되돌리면 오늘과 같은 사고(사람 확認 없는
    #     자동 done)가 재발한다.
    if merged and rl.should_auto_close:
        # PO 지적(2026-07-30): 웹훅 HTTP 응답은 아무도 안 읽는다(호출자가 GitHub) — would_close를
        # «셀 수 있게» 로그에도 남긴다. 이 로그 건수가 #2339(자동 done on/off 설정)의 크기를
        # 재는 자다(0이면 안 급함·많으면 급함).
        logger.info(
            "auto_close suppressed: story=%s source=%s confidence=%s",
            story_id, rl.source, rl.confidence,
        )
        result = {
            **result,
            "auto_close": {
                "closed": False, "would_close": True,
                "source": rl.source, "confidence": rl.confidence,
                "note": "story #2327 PO 판정 2026-07-30: close-on-merge 정지 — done은 사람 확認 後",
            },
        }
    if scope_result is not None:
        result = {**result, "scope_check": scope_result}
    return result, "processed"


async def _maybe_check_scope_violation(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    repo: str,
    pr_number: int,
    installation: GithubInstallation | None,
    rl,
) -> dict | None:
    """P0-05 후속(doc scope-violation-signal-design §2·§4) — 3중 침묵 조건 집행.

    ①declared_scope_paths 미설정 → None(fetch 자체 안 함). ②installation/토큰/changed-files fetch
    실패 → None(추측 금지 — "판정 불가"≠"위반 아님"). ③실제 판정(위반 여부 무관하게 결과를 evidence에
    기록 — violated=False도 유효한 판정 결과). merge_link_evidence로 dict-merge(기존 evidence 키 보존).
    """
    story = await session.get(Story, story_id)
    if story is None or story.org_id != org_id:
        return None
    declared = story.declared_scope_paths
    if not declared:
        return None  # 침묵①: 미선언.

    inst = installation
    if inst is None:  # legacy(app 미상): org→installation resolve(suspended 제외).
        inst = (
            await session.execute(
                select(GithubInstallation).where(
                    GithubInstallation.org_id == org_id,
                    GithubInstallation.suspended_at.is_(None),
                )
            )
        ).scalar_one_or_none()
    if inst is None:
        return None  # 침묵②: installation 없음.

    token = await get_installation_token(inst.installation_id)
    if not token:
        return None  # 침묵②: 토큰 발급 실패.

    changed_files = await fetch_pr_changed_files(repo, pr_number, token)
    if changed_files is None:
        return None  # 침묵②: fetch 실패/판정불가(추측 금지).

    violated, out_of_scope = check_scope_violation(declared, changed_files)
    await merge_link_evidence(
        session, org_id, story_id, repo, pr_number,
        link_source=rl.source or "auto_match", confidence=rl.confidence or "low",
        patch={"scope_check": {
            "violated": violated,
            "out_of_scope_files": out_of_scope,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    return {"violated": violated, "out_of_scope_files": out_of_scope}


@router.post("/github-webhook")
async def github_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    x_github_event: str | None = Header(default=None),
    x_hub_signature_256: str | None = Header(default=None),
    x_github_delivery: str | None = Header(default=None),
) -> JSONResponse:
    """GitHub 웹훅 통합 ingress(Bot-M.2) → [SID:uuid]/installation 라우팅 → capture_pr_ci_verdict.

    보안(산티아고 lock): ⭐**HMAC-before-parse**(검증 前 parse/DB/dedup/capture 0)·source 는 **검증된
    secret 으로만**(payload 금지)·dedup `(source, delivery_id)` insert+side-effect+status **동일 트랜잭션**
    (실패=rollback→GitHub retry 보존·중복=2xx no-op)·app=installation resolve 後 org-scope(anti-IDOR).

    story #2813: PR 라이프사이클 이벤트가 만든 GitHub check-run 발행은 **commit 後**(fail-closed —
    외부 API 호출을 DB 트랜잭션 확정 前에 하지 않는다) `background_tasks`로.
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
    _gate_check_publish: list[dict] = []
    try:
        result, status_label = await _process_webhook_event(
            session, source, event, payload, installation_id, delivery,
            gate_check_publish=_gate_check_publish,
        )
        delivery.status = status_label
        # story #2327(재정의): "ignored"의 실제 사유를 delivery 행에도 남긴다 — HTTP 응답
        # 본문에만 있으면 웹훅 호출자(GitHub)만 보고 아무도 회고 측정을 못 한다.
        delivery.skipped_reason = result.get("skipped_reason") if status_label == "ignored" else None
        delivery.processed_at = datetime.now(timezone.utc)
        await session.commit()
        # story #2813: commit 확정 後에만 GitHub check-run 발행(fail-closed).
        if _gate_check_publish:
            from app.services.gate_github_check import publish_gate_check

            for _payload in _gate_check_publish:
                background_tasks.add_task(publish_gate_check, **_payload)
        return _ok(result)
    except Exception as exc:
        await session.rollback()  # delivery insert 포함 전부 rollback → GitHub retry 가 재처리(영구 no-op 금지).
        logger.exception("github webhook 처리 실패 delivery=%s event=%s: %s", x_github_delivery, event, exc)
        return _err("WEBHOOK_PROCESSING_FAILED", "처리 중 오류(재시도 가능)", 500)
