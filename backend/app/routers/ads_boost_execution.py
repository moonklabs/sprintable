"""story #3806(Phase3·3-2 PR3, 페드루 PO 確定 2026-09-11) — 승인된 ads_boost 게이트
실행·중지·재개 API. `_require_human`은 PR 2 router(app/routers/ads_boost.py)와
동형(호출부마다 로컬 복제 관례) — 휴먼 전용(그라운딩 AC4). i18n_catalog 스레딩
패턴도 PR 2 router와 동형(Header() DI는 라우트 진입점에서만).

story #3806 PR4(페드루 PO 確定 2026-09-11) — 지출 요약 GET 엔드포인트도 이 파일에
동봉(같은 `/ads-boosts/{gate_id}/...` prefix 아래 자연 위치). 읽기 전용이라
insight_snapshots.py::list_publication_insights_endpoint와 동형 권한 축(휴먼·
에이전트 모두, human-only 아님 — start/pause/resume과 다른 판단, 조회는 실행이
아니다)."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.agent_onboarding_config import resolve_locale_from_request
from app.services.ads_boost_states import BOOST_RUN_STATUSES, COMMAND_FAILURE_KINDS, COMMAND_STATUSES
from app.services.ads_boost_execution import (
    AdsBoostAlreadyInStateError,
    AdsBoostGateNotApprovedError,
    AdsBoostGateNotFoundError,
    AdsBoostNotPausedError,
    AdsBoostSpendBlockedError,
    AdsBoostNotStartedError,
    request_ads_boost_pause,
    request_ads_boost_resume,
    request_ads_boost_start,
)
from app.services.ads_spend_snapshots import (
    AdsBoostGateNotFoundForSpendError,
    AdsSpendFetchError,
    AdsSpendRefreshRateLimitedError,
    get_ads_boost_spend_summary,
    refresh_ads_boost_spend_now,
)
from app.services.i18n_catalog import t
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["ads-boost-execution"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, resolved_locale: str):
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "ADS_BOOST_EXECUTE_HUMAN_ONLY",
                "message": t("ads_boost.execute_human_only", resolved_locale),
            },
        )
    return resolved


class CommandResponse(BaseModel):
    command_id: uuid.UUID
    operation: str
    toggle_seq: int
    status: str
    # story #3806(Phase3·3-2 PR 8, 페드루 PO 確定 2026-09-11) — 0367이 만든 컬럼을
    # 여기 직렬화하지 않아 "있어도 못 읽으면 안 닫힌 것"이었다(PR6 정정 배경).
    # boost_start의 human 경로(이 파일 `_start_ads_boost_endpoint`)만 채우고
    # pause/resume 커맨드는 이 축 구분이 없어(scheduler가 안 건드리는 operation)
    # null 그대로 — 지어내지 않는다.
    initiated_by: str | None


def _to_response(command) -> CommandResponse:
    return CommandResponse(
        command_id=command.id, operation=command.operation, toggle_seq=command.toggle_seq,
        status=command.status, initiated_by=command.initiated_by,
    )


def _raise_common_error(exc: Exception, resolved_locale: str) -> None:
    if isinstance(exc, AdsBoostGateNotFoundError):
        raise HTTPException(
            status_code=404,
            detail={"code": "ADS_BOOST_GATE_NOT_FOUND", "message": t("ads_boost.gate_not_found", resolved_locale)},
        ) from exc
    if isinstance(exc, AdsBoostGateNotApprovedError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ADS_BOOST_GATE_NOT_APPROVED",
                "message": t("ads_boost.gate_not_approved", resolved_locale),
            },
        ) from exc
    raise exc


@router.post("/{org_id}/ads-boosts/{gate_id}/start", response_model=CommandResponse, status_code=201)
async def start_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> CommandResponse:
    """story #3806 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다. 직접-호출
    (realdb·유닛) 테스트는 `_start_ads_boost_endpoint`를 불러야 한다."""
    return await _start_ads_boost_endpoint(
        org_id, gate_id, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _start_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, *, db: AsyncSession, verified_org_id: uuid.UUID,
    auth: AuthContext, resolved_locale: str,
) -> CommandResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)
    try:
        command = await request_ads_boost_start(
            db, org_id=org_id, gate_id=gate_id, requester_member_id=resolved.id, initiated_by="human",
        )
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError) as exc:
        _raise_common_error(exc, resolved_locale)
    return _to_response(command)


class AdoptCandidateView(BaseModel):
    id: str | None
    name: str | None
    created_time: str | None


class AdoptExistingResponse(BaseModel):
    """story #4412 — adopted (ids filled, the start queued again) · not_found · ambiguous (candidates listed, nothing adopted) ·
    budget_mismatch (the found ad set's budget is not the approved amount; nothing adopted) · already_linked (another boost
    holds that campaign; nothing adopted)."""
    result: str
    level: str | None = None
    campaign_id: str | None = None
    adset_id: str | None = None
    ad_id: str | None = None
    candidates: list[AdoptCandidateView] = []
    # budget_mismatch: the found ad set's budget vs the approved (sealed) amount, both in minor units
    adset_budget_minor: int | None = None
    sealed_budget_minor: int | None = None


@router.post("/{org_id}/ads-boosts/{gate_id}/adopt-existing", response_model=AdoptExistingResponse)
async def adopt_existing_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> AdoptExistingResponse:
    """story #4412 — «it is already in my ad account» for a boost start stopped as «outcome unknown». Human only."""
    from app.services.ads_boost_execution import (
        AdsBoostAdapterUnavailableError,
        AdsBoostAdoptNotApplicableError,
        adopt_existing_boost_objects,
    )
    from app.services.meta_ads_campaign import MetaAdsCampaignError

    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved_locale = resolve_locale_from_request(locale, accept_language)
    await _require_human(db, auth, org_id, resolved_locale)
    try:
        outcome = await adopt_existing_boost_objects(db, org_id=org_id, gate_id=gate_id)
    except AdsBoostAdoptNotApplicableError as exc:
        raise HTTPException(status_code=409, detail={"code": exc.code, "message": "Nothing to adopt for this boost."}) from exc
    except (AdsBoostAdapterUnavailableError, MetaAdsCampaignError) as exc:
        raise HTTPException(
            status_code=502, detail={"code": getattr(exc, "code", "ADS_BOOST_LOOKUP_FAILED"), "message": str(exc)[:500]},
        ) from exc
    return AdoptExistingResponse(**outcome)


