"""
Internal cron endpoints — called by Next.js /api/cron/* routes.
All endpoints require CRON_SECRET via Authorization: Bearer header.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db, get_worker_db
from app.models.agent_run import AgentRun
from app.models.agent_session import AgentSession
from app.models.asset import Asset
from app.models.hitl import HitlRequest
from app.models.org_subscription import OrgSubscription
from app.models.plan_tier_limit import PlanTierLimit
from app.models.project import OrgMember
from app.models.user import User
from app.services.email import send_email
from app.services.storage import get_storage_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/internal/cron", tags=["cron"])

CRON_SECRET = os.environ.get("CRON_SECRET")


def _ok(data: object) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None})


def _err(code: str, message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


def verify_cron(request: Request) -> None:
    """story #2072(high, 2026-07-21) 근본수정 — 기존엔 `if not CRON_SECRET: return`(환경
    무관 무조건 허용)이라 `_require_internal_secret`(#2071)보다도 더 넓게 열려 있었다(둘 다
    "시크릿 없으면 연다"는 같은 안티패턴 — agent_inbox.py `_verify_signature`가 유일한 정답
    형태: "secret 미설정 시 open ingestion 차단"). 지금은 dev/prod 둘 다 `CRON_SECRET`이
    secretRef로 배선돼 있어 무인증은 아니지만(오르테가군 실측), 배선이 한 번이라도 비면
    (배포 실수·로테이션·env 누락) 전 cron이 열리는 구조적 위험이었다.

    `_require_internal_secret`(#2071)과 동일 기준으로 좁힌다 — story #2152 이후로는
    `settings.is_internal_secret_gate_exempt`(`app/core/config.py` SSOT) 단일 프로퍼티만
    본다 — app_env 체크를 이 파일에서 직접 반복하지 않는다(#2152 AC4: is_really_local을
    app_env와 따로 떼어 쓸 여지 자체를 구조로 없앤다)."""
    if not CRON_SECRET:
        if settings.is_internal_secret_gate_exempt:
            return  # 진짜 로컬 개발 전용 예외(Cloud Run/GCE 위가 아님)
        logger.warning(
            "cron.secret_missing_in_non_local_env app_env=%s on_cloud_run=%s",
            settings.app_env, not settings.is_really_local,
        )
        raise HTTPException(status_code=503, detail="Service misconfigured")
    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {CRON_SECRET}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def check_cron_secret_config(s=None) -> None:
    """fail-closed startup 가드(story #2072) — `check_internal_secret_config`(#2071)와
    동형(check_listen_config()와 동일 패턴, main lifespan이 호출 대상). non-local(진짜
    로컬이 아닌)인데 `CRON_SECRET` 미설정이면 배포 자체를 막는다 — 런타임 503보다 먼저,
    더 시끄럽게 잡는 쪽이 안전하다."""
    if s is None:
        from app.core.config import settings as s
    _not_local = not s.is_internal_secret_gate_exempt
    if _not_local and not CRON_SECRET:
        raise RuntimeError(
            f"APP_ENV={s.app_env}인데 CRON_SECRET 미설정 — 내부 cron 엔드포인트가 인증 없이 "
            "공개된다(fail-closed·story #2072)."
        )


# ─── GET /api/v2/internal/cron/agent-session-recovery ─────────────────────────

@router.get("/agent-session-recovery")
async def agent_session_recovery(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        now = datetime.now(timezone.utc)
        stale_cutoff = now - timedelta(minutes=30)

        # 30분 이상 running 상태인 세션을 stale로 전환
        result = await session.execute(
            select(AgentSession).where(
                AgentSession.status == "active",
                AgentSession.last_activity_at < stale_cutoff,
                AgentSession.ended_at.is_(None),
                AgentSession.terminated_at.is_(None),
            )
        )
        stale_sessions = list(result.scalars().all())

        recovered_count = 0
        for s in stale_sessions:
            s.status = "idle"
            s.idle_at = now
            recovered_count += 1

        await session.commit()

        return _ok({
            "recovered_count": recovered_count,
            "retry_scheduled_count": 0,
            "terminated_count": 0,
            "resumed_count": 0,
        })
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── POST /api/v2/internal/cron/anonymize ─────────────────────────────────────

@router.post("/anonymize")
async def anonymize(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    # OSS 모드에서는 Supabase auth 삭제가 없음 — no-op 반환
    return _ok({"anonymized": [], "deleted": []})


# ─── GET /api/v2/internal/cron/hitl-timeouts ──────────────────────────────────

@router.get("/hitl-timeouts")
async def hitl_timeouts(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        now = datetime.now(timezone.utc)

        # 만료된 pending HITL 요청을 expired 상태로 전환
        result = await session.execute(
            select(HitlRequest).where(
                HitlRequest.status == "pending",
                HitlRequest.expires_at.is_not(None),
                HitlRequest.expires_at < now,
            )
        )
        expired = list(result.scalars().all())

        expired_count = 0
        for req in expired:
            req.status = "expired"
            expired_count += 1

        await session.commit()

        return _ok({"expired_count": expired_count, "notified_count": 0})
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/expire-stale-events ────────────────────────────
# E-EVENT-1CONFIG: backfill landmine 박멸의 cleanup 짝. ACK retire 가 agent SSE 이벤트를
# delivered 로 마킹해도, 이 cron 이 호출돼야 실제로 회수(삭제)된다. 기존 /events/expire-stale 은
# org-scoped(헤더 의존)·호출자 0 이었다 → 전 org 일괄 cleanup 으로 cron 연결.
@router.get("/expire-stale-events")
async def expire_stale_events_cron(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.routers.events import expire_stale_events_core

        result = await expire_stale_events_core(session, org_id=None)  # 전 org
        return _ok(result)
    except Exception as exc:
        logger.exception("cron error (expire-stale-events): %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── POST /api/v2/internal/cron/onboarding-abandoned-sweep ────────────────────
# OB-4b: funnel abandoned 파생(BE SoT). config_generated 후 30분 미verified·미abandoned →
# abandoned 1건(furthest 단계로 failure_reason). FE abandoned_explicit 과 이중계상 금지(terminal dedup).

@router.post("/onboarding-abandoned-sweep")
async def onboarding_abandoned_sweep(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.onboarding_funnel import sweep_abandoned_onboarding

        emitted = await sweep_abandoned_onboarding(session)
        return _ok({"abandoned_emitted": emitted})
    except Exception as exc:
        logger.exception("cron error (onboarding-abandoned-sweep): %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/workflow-handoff-watchdog ──────────────────────
# E-DG S8: handoff watchdog + ACK reconciliation(P0-3). silent handoff stall 을 observable
# incident 로 전환 — ACK 대사 → acked / 10분 미ACK → timed_out(board badge) + fallback notification.

@router.get("/workflow-handoff-watchdog")
async def workflow_handoff_watchdog(
    request: Request,
    # story #2461(§6 봉합③ part2, PO 승인 2026-08-05): get_db(요청 primary 풀) 대신
    # get_worker_db(전용 워커풀) — reconcile_handoffs()의 FOR UPDATE SKIP LOCKED 트랜잭션이
    # 요청 경로 풀 예산을 소모하지 않는다.
    session: AsyncSession = Depends(get_worker_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.workflow_handoff_watchdog import reconcile_handoffs
        counts = await reconcile_handoffs(session)
        return _ok(counts)
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/workflow-sla ───────────────────────────────────
# E-DG S13(P1-3): human-gate SLA processor — pending gate 가 방치되지 않게 reminder→escalation→
# timeout(keep_pending 기본·auto_approve 금지조건) 으로 제품이 독촉. hitl-timeouts 와 별도 endpoint.

@router.get("/workflow-sla")
async def workflow_sla(
    request: Request,
    # story #2461(§6 봉합③ part2): 위 workflow_handoff_watchdog와 동일 근거 — 전용 워커풀.
    session: AsyncSession = Depends(get_worker_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.workflow_sla_processor import process_sla
        counts = await process_sla(session)
        return _ok(counts)
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/workflow-grandfather-backfill ──────────────────
# E-DG S19(P0-5): line enable 시점 in-flight story grandfather backfill(read-only·Gate 0·
# idempotent). allowlist(=명시 enable) org 만 대상. board freeze 0.

@router.get("/workflow-grandfather-backfill")
async def workflow_grandfather_backfill(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.workflow_grandfather import backfill_grandfather, resolve_backfill_orgs
        # B1: allowlist org + global-enable(allowlist 빈+enabled) 시 in-flight org 전체 커버.
        orgs = await resolve_backfill_orgs(session)
        results = {str(oid): await backfill_grandfather(session, oid) for oid in orgs}
        return _ok({"orgs": len(orgs), "results": results})
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/seed-default-story-line ────────────────────────
# E-DG S16: 뭉클랩(기본) org 의 default story line 을 published(shadow)로 시드(idempotent). PO 트리거.
# ?org_id= 로 다른 org 시드. default-off·shadow 라 라이브 무영향.

@router.get("/seed-default-story-line")
async def seed_default_story_line_cron(
    request: Request,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID | None = Query(default=None),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.workflow_line_seed import seed_default_story_line
        result = await seed_default_story_line(session, org_id)
        return _ok(result)
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/entity-references-orphan-check ─────────────────
# story #2274(C-1c) AC4: count_orphan_types(#2259가 만든 함수)에 「도는 자리」를 준다 —
# 안 그러면 그 함수 자체가 「만들어졌는데 도는 자리가 없는」 것이 된다. 정상은 0(registry
# 밖 타입이 entity_references에 하나도 안 쌓였다는 뜻) — 0이 아니면 write 경로 어딘가
# (registry 검증을 우회한 직접 INSERT 등)가 오타/미등록 타입을 조용히 통과시킨 것이다.
# ⛔이 엔드포인트는 데이터를 바꾸지 않는다(read-only 점검) — 결과는 응답 JSON + 로그에
# 남는다(logger.warning으로 0이 아닌 경우 특히 눈에 띄게).
# ⛔#2273에서 이 엔드포인트를 처음 붙였을 때 CI가 전역 401로 깨졌다 — 원인은 이 엔드포인트
# 자체가 아니라, 그때 짠 테스트가 CRON_SECRET을 monkeypatch 없이 직접 대입해 복원을 안 한
# 것이었다(#2274 AC1, 재현까지 완료). 이 엔드포인트 코드 자체는 다른 cron 엔드포인트와
# 동일한 verify_cron() 패턴 그대로다(AC7 — 인증을 새로 발명하지 않는다).

@router.get("/entity-references-orphan-check")
async def entity_references_orphan_check(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.reference_registry import count_orphan_types
        orphans = await count_orphan_types(session)  # org_id=None → 전체 org
        total = sum(orphans.values())
        if total:
            logger.warning("entity_references orphan types found: %s (total=%d)", orphans, total)
        return _ok({"orphans": orphans, "total": total})
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/zero-referenced-entities-check ─────────────────
# story #2277(E-CONNECT) AC1/AC2/AC3 — "이것을 가리키는 참조가 0건"인 doc·story 수를 센다.
# #2274와 동일 패턴(verify_cron·read-only·다른 인증 발명 없음, AC7 동형 근거).
#
# ⛔AC5(권한)는 이 cron에 안 붙는다(PO 판정 2026-07-29) — cron엔 「보는 사람」이 없어 권한
# 축이 서지 않는다. AC5는 이 수를 사용자에게 노출하는 층이 생길 때 그 층에 붙는다.
#
# ⛔AC2 최종판정(PO, dev 실측 후 정정, 2026-07-29): 표·노출층은 «짓지 않는다». dev 실측
# (`sprintable-verify-oneoff` job 재사용, CRON_SECRET 불필요 — job이 private-IP로 dev DB에
# 직접 접속): doc 871/883·story 2497/2512가 zero_referenced였으나 `entity_references` 총
# 행수가 62뿐이었다 — 이 수는 「고아」가 아니라 「참조추적 자체가 아직 안 돈 것」(분모미채움)
# 이었다. 지금 표를 지으면 2497건이 「고아」로 보여 없는 문제를 만드는 거짓 지표가 된다.
# AC2는 여기서 "지금은 없다"로 명시하고 닫는다 — ⭐만료 조건: `entity_references_total`이
# 일감 수(story 총량) 대비 유의미해질 때(예: 1/10 초과) 이 수가 비로소 「고아」를 뜻하기
# 시작하고, 그때 표·노출층을 짓는다. 그 전까지 이 cron의 응답+로그가 이 스토리의 「도는
# 자리」 전부다.
#
# ⛔AC3 — 응답은 zero_referenced/total 절대값과 entity_references_total(분모)을 **항상 같이**
# 싣는다(분모 없이 절대값만 보면 다음 사람이 "2497건 고아"로 오독한다 — 오늘 실제로 PO
# 자신이 먼저 그 오독을 할 뻔했다가 스스로 잡았다). caveat 문안은 디디가 세운 것 그대로
# (bare "출처 없음"/"참조 없음" 금지 — 미수집을 "없음"으로 표시하면 거짓이라는 게 핵심).
_AC3_CAVEAT = (
    "관찰된 참조 0건(수집범위: mention/embed, source=chat_message·doc만 — "
    "PR/커밋/증거자유텍스트는 미수집이라 이 수에 없음)"
)


@router.get("/zero-referenced-entities-check")
async def zero_referenced_entities_check(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.backlinks import count_entity_references_total, count_zero_referenced_entities

        zero_referenced = await count_zero_referenced_entities(session)  # org_id=None → 전체 org
        entity_references_total = await count_entity_references_total(session)
        total = sum(zero_referenced.values())
        logger.info(
            "zero-referenced entities: %s (total=%d, entity_references_total=%d)",
            zero_referenced, total, entity_references_total,
        )
        return _ok({
            "zero_referenced": zero_referenced,
            "total": total,
            "entity_references_total": entity_references_total,
            "caveat": _AC3_CAVEAT,
        })
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/inbox-outbox ────────────────────────────────────

@router.get("/inbox-outbox")
async def inbox_outbox(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    # inbox-outbox 처리 — 현재 SQLAlchemy 기반 구현에서는 no-op (Supabase pg_cron 대체)
    return _ok({"processed": 0, "dispatched": 0})


# ─── GET /api/v2/internal/cron/retry-agent-runs ────────────────────────────────

@router.get("/retry-agent-runs")
async def retry_agent_runs(
    request: Request,
    dry_run: bool = Query(default=False),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        now = datetime.now(timezone.utc)

        # next_retry_at이 도래한 failed run의 retry-eligible 필터. dry_run/실행이 **동일 필터**를
        # 써야 preview 수 == 실제 처리 건수가 보장된다(스케줄 가동 전 surge 규모 정확).
        eligible_filter = (
            AgentRun.status == "failed",
            AgentRun.next_retry_at.is_not(None),
            AgentRun.next_retry_at <= now,
            AgentRun.retry_count < AgentRun.max_retries,
        )

        # dry_run: read-only preview — eligible count만 반환·mutate/commit 0(가동 전 안전 점검).
        if dry_run:
            count = (
                await session.execute(
                    select(func.count()).select_from(AgentRun).where(*eligible_filter)
                )
            ).scalar_one()
            return _ok({"dry_run": True, "eligible_count": int(count)})

        # next_retry_at이 도래한 failed run 조회
        result = await session.execute(select(AgentRun).where(*eligible_filter))
        pending = list(result.scalars().all())

        retried: list[dict] = []
        final_failures: list[dict] = []

        for run in pending:
            if run.retry_count >= run.max_retries:
                run.failure_disposition = "final"
                final_failures.append({"run_id": str(run.id), "status": "final_failure"})
            else:
                run.status = "queued"
                run.next_retry_at = None
                retried.append({"run_id": str(run.id), "status": "retried"})

        await session.commit()

        return _ok({
            "retried": retried,
            "final_failures": final_failures,
            "total": len(retried) + len(final_failures),
        })
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── POST /api/v2/internal/cron/score-ga4-outcomes ────────────────────────────

@router.post("/score-ga4-outcomes")
async def score_ga4_outcomes(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """E-OUTCOME-LOOP S5: GA4 지연 채점 잡.

    measure_after <= now AND outcome_status = 'pending' AND source = 'ga4'인
    story·sprint를 GA4 Data API로 채점.
    """
    verify_cron(request)

    from app.models.pm import Goal, Sprint, Story
    from app.services.outcome_scorer import score_epic_outcome, score_ga4_outcome

    now = datetime.now(timezone.utc)
    scored: list[dict] = []
    failed: list[dict] = []

    try:
        # Sprint GA4 채점
        sprint_result = await session.execute(
            select(Sprint).where(
                Sprint.outcome_status == "pending",
                Sprint.measure_after.isnot(None),
                Sprint.measure_after <= now,
            )
        )
        for sprint in sprint_result.scalars().all():
            md = sprint.metric_definition
            if not md or md.get("source") != "ga4":
                continue
            try:
                scoring = score_ga4_outcome(md)
                sprint.outcome_status = scoring["outcome_status"]
                sprint.outcome_result = scoring["outcome_result"]
                scored.append({"type": "sprint", "id": str(sprint.id), "outcome_status": scoring["outcome_status"]})
            except Exception as exc:
                logger.warning("ga4 sprint scoring failed id=%s: %s", sprint.id, exc)
                failed.append({"type": "sprint", "id": str(sprint.id), "error": str(exc)})

        # Story GA4 채점
        story_result = await session.execute(
            select(Story).where(
                Story.outcome_status == "pending",
                Story.measure_after.isnot(None),
                Story.measure_after <= now,
                Story.deleted_at.is_(None),
            )
        )
        for story in story_result.scalars().all():
            md = story.metric_definition
            if not md or md.get("source") != "ga4":
                continue
            try:
                scoring = score_ga4_outcome(md)
                story.outcome_status = scoring["outcome_status"]
                story.outcome_result = scoring["outcome_result"]
                scored.append({"type": "story", "id": str(story.id), "outcome_status": scoring["outcome_status"]})
            except Exception as exc:
                logger.warning("ga4 story scoring failed id=%s: %s", story.id, exc)
                failed.append({"type": "story", "id": str(story.id), "error": str(exc)})

        # Goal(구 Epic) 채점 (GA4 + internal_ops)
        epic_result = await session.execute(
            select(Goal).where(
                Goal.outcome_status == "pending",
                Goal.measure_after.isnot(None),
                Goal.measure_after <= now,
            )
        )
        for epic in epic_result.scalars().all():
            md = epic.metric_definition
            if not md:
                continue
            source = md.get("source")
            try:
                if source == "ga4":
                    scoring = score_ga4_outcome(md)
                elif source == "internal_ops":
                    # 하위 스토리 진행률 계산
                    story_rows = await session.execute(
                        select(Story.status).where(
                            Story.epic_id == epic.id,
                            Story.deleted_at.is_(None),
                        )
                    )
                    rows = story_rows.scalars().all()
                    total = len(rows)
                    done = sum(1 for s in rows if s == "done")
                    pct = round((done / total * 100) if total > 0 else 0.0, 2)
                    result = score_epic_outcome(md, pct)
                    if result is None:
                        continue
                    scoring = result
                else:
                    scoring = {"outcome_status": "pending", "outcome_result": None}
                # status는 건드리지 않음 — outcome_status/outcome_result만 기록
                epic.outcome_status = scoring["outcome_status"]
                epic.outcome_result = scoring["outcome_result"]
                scored.append({"type": "epic", "id": str(epic.id), "outcome_status": scoring["outcome_status"]})
            except Exception as exc:
                logger.warning("epic scoring failed id=%s: %s", epic.id, exc)
                failed.append({"type": "epic", "id": str(epic.id), "error": str(exc)})

        await session.commit()

        return _ok({"scored": scored, "failed": failed, "total": len(scored) + len(failed)})
    except Exception as exc:
        logger.exception("cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── POST /api/v2/internal/cron/score-hypotheses ──────────────────────────────

@router.post("/score-hypotheses")
async def score_hypotheses_cron(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """E1-S4: Hypothesis 지연 채점 잡(블루프린트 §8.3).

    measure_after <= now 인 active/measuring 가설을 채점 — active→measuring 전이 후
    ga4/internal_ops 지표로 verified|falsified 판정(실패·미지원은 measuring 유지). legacy
    /score-ga4-outcomes와 분리(hypotheses 테이블만). 스케줄 배선은 별도 운영 story.
    """
    verify_cron(request)

    from app.services.hypothesis_scorer import score_hypotheses

    try:
        summary = await score_hypotheses(session)
        await session.commit()
        return _ok(summary)
    except Exception as exc:
        logger.exception("score-hypotheses cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── POST /api/v2/internal/cron/embed-backlog ──────────────────────────────────

@router.post("/embed-backlog")
async def embed_backlog_cron(
    request: Request,
    # story #2461(§6 봉합③ part2, PO 승인 2026-08-05): get_db 대신 get_worker_db — 이 함수
    # 안에서 FOR UPDATE SKIP LOCKED 락을 쥔 채 동기 Vertex AI 호출(asyncio.to_thread로
    # 이벤트루프는 안 막지만 세션/락 자체는 그 구간 내내 열려 있음, 유료 API 중복호출 방지
    # 위해 의도적으로 유지 — embedding_backlog.py docstring 참조)이 요청 primary 풀이 아닌
    # 전용 워커풀에서만 그 시간을 소모하게 한다.
    session: AsyncSession = Depends(get_worker_db),
) -> JSONResponse:
    """E-LOOP-LEDGER P1-S3: embeddings 백로그(status pending/failed) 배치 임베딩(블루프린트 §P1).

    embed_client(P1-S2, gemini-embedding-001@768) 호출 — 성공 시 ready(벡터 저장), 실패(인증불가/
    API오류/응답이상)는 원인 구분 불가라 pending 유지(false-hit 0 설계 계승, 다음 tick 재시도).
    FOR UPDATE SKIP LOCKED로 중첩 invocation 간 disjoint 배치 보장(workflow_handoff_watchdog 동형).
    tick당 상한 있음(폭주 방지). 신규 write-path(P1-S4)가 쌓은 pending row를 이 cron이 drain.
    """
    verify_cron(request)

    from app.services.embedding_backlog import process_embedding_backlog

    try:
        summary = await process_embedding_backlog(session)
        await session.commit()
        return _ok(summary)
    except Exception as exc:
        logger.exception("embed-backlog cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── POST /api/v2/internal/cron/embed-backfill ─────────────────────────────────

@router.post("/embed-backfill")
async def embed_backfill_cron(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """E-LOOP-LEDGER P1-S5: 기존 hypothesis/loop/loop_artifact 전체를 embeddings status='pending'으로
    1회 backfill(블루프린트 §P1). 네트워크 I/O 0(enqueue_embedding=INSERT/UPSERT만) — 실제 임베딩은
    P1-S3(embed-backlog) cron이 후속 처리. content_hash 멱등이라 재실행해도 안전(순수 1회성 아님,
    안전하게 재트리거 가능). 신규 마이그 0 — 순수 스크립트로 gcloud/migrate 잡과 무관.
    """
    verify_cron(request)

    from app.services.embedding_backfill import backfill_embeddings

    try:
        counts = await backfill_embeddings(session)
        await session.commit()
        return _ok(counts)
    except Exception as exc:
        logger.exception("embed-backfill cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── POST /api/v2/internal/cron/unattached-snapshot ────────────────────────────

@router.post("/unattached-snapshot")
async def unattached_snapshot_cron(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """story #2536(E-FLOW-V4 S4): 프로젝트별 unattached_count 일별 스냅샷 append.

    v4 강제(S2, #2532)가 신규 story의 가설/목표 부착을 요구하므로 기존 미매달림 총량이
    시간에 걸쳐 줄어야 하고, 그 추세(스파크라인)를 그리려면 시계열이 필요 — 이 cron이
    매일 실행되며 그 시계열을 쌓는다. append-only(재실행해도 새 행만 추가, upsert 없음).
    """
    verify_cron(request)

    from app.services.unattached_snapshot import compute_and_record_unattached_snapshots

    try:
        results = await compute_and_record_unattached_snapshots(session)
        await session.commit()
        return _ok({"projects": len(results), "results": results})
    except Exception as exc:
        logger.exception("unattached-snapshot cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── S8: storage capacity lifecycle crons ─────────────────────────────────────

_ASSET_GRACE_DAYS = 7
_STORAGE_WARN_THRESHOLD = 0.8
_STORAGE_WARN_COOLDOWN = timedelta(days=7)


@router.get("/assets-grace-hard-delete")
async def assets_grace_hard_delete(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """S8: soft-delete(deleted_at) 7일 경과 asset hard-delete — blob(provider)+row(asset_links FK CASCADE).

    best-effort: blob delete 성공(또는 이미 없음=멱등) 시에만 row 삭제. blob delete 실패 시 row 보존
    →다음 tick 재시도(orphan 0). tick당 최대 500건(폭주 방지).
    """
    verify_cron(request)
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=_ASSET_GRACE_DAYS)
        rows = list((await session.execute(
            select(Asset)
            .where(Asset.deleted_at.is_not(None), Asset.deleted_at < cutoff)
            .limit(500)
        )).scalars().all())
        provider = get_storage_provider()
        deleted = 0
        failed = 0
        for a in rows:
            if await provider.delete_object(a.container, a.object_path):
                await session.delete(a)  # asset_links 는 FK ondelete=CASCADE 로 자동 삭제
                deleted += 1
            else:
                failed += 1  # blob delete 실패 → row 보존(다음 tick 재시도)
        await session.commit()
        return _ok({"hard_deleted": deleted, "blob_delete_failed": failed})
    except Exception as exc:
        logger.exception("assets-grace-hard-delete cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/a2a-task-deadline-sweep ────────────────────────
# E-A2A-완성 S-A1(story 2a57dc0f): WORKING 영구정체 방지 — 기존 GetTask 인라인 판정(반응형,
# 캐ller 폴링 의존)과 별개로 폴링과 무관하게 기한 초과 task를 능동적으로 FAILED 전이한다.

@router.get("/a2a-task-deadline-sweep")
async def a2a_task_deadline_sweep(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.a2a_task_lifecycle import sweep_expired_a2a_tasks
        result = await sweep_expired_a2a_tasks(session)
        return _ok(result)
    except Exception as exc:
        logger.exception("cron error (a2a-task-deadline-sweep): %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/agent-run-timeout-sweep ────────────────────────
# story #2161(2026-07-24, 오르테가군 판정): agent_runs 'running' 영구정체 방지 —
# a2a-task-deadline-sweep(위)과 동일 근본·동일 처방(폴링 무관 능동 CAS 전이). deadline_at
# 폴백(NULL이면 started_at + AGENT_RUN_TIMEOUT_HOURS)이 기존 stuck row도 사정권에 넣는다.

@router.get("/agent-run-timeout-sweep")
async def agent_run_timeout_sweep(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.agent_run_lifecycle import sweep_expired_agent_runs
        result = await sweep_expired_agent_runs(session)
        return _ok(result)
    except Exception as exc:
        logger.exception("cron error (agent-run-timeout-sweep): %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


@router.get("/storage-usage-warn")
async def storage_usage_warn(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """S8: SaaS org storage 사용량이 캡의 80%+ 면 owner/admin 경고 메일(dedup·cooldown 7일).

    org_subscription(active) 대상. 캡 미정의 tier=무제한(skip). 80% 미만 복귀 시 마커 re-arm(재크로싱 시
    즉시 재경고). 메일 실패는 best-effort(개별 흡수). cooldown 내 재발송 금지(storage_warn_notified_at).
    """
    verify_cron(request)
    try:
        now = datetime.now(timezone.utc)
        subs = list((await session.execute(
            select(OrgSubscription).where(OrgSubscription.status == "active")
        )).scalars().all())
        caps = {
            t: mb for t, mb in (await session.execute(
                select(PlanTierLimit.tier, PlanTierLimit.max_storage_mb)
            )).all()
        }
        notified = 0
        for sub in subs:
            cap_mb = caps.get(sub.tier)
            if not cap_mb:
                continue  # 캡 미정의 tier = 무제한
            cap_bytes = int(cap_mb) * 1024 * 1024
            used = int((await session.execute(
                select(func.coalesce(func.sum(Asset.size_bytes), 0)).where(
                    Asset.org_id == sub.org_id, Asset.deleted_at.is_(None)
                )
            )).scalar_one())
            if used < cap_bytes * _STORAGE_WARN_THRESHOLD:
                if sub.storage_warn_notified_at is not None:  # 80% 미만 복귀 → re-arm
                    await session.execute(
                        update(OrgSubscription)
                        .where(OrgSubscription.id == sub.id)
                        .values(storage_warn_notified_at=None)
                    )
                continue
            if (
                sub.storage_warn_notified_at is not None
                and (now - sub.storage_warn_notified_at) < _STORAGE_WARN_COOLDOWN
            ):
                continue  # cooldown 내 — 재발송 금지(dedup)
            emails = [
                r[0] for r in (await session.execute(
                    select(User.email)
                    .join(OrgMember, User.id == OrgMember.user_id)
                    .where(
                        OrgMember.org_id == sub.org_id,
                        OrgMember.role.in_(["owner", "admin"]),
                        OrgMember.deleted_at.is_(None),
                    )
                )).all()
            ]
            pct = round(used / cap_bytes * 100, 1)
            subject = f"[Sprintable] Storage usage at {pct}%"
            html = (
                f"<p>Your organization's storage usage has reached <b>{pct}%</b> "
                f"({used // (1024 * 1024)}MB / {cap_mb}MB).</p>"
                f"<p>Free up space (delete unused files) or upgrade your plan to avoid upload limits.</p>"
            )
            for em in emails:
                try:
                    send_email(em, subject, html)
                except Exception:
                    logger.warning("storage-usage-warn email 실패 org=%s", sub.org_id, exc_info=True)
            await session.execute(
                update(OrgSubscription)
                .where(OrgSubscription.id == sub.id)
                .values(storage_warn_notified_at=now)
            )
            notified += 1
        await session.commit()
        return _ok({"notified_orgs": notified})
    except Exception as exc:
        logger.exception("storage-usage-warn cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/db-connection-stats ─────────────────────────

@router.get("/db-connection-stats")
async def db_connection_stats(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """SID f2fe1c5e/#2040 AC2: pg_stat_activity를 application_name(서비스:리비전[:연결종류])·
    state별로 집계 — "어느 서비스가 커넥션을 몇 개 쓰는지 분해할 수 없다"는 계측 부재를 없앤다.

    backend가 아닌 application_name(internal-api·migration job·운영 psql 등)은 db_application_name()
    태그가 없으므로 그대로 노출돼 "예산에 안 잡힌 소비자"를 이 표에서 바로 식별할 수 있다.

    2026-07-20 오르테가군 실측(dev 100 중 78이 무태그)으로 application_name·state만으로는
    무태그 소비자를 더 쪼갤 수 없다는 게 드러나 usename·최대 idle 시간(초)을 추가했다 —
    다른 저장소(internal-api)를 건드리지 않고도 DB 역할(usename)로 후보를 좁히고, 오래
    idle인지(누수 후보) 짧게 회전하는지(정상 소비)를 구분한다.

    2026-07-20 후속 실측 2건 반영:
    - `client_addr`는 Cloud SQL이 Unix socket으로 연결돼 항상 빈 값으로만 나와 폐기했다
      (오르테가군 실측 — 발신 IP 후보 좁히기 축으로는 쓸모없음. 실패한 축을 기록해 다음
      사람이 같은 시도를 반복하지 않게 한다).
    - 그룹별 "최대" idle 하나만으로는 "이상치 1개+정상 68개"와 "69개 전부 방치"를 구분할 수
      없다(오르테가군 지적 — 오늘 이 형태의 함정을 이미 다섯 번 밟았다) → idle 구간별
      **개수 분포**(`>1h`/`10m-1h`/`1m-10m`/`<1m`)로 바꿔 실제 분포를 본다.
    """
    verify_cron(request)
    try:
        result = await session.execute(
            text(
                """
                SELECT
                    COALESCE(application_name, '') AS application_name,
                    COALESCE(state, '') AS state,
                    COALESCE(usename, '') AS usename,
                    CASE
                        WHEN state_change IS NULL THEN 'unknown'
                        WHEN now() - state_change >= interval '1 hour' THEN '>1h'
                        WHEN now() - state_change >= interval '10 minutes' THEN '10m-1h'
                        WHEN now() - state_change >= interval '1 minute' THEN '1m-10m'
                        ELSE '<1m'
                    END AS idle_bucket,
                    count(*) AS count,
                    MAX(EXTRACT(EPOCH FROM (now() - state_change)))::int AS max_idle_seconds
                FROM pg_stat_activity
                WHERE datname = current_database()
                GROUP BY application_name, state, usename, idle_bucket
                ORDER BY count DESC
                """
            )
        )
        rows = [
            {
                "application_name": r.application_name,
                "state": r.state,
                "usename": r.usename,
                "idle_bucket": r.idle_bucket,
                "count": r.count,
                "max_idle_seconds": r.max_idle_seconds,
            }
            for r in result
        ]
        return _ok({"rows": rows, "total": sum(r["count"] for r in rows)})
    except Exception as exc:
        logger.exception("db-connection-stats cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/toss-billing-maintenance ───────────────────────
# 결제②-C3(story #2494): dunning 재시도(pricing-policy-proposal-v1 §12.1) + pending
# 대사(reconciliation). "신규 결제 주기 도래" 트리거는 스코프 밖(story #2502 대기) —
# billing_scheduler.trigger_due_charges()가 그 자리를 NotImplementedError로 명시해둔다.
@router.get("/toss-billing-maintenance")
async def toss_billing_maintenance(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.billing_scheduler import (
            sweep_dunning_retries,
            sweep_expired_grants,
            sweep_stale_pending_orders,
        )

        dunning_result = await sweep_dunning_retries(session)
        reconciliation_result = await sweep_stale_pending_orders(session)
        # story #2777 PR2 — 어드민 credit_grant의 자가회수. 신규 cron 잡 발명 대신 이
        # 기존 billing-maintenance 표면에 동거(PO 지시 2026-08-18).
        grant_sweep_result = await sweep_expired_grants(session)
        return _ok({
            "dunning": dunning_result, "reconciliation": reconciliation_result,
            "grant_sweep": grant_sweep_result,
        })
    except Exception as exc:
        logger.exception("toss-billing-maintenance cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)


# ─── GET /api/v2/internal/cron/toss-daily-reconciliation ──────────────────────
# 결제②-C4(story #2495): confirmed billing_orders가 실제로 Toss와 금액이 맞는지 재확認
# (§2 step8) — C3의 sweep_stale_pending_orders(pending 축)와 짝인 별개 축이라 별도 잡.
@router.get("/toss-daily-reconciliation")
async def toss_daily_reconciliation(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        from app.services.billing_reconciliation import daily_reconcile_confirmed_orders

        result = await daily_reconcile_confirmed_orders(session)
        return _ok(result)
    except Exception as exc:
        logger.exception("toss-daily-reconciliation cron error: %s", exc)
        return _err("INTERNAL_ERROR", "Internal server error", 500)