@router.post("/{org_id}/ads-boosts/{gate_id}/pause", response_model=CommandResponse, status_code=201)
async def pause_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> CommandResponse:
    return await _pause_ads_boost_endpoint(
        org_id, gate_id, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _pause_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, *, db: AsyncSession, verified_org_id: uuid.UUID,
    auth: AuthContext, resolved_locale: str,
) -> CommandResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)
    try:
        command = await request_ads_boost_pause(
            db, org_id=org_id, gate_id=gate_id, requester_member_id=resolved.id,
        )
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError) as exc:
        _raise_common_error(exc, resolved_locale)
    except AdsBoostNotStartedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_NOT_STARTED", "message": t("ads_boost.not_started", resolved_locale)},
        ) from exc
    except AdsBoostAlreadyInStateError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_ALREADY_PAUSED", "message": t("ads_boost.already_paused", resolved_locale)},
        ) from exc
    return _to_response(command)


@router.post("/{org_id}/ads-boosts/{gate_id}/resume", response_model=CommandResponse, status_code=201)
async def resume_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> CommandResponse:
    return await _resume_ads_boost_endpoint(
        org_id, gate_id, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _resume_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, *, db: AsyncSession, verified_org_id: uuid.UUID,
    auth: AuthContext, resolved_locale: str,
) -> CommandResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)
    try:
        command = await request_ads_boost_resume(
            db, org_id=org_id, gate_id=gate_id, requester_member_id=resolved.id,
        )
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError) as exc:
        _raise_common_error(exc, resolved_locale)
    except AdsBoostSpendBlockedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_SPEND_UNREADABLE", "message": t("ads_boost.spend_unreadable_no_resume", resolved_locale)},
        ) from exc
    except AdsBoostNotPausedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_NOT_PAUSED", "message": t("ads_boost.not_paused", resolved_locale)},
        ) from exc
    except AdsBoostAlreadyInStateError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_ALREADY_RUNNING", "message": t("ads_boost.already_running", resolved_locale)},
        ) from exc
    return _to_response(command)


class SpendSnapshotView(BaseModel):
    due_at: str
    captured_at: str | None
    status: str
    spend_minor: int | None


# story #4447 — the boost card's value sets, published as openapi enums (the web's types are generated from the same module).
# Typed `str` with the enum in the schema, not `Literal`: a value outside the set must still read (the card shows it as unknown),
# never turn the read into a 500.
_RunStatus = Annotated[str, Field(json_schema_extra={"enum": list(BOOST_RUN_STATUSES)})]
_CommandStatus = Annotated[str, Field(json_schema_extra={"enum": list(COMMAND_STATUSES)})]
_FailureKind = Annotated[str, Field(json_schema_extra={"enum": list(COMMAND_FAILURE_KINDS)})]


class StartCommandView(BaseModel):
    """story #4409 — the boost_start command's state (dead_letter + needs_check = the person has to look)."""
    id: uuid.UUID
    status: _CommandStatus
    failure_kind: _FailureKind | None
    error_code: str | None
    # story #4447 — the server's own «can the person looking at this retry it» (`human_retryable` · people only): the card shows
    # the retry button from this value, never from its own reading of the status
    retryable: bool = False
    # the campaign name to look for in the ad account — only for ADS_BOOST_CREATE_OUTCOME_UNKNOWN
    campaign_name: str | None = None


class PauseCommandView(BaseModel):
    """story #4461 — the latest pause command (status · failure kind · reason code)."""
    status: _CommandStatus
    failure_kind: _FailureKind | None
    error_code: str | None


class PreviousCycleView(BaseModel):
    """story #4460 — a cycle that ended before the current one (a cancel): its campaign and what it spent."""

    campaign_id: str | None = None
    spend_minor: int | None = None
    currency: str | None = None
    started_at: str | None = None
    ended_at: str
    end_reason: str


class SpendSummaryResponse(BaseModel):
    gate_id: uuid.UUID
    sealed_ads_budget_minor: int
    sealed_ads_currency: str
    captured_spend_minor: int
    remaining_minor: int
    # story #3806(Phase3·3-2 PR5, 디디 3자기점검) — AdsBoostRun.status('pending'|
    # 'running'|'paused'|'failed') 실 관측값. run 행이 아직 없으면 None(gate 승인
    # 직후·실행 요청 前 — "미실행"을 지어낸 상태값으로 가리지 않는다).
    run_status: _RunStatus | None
    # story #3806(Phase3·3-2 PR 8, 페드루 PO 確定 2026-09-11) — boost_start 커맨드의
    # `initiated_by`('scheduler'|'human'). run_status와 동형 판단(디디 3자기점검
    # 정신 재사용) — 이 GET이 이미 gate_id 단건 조회 자리라 3번째 GET 신설 안 함.
    # boost_start 커맨드 자체가 없으면(gate 승인 직후·실행 前) None.
    initiated_by: str | None
    # story #3806(Phase3·3-2 PR 11, 페드루 PO 確定 2026-09-11 16:20Z) — §7 실측 열
    # 「상한 초과 0건」의 장치. 캡처 spend 합이 sealed_ads_budget_minor에 도달한
    # 시각(ads_boost_runs.cap_reached_at, 0368) — run 자체가 없거나 미도달이면
    # null(지어내지 않는다).
    cap_reached_at: str | None
    # story #4417 — the spend could not be checked against the budget: when and why (the run is paused, resume refused)
    spend_blocked_at: str | None = None
    spend_blocked_code: str | None = None
    # story #4417 — the ad account's currency read before the start (null = not read yet)
    account_currency: str | None = None
    start_command: StartCommandView | None = None
    # story #4416 — the run's campaign for the «stop in Ads Manager» link (null without a run; campaign_id also null while
    # the run has no campaign yet) and the ad channel (`conn.channel` as is: ads_sandbox · meta_ads · …).
    campaign_id: str | None = None
    ad_account_id: str | None = None
    campaign_name: str | None = None
    ad_channel: str | None = None
    # story #4458 (PO 10:56Z) — a campaign made on another budget (a re-seal during its create) is held: the card states what it
    # was created with next to the approved budget. Null without a run · a campaign made before the record existed.
    created_budget_minor: int | None = None
    # story #4461 (PO 09:00Z) — the latest pause's state: a pause that could not reach the campaign's account (its connection gone
    # · token dead) must not look like a pause — the card says so and points at Ads Manager. Null when no pause was requested.
    pause_command: PauseCommandView | None = None
    # story #4460 — a cancel asked for and not finished («취소 중») · the cycles that ended before this one (campaign · spend)
    cancel_requested: bool = False
    previous_cycles: list[PreviousCycleView] = []
    # story #4460 (Yuna 16:46Z) — the gate's status (voided = cancelled) and whether this viewer may cancel it (the requester or an
    # owner/admin, on a gate a cancel still applies to): the card shows «홍보 취소» only then; the 403 line is a fallback
    gate_status: str | None = None
    can_cancel: bool = False
    snapshots: list[SpendSnapshotView]


class CancelBoostRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class CancelBoostResponse(BaseModel):
    state: str  # "cancelling" (the campaign not known to be off yet) · "cancelled"


@router.post("/{org_id}/ads-boosts/{gate_id}/cancel", response_model=CancelBoostResponse)
async def cancel_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, body: CancelBoostRequest | None = None,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> CancelBoostResponse:
    """story #4460 — «이 홍보 취소»: the gate is voided now, the campaign paused, and the run cleared once it is known to be off."""
    from app.dependencies.ownership import _is_org_admin
    from app.services.ads_boost_cancel import (
        AdsBoostAlreadyCancelledError,
        AdsBoostCancelForbiddenError,
        AdsBoostCancelNotFoundError,
        cancel_ads_boost,
    )

    resolved_locale = resolve_locale_from_request(locale, accept_language)
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)
    try:
        result = await cancel_ads_boost(
            db, org_id=org_id, gate_id=gate_id, actor_member_id=resolved.id,
            actor_is_admin=await _is_org_admin(db, org_id, uuid.UUID(str(auth.user_id))), reason=(body.reason if body else None),
        )
    except AdsBoostCancelNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail={"code": "ADS_BOOST_GATE_NOT_FOUND", "message": t("ads_boost.gate_not_found", resolved_locale)},
        ) from exc
    except AdsBoostCancelForbiddenError as exc:
        raise HTTPException(
            status_code=403, detail={"code": "ADS_BOOST_CANCEL_FORBIDDEN", "message": t("ads_boost.cancel_forbidden", resolved_locale)},
        ) from exc
    except AdsBoostAlreadyCancelledError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "ADS_BOOST_ALREADY_CANCELLED", "message": t("ads_boost.already_cancelled", resolved_locale)},
        ) from exc
    return CancelBoostResponse(**result)


@router.get("/{org_id}/ads-boosts/{gate_id}/spend", response_model=SpendSummaryResponse)
async def get_ads_boost_spend_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> SpendSummaryResponse:
    """story #3806 PR4 — 「승인 예산 대비 지출」(paid 축만, source=="paid" 분리 표시).
    읽기 전용이라 조회 자체는 human-only가 아니다(insight_snapshots.py 동형 판단,
    이 파일 상단 모듈 docstring 참고)."""
    return await _get_ads_boost_spend_endpoint(
        org_id, gate_id, db=db, verified_org_id=verified_org_id,
        resolved_locale=resolve_locale_from_request(locale, accept_language), auth=_auth,
    )


async def _viewer_can_cancel(db: AsyncSession, auth: AuthContext | None, org_id: uuid.UUID, summary: dict) -> bool:
    """story #4460 — the same rule as the cancel itself (ads_boost_cancel.cancel_ads_boost): a person who is the requester or an
    owner/admin, on a gate a cancel still applies to (not voided · something to cancel)."""
    from app.services.gate_service import _ADS_BOOST_CANCELLABLE_STATUSES

    if auth is None or summary.get("gate_status") not in _ADS_BOOST_CANCELLABLE_STATUSES:
        return False
    if summary.get("run_status") is None and not summary.get("start_command"):
        return False  # nothing was started: a request still in review is withdrawn on the gate, not cancelled here
    try:
        member = await resolve_member(auth, org_id, db)
    except Exception:  # noqa: BLE001 — unknown viewer: no button (the server still decides on the cancel itself)
        return False
    if member.type != "human":
        return False
    from app.dependencies.ownership import _is_org_admin

    if await _is_org_admin(db, org_id, uuid.UUID(str(auth.user_id))):
        return True
    requester = summary.get("requested_by_member_id")
    return requester is not None and requester == member.id


async def _caller_is_human(db: AsyncSession, auth: AuthContext | None, org_id: uuid.UUID) -> bool:
    """story #4416 — fail-closed: an unresolvable caller counts as not human."""
    if auth is None:
        return False
    try:
        return (await resolve_member(auth, org_id, db)).type == "human"
    except Exception:  # noqa: BLE001 — any failure to resolve hides the ids, it never fails the read
        return False


async def _get_ads_boost_spend_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, *, db: AsyncSession, verified_org_id: uuid.UUID, resolved_locale: str,
    auth: AuthContext | None = None,
) -> SpendSummaryResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    try:
        summary = await get_ads_boost_spend_summary(db, org_id=org_id, gate_id=gate_id)
    except AdsBoostGateNotFoundForSpendError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "ADS_BOOST_GATE_NOT_FOUND", "message": t("ads_boost.gate_not_found", resolved_locale)},
        ) from exc
    caller_is_human = (
        await _caller_is_human(db, auth, org_id) if summary["run_status"] is not None or summary.get("start_command") else False
    )
    start = summary.get("start_command")
    return SpendSummaryResponse(
        gate_id=summary["gate_id"], sealed_ads_budget_minor=summary["sealed_ads_budget_minor"],
        sealed_ads_currency=summary["sealed_ads_currency"], captured_spend_minor=summary["captured_spend_minor"],
        remaining_minor=summary["remaining_minor"], run_status=summary["run_status"],
        initiated_by=summary["initiated_by"],
        start_command=(
            StartCommandView(**{k: v for k, v in start.items() if k != "human_retryable"}, retryable=caller_is_human and start["human_retryable"])
            if start else None
        ),
        cap_reached_at=summary["cap_reached_at"].isoformat() if summary["cap_reached_at"] else None,
        # story #4416 — the ad account id is human-only in the channel-connection list (the agent list leaves it out on
        # purpose), and this read is open to agents: the account and campaign ids (for the Ads Manager link on the human
        # screen) go to people only. The name and channel are already visible to agents (start_command · agent list).
        campaign_id=summary["campaign_id"] if caller_is_human else None,
        ad_account_id=summary["ad_account_id"] if caller_is_human else None,
        campaign_name=summary["campaign_name"], ad_channel=summary["ad_channel"],
        spend_blocked_at=summary["spend_blocked_at"].isoformat() if summary["spend_blocked_at"] else None,
        spend_blocked_code=summary["spend_blocked_code"], account_currency=summary["account_currency"],
        # story #4458 — the held campaign's created budget (the card's fact-only line)
        created_budget_minor=summary["created_budget_minor"],
        # story #4461 — the latest pause (a pause stopped on the connection is told honestly)
        pause_command=PauseCommandView(**summary["pause_command"]) if summary.get("pause_command") else None,
        cancel_requested=summary.get("cancel_requested", False),
        previous_cycles=[PreviousCycleView(**c) for c in summary.get("previous_cycles", [])],
        gate_status=summary.get("gate_status"),
        can_cancel=await _viewer_can_cancel(db, auth, org_id, summary),
        snapshots=[
            SpendSnapshotView(
                due_at=s["due_at"].isoformat(), captured_at=s["captured_at"].isoformat() if s["captured_at"] else None,
                status=s["status"], spend_minor=s["spend_minor"],
            )
            for s in summary["snapshots"]
        ],
    )


class SpendRefreshResponse(BaseModel):
    spend_minor: int
    captured_at: str
    cap_reached: bool
    run_status: str


@router.post("/{org_id}/ads-boosts/{gate_id}/spend/refresh", response_model=SpendRefreshResponse, status_code=201)
async def refresh_ads_boost_spend_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> SpendRefreshResponse:
    """story #3806(Phase3·3-2 PR 12, 페드루 PO 確定 2026-09-11 17:26Z) — 「광고비
    다시 수집」. `comments/refresh`와 동형 권한 축(휴먼 전용 — 실행류 액션이라
    start/pause/resume과 같은 판단, 조회 전용인 /spend GET과 다르다)."""
    return await _refresh_ads_boost_spend_endpoint(
        org_id, gate_id, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _refresh_ads_boost_spend_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, *, db: AsyncSession, verified_org_id: uuid.UUID,
    auth: AuthContext, resolved_locale: str,
) -> SpendRefreshResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)
    try:
        result = await refresh_ads_boost_spend_now(
            db, org_id=org_id, gate_id=gate_id, requester_member_id=resolved.id,
        )
    except AdsSpendRefreshRateLimitedError as exc:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "ADS_SPEND_REFRESH_RATE_LIMITED",
                "message": t("ads_boost.spend_refresh_rate_limited", resolved_locale, seconds=exc.retry_after_seconds),
            },
            headers={"Retry-After": str(exc.retry_after_seconds)},
        ) from exc
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError) as exc:
        _raise_common_error(exc, resolved_locale)
    except AdsSpendFetchError as exc:
        # story #3806 PR12 — 아직 provider에 실행 자체가 안 된 상태(campaign_id
        # 없음)에서 「다시 수집」을 누른 경우. pause-without-start와 같은 뜻(아직
        # 시작 안 함)이라 그 기존 카탈로그 키를 그대로 재사용(새 문구 0).
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_NOT_STARTED", "message": t("ads_boost.not_started", resolved_locale)},
        ) from exc
    return SpendRefreshResponse(
        spend_minor=result["spend_minor"], captured_at=result["captured_at"].isoformat(),
        cap_reached=result["cap_reached"], run_status=result["run_status"],
    )
