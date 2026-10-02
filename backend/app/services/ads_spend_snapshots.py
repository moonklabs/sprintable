"""story #3806(Phase3·3-2 PR4, 페드루 PO 確定 2026-09-11) — 승인된 ads_boost의 paid
지출 수집. `insight_snapshots.py`의 +1d/+7d 스케줄링·SKIP LOCKED 배치 패턴을 그대로
재사용하되(새 기전 발명 금지) **다른 파이프라인**으로 둔다(channel_adapters.py::
"meta_ads"/"ads_sandbox" 어댑터 docstring이 PR1 시점에 이미 이렇게 明示) — 그
어댑터들은 `insight_metrics=()`(organic 콘텐츠 지표 0선언)라 `process_due_insight_
snapshots`의 「선언 0=unsupported 즉시 종결」 게이트에 걸려 거기선 절대 못 나간다.
그래서 이 파일이 같은 `InsightSnapshot` 테이블(재사용 — 새 테이블 0)을 별도
scheduling+capture 경로로 돌린다.

`InsightSnapshot.source`는 organic 행처럼 `snapshot.channel`을 그대로 옮기지 않고
**리터럴 "paid"**로 고정한다(카드 PO 確定③ "source=paid 재사용" 그대로) — 향후
Meta 외 다른 ad 채널이 추가돼도 대시보드가 채널명 나열 없이 `source=="paid"` 한
축으로 organic/paid를 가른다.

`publication_id`는 boost 대상 원 발행물(`ChannelPublication.id`, gate.scope_key가
이미 그 값 — PR2)을 그대로 재사용한다 — 같은 발행물의 organic 행과 paid 행이
`due_at`으로만 갈린다(publish 시각 anchor vs boost 시작 시각 anchor라 실사용에서
거의 항상 다르다, UNIQUE(publication_id, due_at) 충돌 사실상 0)."""
from __future__ import annotations

import importlib
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ads_boost_run import AdsBoostRun
from app.models.gate import Gate
from app.models.insight_snapshot import InsightSnapshot
from app.services.meta_ads_campaign import SPEND_CURRENCY_ERROR_CODES, MetaAdsCampaignError

logger = logging.getLogger(__name__)

_ADS_BOOST_GATE_TYPE = "ads_boost"
_PAID_CHANNELS = ("meta_ads", "ads_sandbox")
_PAID_SOURCE = "paid"
# story #3809(Phase3·3-7 PR 4a, 페드루 PO 確定 2026-09-11 21:16Z) — 원래 +1d·+7d
# 고정 2개뿐이던 스케줄(PR6, `_SNAPSHOT_OFFSETS`)이 org 비용 원장의 「paid 지출
# 시계열」 축의 재료 부족 근본원인이었다(그라운딩 확認: 매일 반복 캡처 워커
# 자체가 없어 대부분 날짜에 캡처가 없음). 처방: 최초 1건만 예약(anchor+1d)하고,
# 캡처마다 process_due_ads_spend_snapshots가 다음 캡처(그 캡처의 due_at+24h)를
# 그 자리서 스스로 이어 예약한다(끝나는 날 1회 포함·중지되면 예약 중단) — 아래
# 두 상수가 그 계약의 정본.
_INITIAL_SNAPSHOT_OFFSET = timedelta(days=1)
_RECURRING_SNAPSHOT_INTERVAL = timedelta(hours=24)
BATCH_SIZE = 50
# story #3806(Phase3·3-2 PR 12, 페드루 PO 確定 2026-09-11 17:26Z) — 댓글
# `comments/refresh`(channel_post_comments.py::_REFRESH_MIN_INTERVAL)와 동형 값·
# 동형 판정 축("가장 최근 captured_at" 기준, 별도 rate-limit 상태 테이블 0).
_SPEND_REFRESH_MIN_INTERVAL = timedelta(minutes=5)


def organic_snapshots_only(stmt):
    """story #3806(Phase3·3-2 PR4, 페드루 PO 追加 確定 2026-09-11) — paid 채널
    제외를 쓰는 **유일한** 자리. `insight_snapshots.py`의 두 소비처(캡처 루프·조회
    목록)가 각자 `.where(channel.notin_(_PAID_CHANNELS))`를 따로 적었을 때 실측
    결함(조회 목록이 그 절을 빠뜨려 paid 행이 섞여 나옴)이 실제로 났다 — 상수 하나
    공유로는 "적용을 잊는" 클래스 자체를 못 막는다(_PAID_CHANNELS는 이미 공유였다,
    깜빡한 건 «호출» 쪽). 이 술어 함수 하나로 모아 앞으로의 세 번째·네 번째
    소비처도 이 함수를 부르는 것만으로 자동으로 막히게 한다 — `.where()`를 손으로
    다시 쓰지 않는 것 자체가 강제다."""
    return stmt.where(InsightSnapshot.channel.notin_(_PAID_CHANNELS))


def paid_snapshots_only(stmt):
    """story #3806(Phase3·3-2 PR5, 조각⑥ — 성과 보드 「광고비」 분리 칸) —
    organic_snapshots_only()의 반대 방향 술어. 이 파일의 캡처 루프
    (process_due_ads_spend_snapshots)는 anchor_at으로 이미 자기 행만 건드려
    이 술어가 필요 없었지만, 조각⑥이 여러 publication_id를 한 번에 배치
    조회하면서 organic 행과 섞이지 않게 명시 필터가 필요해졌다 — 같은 실수
    (organic_snapshots_only 신설 계기)를 반대 방향으로 반복하지 않도록 이
    파일 한 곳에 짝을 둔다."""
    return stmt.where(InsightSnapshot.channel.in_(_PAID_CHANNELS))


def classify_insight_source(channel: str) -> str:
    """story #3809(Phase3·3-7, 페드루 PO 確定 2026-09-11 17:12Z) — 「응답에
    source: paid|organic 명시」의 유일한 판정 지점. `_PAID_CHANNELS` 재사용
    (새 판별식 0 — organic_snapshots_only/paid_snapshots_only와 동일 SSOT).
    기존 `InsightSnapshotView.source`(insight_snapshots.py, organic 전용
    엔드포인트에서 원채널명을 그대로 실어 `insight-snapshot-block.tsx`가
    렌더 中)와는 **다른 값·다른 소비처** — 그 필드는 안 건드린다(그라운딩
    2026-09-11 17:11Z, FE 회귀 위험 발견 후 페드루 確定으로 범위 확정)."""
    return _PAID_SOURCE if channel in _PAID_CHANNELS else "organic"


async def schedule_ads_spend_snapshots(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, publication_id: uuid.UUID,
    channel: str, anchor_at: datetime, ends_at: datetime | None = None,
) -> None:
    """boost_start 성공 직후·resume 성공 직후(같은 트랜잭션, commit은 호출자 몫 —
    insight_snapshots.py::schedule_insight_snapshots와 동형 계약) **다음 캡처
    한 건만**(anchor+24h) 연다 — 이후 매 24h 반복은 `process_due_ads_spend_
    snapshots`가 캡처마다 스스로 이어 예약한다(PR4a, 아래 함수 docstring 참고).

    story #3809(PR 4a 정정, 카디르 QA 실측 2026-09-11 21:47Z) — resume 재사용
    처방. pause로 이어 예약 체인이 소진(pending 0)된 뒤 resume해도 이 함수가
    resume 경로에서 안 불리면(원래 boost_start 1곳에서만 호출) 재예약이
    영원히 0 — 재개된 boost는 캡처도 상한 판정도 다시는 안 도는, 3806이
    처방한 것과 같은 "조용히 끊긴 사슬" 클래스. `ends_at`을 넘겼으면(resume이
    이미 종료 시점 이후 일어난 드문 경우) 지어내지 않고 스킵(0건) — boost_
    start 호출부도 극단적으로 짧은 기간(1일 미만)이면 이 경계에 걸릴 수 있어
    항상 넘겨받는다.

    `anchor_at`은 호출자가 이미 확정한 시각(boost_start의 run.started_at·
    resume의 `now`)을 그대로 넘긴다 — 재처리마다 새로 재면 UNIQUE(publication_id,
    due_at) 멱등이 무력화되는 것도 동형(insight_snapshots.py 동형 함수
    docstring 그대로)."""
    due_at = anchor_at + _INITIAL_SNAPSHOT_OFFSET
    if ends_at is not None and due_at > ends_at:
        return
    stmt = pg_insert(InsightSnapshot).values(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
        publication_kind="channel_publication", channel=channel, external_id=None, due_at=due_at,
        status="pending",
    ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at")
    await db.execute(stmt)


def _next_snapshot_due_at(*, previous_due_at: datetime, ends_at: datetime | None) -> datetime | None:
    """다음 캡처 due_at(이전 due_at+24h) — `ends_at`을 지나면(끝나는 날 자체는
    포함·그 다음날부터 제외) None(더 안 잰다). `ends_at`이 없으면(이론상 불가 —
    ads_boost 생성 시 항상 필수, 방어적으로만) 안전하게 중단."""
    if ends_at is None:
        return None
    next_due_at = previous_due_at + _RECURRING_SNAPSHOT_INTERVAL
    return next_due_at if next_due_at <= ends_at else None


class AdsSpendFetchError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


async def _resolve_spend_context(db: AsyncSession, snapshot: InsightSnapshot) -> dict:
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import decrypt_channel_credential

    gate = (await db.execute(
        select(Gate).where(
            Gate.org_id == snapshot.org_id, Gate.gate_type == _ADS_BOOST_GATE_TYPE,
            Gate.scope_key == str(snapshot.publication_id),
        )
    )).scalar_one_or_none()
    if gate is None:
        raise AdsSpendFetchError("ADS_SPEND_GATE_MISSING", f"no ads_boost gate for publication: {snapshot.publication_id}")

    run = (await db.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate.id))).scalar_one_or_none()
    if run is None or run.campaign_id is None:
        raise AdsSpendFetchError("ADS_SPEND_NOT_STARTED", f"boost not started at provider yet: {gate.id}")

    # story #4461 — the spend of the campaign is read through the account it lives in (created_connection_id), not the seal's
    from app.services.ads_boost_execution import campaign_connection_id

    connection_id = await campaign_connection_id(db, gate)
    conn = (await db.execute(
        select(ChannelConnection).where(ChannelConnection.id == connection_id)
    )).scalar_one_or_none()
    if conn is None:
        raise AdsSpendFetchError("ADS_SPEND_CONNECTION_MISSING", f"ad connection missing: {connection_id}")

    module_path = "app.services.ads_sandbox_campaign" if conn.channel == "ads_sandbox" else "app.services.meta_ads_campaign"
    module = importlib.import_module(module_path)
    return {
        "module": module, "campaign_id": run.campaign_id,
        "access_token": decrypt_channel_credential(conn.encrypted_access_token),
        # story #3806(Phase3·3-2 PR 11) — 캡처 직후 상한 판정(_enforce_spend_cap)이
        # 이미 여기서 조회한 gate·run을 그대로 재사용(추가 쿼리 0).
        "gate": gate, "run": run,
    }


async def _captured_spend_minor_for_gate(
    db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID, cycle: int | None = None,
) -> int:
    """story #3806(Phase3·3-2 PR 11) — `get_ads_boost_spend_summary`가 이미 하던
    "그 gate의 캡처된 paid spend 합" 계산을 추출(드리프트 금지 — 상한 판정
    (`_enforce_spend_cap`)과 조회 API가 같은 계산을 각자 다시 적으면 나중에
    한쪽만 고쳐질 위험)."""
    snapshots = (await db.execute(
        select(InsightSnapshot).where(
            InsightSnapshot.org_id == org_id, InsightSnapshot.publication_id == publication_id,
            InsightSnapshot.source == _PAID_SOURCE, InsightSnapshot.status == "captured",
            # story #4460 — one post can run several cycles (a cancel, then a new request): the card and the cap count the
            # current cycle's captures only (the org ledger keeps them all). By the cycle each capture was taken in (Qadir
            # 02:22Z ⓒ) — not by when it was due: a capture due in the last cycle but taken after the new start reads the new
            # campaign and belongs to the new cycle.
            *([func.coalesce(InsightSnapshot.ads_boost_cycle, 1) == cycle] if cycle is not None else []),
        )
    )).scalars().all()
    return sum((s.normalized or {}).get("spend") or 0 for s in snapshots)


async def _enforce_spend_cap(db: AsyncSession, *, gate: Gate, run, now: datetime) -> bool:
    """story #3806(Phase3·3-2 PR 11, 페드루 PO 確定 2026-09-11 16:20Z) — 「상한 내
    실행」의 실물: 캡처된 paid 지출 합이 봉인 예산에 도달/초과하면 자동으로 중지
    명령을 낸다(scheduler 귀속, PR6·PR8의 `initiated_by` 사상 재사용). `run.
    cap_reached_at`이 이미 찍혀 있으면 즉시 반환(1회만 — 매 tick 재요청 금지,
    `_request_toggle`의 더블클릭 재사용/거부 방어와는 별개의 앞단 게이트).
    반환값은 이번 호출에서 실제로 상한을 새로 판정했는지(테스트 가시성용)."""
    if run.cap_reached_at is not None:
        await _follow_through_cap(db, gate=gate, run=run, now=now)
        return False
    if gate.sealed_ads_budget_minor is None or not gate.scope_key:
        return False

    captured = await _captured_spend_minor_for_gate(
        db, org_id=gate.org_id, publication_id=uuid.UUID(gate.scope_key), cycle=run.cycle_no,
    )
    if captured < gate.sealed_ads_budget_minor:
        return False

    # 「도달했다」는 사실은 중지 명령의 성패와 무관하게 확정(먼저 커밋) — 아래
    # request_ads_boost_pause가 이미-paused 등으로 거부돼도 매 tick 재판정하지
    # 않는다(사실 관측과 그에 대한 대응 조치를 별개 실패단위로 취급).
    run.cap_reached_at = now
    await db.commit()

    await _follow_through_cap(db, gate=gate, run=run, now=now)
    return True


async def _follow_through_cap(db: AsyncSession, *, gate: Gate, run, now: datetime) -> None:
    """story #4417 (Qadir 01a0eba4 ② · 01a0ebb1 A) — the cap is reached: until the boost is really paused, a follow-up capture
    stays scheduled (the normal chain stops once `cap_reached_at` is set). Paused → nothing more. A pause in flight
    (pause_pending) → only the follow-up. Otherwise (the pause failed, or its command ended as dead_letter/failed — which now
    allows a new toggle) → ask again, then the follow-up."""
    if run.status == "paused":
        return
    if run.status != "pause_pending":
        await _pause_by_scheduler(db, gate=gate, run=run)
    await _schedule_capture(db, gate=gate, due_at=now + _BLOCK_FOLLOW_UP)


# story #4466 (PO 11:51Z · (다)) — the run state in which the campaign is spending (pause_pending = a pause already in flight)
_LIVE_RUN_STATUSES = frozenset({"running"})


async def _pause_if_off_approved(db: AsyncSession, *, gate: Gate, run) -> None:
    """story #4466 (다) — no money on values nobody approved: a live boost whose gate is no longer approved (re-request · undo ·
    then void / hold / reject) is paused by the scheduler («다시 결재 중»). Every capture checks it; leaving «approved» schedules a
    capture right away (`ads_boost_gate_exit`). Already paused or a pause in flight → nothing (no second pause)."""
    if gate.status == "approved" or not run.campaign_id:
        return
    # story #4491 (PO 06:34Z) — under a cancel, a campaign that was made and never confirmed off (run «pending» with its ids: the
    # ACTIVE answer was lost — 4460 treats it as on) is paused like a running one: a pause sent in error does no harm
    if run.status not in _LIVE_RUN_STATUSES and not (run.status == "pending" and run.cancel_requested_at is not None):
        return
    if await _pause_by_scheduler(db, gate=gate, run=run):
        logger.info("ads_boost_paused_off_approved gate_id=%s gate_status=%s", gate.id, gate.status)


async def _pause_by_scheduler(db: AsyncSession, *, gate: Gate, run) -> bool:
    """The scheduler's pause request for a boost (the cap · story #4417 an unreadable spend). Extracted from `_enforce_spend_cap`.
    story #4417 (Qadir 01a0eb71 B) — returns whether a pause is requested or already in place; False = try again later."""
    requester_id = gate.resolver_id
    if requester_id is None:
        # story #4466 (PO 11:51Z) — a gate back in review (re-request · undo) has no resolver, yet its live campaign must still be
        # paused: the pause is attributed to whoever asked for the boost's start (initiated_by=scheduler still marks it automatic).
        from app.models.publication_command import PublicationCommand
        from app.services.ads_boost_execution import OP_BOOST_START

        requester_id = (await db.execute(
            select(PublicationCommand.requested_by_member_id).where(
                PublicationCommand.gate_id == gate.id, PublicationCommand.operation == OP_BOOST_START,
            ).order_by(PublicationCommand.created_at.desc()).limit(1)
        )).scalar_one_or_none()
    if requester_id is None:
        logger.error("ads_spend_pause_no_resolver gate_id=%s", gate.id)
        return False  # PR6과 동형 방어 — 귀속 불가 상태는 이론상 불가하나 침묵 안 함.

    from app.services.ads_boost_execution import (
        AdsBoostAlreadyInStateError,
        AdsBoostGateNotApprovedError,
        AdsBoostGateNotFoundError,
        AdsBoostNotStartedError,
        request_ads_boost_pause,
    )

    gate_id = gate.id  # plain value: the rollback below expires the loaded gate
    try:
        await request_ads_boost_pause(
            db, org_id=gate.org_id, gate_id=gate.id, requester_member_id=requester_id,
            initiated_by="scheduler",
        )
        return True
    except AdsBoostAlreadyInStateError:
        return True  # a pause is already queued or done
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError, AdsBoostNotStartedError) as exc:
        # 이미 중지됐거나(사람이 먼저 pause) 게이트가 그 사이 재오픈된 경우 —
        # 「상한 도달」 관측 자체는 위에서 이미 확정됐으니 이 건은 이 워커의
        # 실패가 아니다(재-raise 안 함). 다만 story #3806(Phase3·3-2 PR 13, 페드루
        # PO 確定 2026-09-11 19:58Z) — 「조용히 지나가는 자리 0」: 이 삼킴이
        # AdsBoostNotStartedError(명령 사슬 정체성 결함, 이 PR이 근본수정)처럼
        # 실은 버그의 증거일 수도 있다 — 최소 로그는 남겨 다음 사고 때 흔적이
        # 있게 한다(재-raise는 여전히 안 함, 이 함수의 반환 계약 무변경).
        logger.warning(
            "ads_spend_cap_pause_request_skipped gate_id=%s exception=%s", gate.id, type(exc).__name__,
        )
        return False
    except Exception:  # noqa: BLE001 — publication_command.py와 동형 2중 방어.
        await db.rollback()
        logger.error("ads_spend_pause_request_failed gate_id=%s", gate_id, exc_info=True)
        # story #4272 — rollback이 run · gate를 만료시킨다. 호출부(워커 배치 · 새로고침 라우트)가 곧바로 run.status 등을 읽으니
        # 여기서 다시 읽어 둔다(안 그러면 비동기 지연 적재 MissingGreenlet).
        await db.refresh(run)
        await db.refresh(gate)
        return False


# story #4417 (Qadir 01a0eb3b ①③ · PO 03:49Z) — the cap decision never ends silently. A spend that can't be checked against the
# budget stops the boost the same way the cap does (scheduler pause), marks the run (`spend_blocked_*`, no resume while set) and
# tells the people on the boost. A read that failed is closed (failed) and tried again later; this many failures in a row stop.
SPEND_READ_FAILURES_BEFORE_STOP = 3
_SPEND_READ_RETRY_BACKOFF = (timedelta(hours=1), timedelta(hours=3))  # after the 1st · 2nd failure in a row
SPEND_READ_FAILED_REPEATEDLY_CODE = "ADS_SPEND_READ_FAILED_REPEATEDLY"
# story #4417 (Qadir 01a0eb71 A) — the boost's ad connection is gone while it runs: we can't read its spend and can't pause it at
# Meta (no token). Marked and told (the owners too) so a person stops it in Ads Manager.
SPEND_CONTEXT_LOST_CODE = "ADS_SPEND_CONTEXT_LOST"
_BLOCK_FOLLOW_UP = timedelta(hours=1)  # a failed pause/notice is tried again this much later


async def _consecutive_spend_read_failures(db: AsyncSession, *, publication_id: uuid.UUID) -> int:
    """Failed captures in a row, newest first, for this publication's paid snapshots (pending ones are not reads yet)."""
    statuses = (await db.execute(
        paid_snapshots_only(select(InsightSnapshot.status).where(
            InsightSnapshot.publication_id == publication_id, InsightSnapshot.status.in_(("captured", "failed")),
        )).order_by(InsightSnapshot.due_at.desc(), InsightSnapshot.captured_at.desc().nulls_last())
        .limit(SPEND_READ_FAILURES_BEFORE_STOP)
    )).scalars().all()
    count = 0
    for status in statuses:
        if status != "failed":
            break
        count += 1
    return count


async def _block_unreadable_spend(
    db: AsyncSession, *, gate_id: uuid.UUID, run_id: uuid.UUID, code: str, now: datetime,
) -> bool:
    """Mark the run (once), then pause and notify (`_follow_through_block`). Returns whether it was newly blocked."""
    gate = await db.get(Gate, gate_id)
    run = await db.get(AdsBoostRun, run_id)
    if gate is None or run is None:
        return False
    if run.spend_blocked_at is not None:
        await _follow_through_block(db, gate=gate, run=run, now=now)
        return False
    run.spend_blocked_at = now
    run.spend_blocked_code = code
    await db.commit()
    logger.error("ads_spend_blocked gate_id=%s run_id=%s code=%s", gate_id, run_id, code)
    await _follow_through_block(db, gate=gate, run=run, now=now)
    return True


async def _follow_through_block(db: AsyncSession, *, gate: Gate, run, now: datetime) -> None:
    """story #4417 (Qadir 01a0eb71 B) — a marked run is paused (unless we can't reach Meta: context lost) and its people told once.
    Whatever did not happen yet (the pause is not in effect · the notice failed) is tried again at a follow-up capture: the block
    never ends as a one-shot attempt."""
    code = run.spend_blocked_code
    paused = code == SPEND_CONTEXT_LOST_CODE or run.status in ("paused", "pause_pending")
    if not paused:
        await _pause_by_scheduler(db, gate=gate, run=run)
    if run.spend_blocked_notified_at is None:
        told = await _notify_spend_blocked(db, gate=gate, code=code, run_status=run.status)
        await db.refresh(run)  # a failed notice rolled back and expired the loaded rows
        await db.refresh(gate)
        if told:
            run.spend_blocked_notified_at = now
            await db.commit()
    if not paused or run.spend_blocked_notified_at is None:
        await _schedule_capture(db, gate=gate, due_at=now + _BLOCK_FOLLOW_UP)


async def _schedule_capture(db: AsyncSession, *, gate: Gate, due_at: datetime) -> None:
    """One pending paid capture for the gate's publication (idempotent per due_at)."""
    from app.models.channel_connection import ChannelConnection

    from app.services.ads_boost_execution import campaign_connection_id

    channel = (await db.execute(  # story #4461 — the campaign's account decides the channel (sandbox · meta)
        select(ChannelConnection.channel).where(ChannelConnection.id == await campaign_connection_id(db, gate))
    )).scalar_one_or_none() or "meta_ads"
    await db.execute(pg_insert(InsightSnapshot).values(
        id=uuid.uuid4(), org_id=gate.org_id, work_item_id=gate.work_item_id, publication_id=uuid.UUID(gate.scope_key),
        publication_kind="channel_publication", channel=channel, external_id=None, due_at=due_at, status="pending",
    ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at"))
    await db.commit()


async def _gate_and_run_for(db: AsyncSession, snapshot: InsightSnapshot):
    gate = (await db.execute(
        select(Gate).where(
            Gate.org_id == snapshot.org_id, Gate.gate_type == _ADS_BOOST_GATE_TYPE,
            Gate.scope_key == str(snapshot.publication_id),
        )
    )).scalar_one_or_none()
    run = (await db.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate.id))).scalar_one_or_none() if gate else None
    return gate, run


async def _notify_spend_blocked(db: AsyncSession, *, gate: Gate, code: str | None, run_status: str | None) -> bool:
    """The approver of the boost and whoever asked for its start — and, when the connection is gone (nothing we can pause), the
    org's owners/admins too. Returns whether it went out (a failed notice is tried again by `_follow_through_block`)."""
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_BOOST_START
    from app.services.gate_service import resolve_work_item_project_id
    from app.services.i18n_catalog import t
    from app.services.notification_dispatch import dispatch_notification

    gate_id = gate.id  # plain value: a rollback below expires the loaded gate
    try:
        requested_by = (await db.execute(
            select(PublicationCommand.requested_by_member_id).where(
                PublicationCommand.gate_id == gate.id, PublicationCommand.operation == OP_BOOST_START,
            ).order_by(PublicationCommand.created_at.desc()).limit(1)
        )).scalar_one_or_none()
        owners: list = []
        if code == SPEND_CONTEXT_LOST_CODE:
            from app.models.project import OrgMember

            owners = list((await db.execute(
                select(OrgMember.id).where(
                    OrgMember.org_id == gate.org_id, OrgMember.role.in_(("owner", "admin")), OrgMember.deleted_at.is_(None),
                )
            )).scalars().all())
        targets = [m for m in dict.fromkeys((gate.resolver_id, requested_by, *owners)) if m is not None]
        if not targets:
            logger.error("ads_spend_blocked_no_recipient gate_id=%s", gate.id)
            return False
        # story #4417 (Yuna 5884175792) — say only what is true about the money: connection lost = not paused, the person
        # pauses it · paused = no more spend · a pause requested but not in effect yet = pausing
        if code == SPEND_CONTEXT_LOST_CODE:
            title_key, body_key = "ads_boost.spend_context_lost_title", "ads_boost.spend_context_lost_body"
        elif run_status == "paused":
            title_key, body_key = "ads_boost.spend_unreadable_title", "ads_boost.spend_unreadable_body"
        else:
            title_key, body_key = "ads_boost.spend_unreadable_pausing_title", "ads_boost.spend_unreadable_pausing_body"
        created = await dispatch_notification(
            db, org_id=gate.org_id, event_type="ads_boost_spend_unreadable", target_member_ids=targets,
            title=t(title_key, "ko"), body=t(body_key, "ko"),
            reference_type="gate", reference_id=gate.id,
            source_project_id=await resolve_work_item_project_id(db, gate.org_id, gate.work_item_type, gate.work_item_id),
            via_outbox=True,
        )
        await db.commit()
        if not created:
            # story #4417 (Qadir 01a0eba4 ③) — the dispatch returns normally when nobody got anything (settings off for all ·
            # its own error swallowed): not «notified»; the next follow-up tries again
            logger.error("ads_spend_blocked_notice_created_none gate_id=%s targets=%s", gate_id, len(targets))
            return False
        return True
    except Exception:  # noqa: BLE001 — the stop stands; the notice is tried again, never silent
        await db.rollback()
        logger.error("ads_spend_blocked_notify_failed gate_id=%s", gate_id, exc_info=True)
        return False


async def _after_failed_spend_read(
    db: AsyncSession, *, snapshot_id: uuid.UUID, ids: dict | None, code: str, now: datetime,
) -> bool:
    """A read failed: close the capture (failed, with the code), then either try again later or — after
    `SPEND_READ_FAILURES_BEFORE_STOP` in a row — stop the boost. Returns whether the boost was blocked."""
    failed = await db.get(InsightSnapshot, snapshot_id)
    if failed is not None:
        failed.error_code = code
        failed.status = "failed"
        failed.captured_at = now
        await db.commit()
    if ids is None and failed is not None:
        # story #4417 (Qadir 01a0ebb1 B) — the failure came before the capture's context was built (e.g. the credential could
        # not be decrypted · a passing DB error): find the gate and run by the publication alone (plain rows, no decryption)
        try:
            gate, run = await _gate_and_run_for(db, failed)
        except Exception:  # noqa: BLE001
            await db.rollback()
            gate = run = None
        if gate is not None and run is not None:
            ids = {"gate_id": gate.id, "run_id": run.id, "publication_id": failed.publication_id}
        else:
            # even that did not work: say why and keep trying — never end the chain quietly
            logger.error("ads_spend_capture_context_unresolved snapshot_id=%s code=%s — retrying", snapshot_id, code)
            await _reschedule_read(db, failed=failed, due_at=now + _SPEND_READ_RETRY_BACKOFF[0])
            return False
    if ids is None:
        return False  # the capture row itself is gone
    streak = await _consecutive_spend_read_failures(db, publication_id=ids["publication_id"])
    if streak >= SPEND_READ_FAILURES_BEFORE_STOP:
        return await _block_unreadable_spend(
            db, gate_id=ids["gate_id"], run_id=ids["run_id"], code=SPEND_READ_FAILED_REPEATEDLY_CODE, now=now,
        )
    run = await db.get(AdsBoostRun, ids["run_id"])
    if failed is not None and run is not None and run.status == "running" and run.spend_blocked_at is None:
        # the failure just closed is in the streak (≥ 1): 1st → 1h, 2nd → 3h
        backoff = _SPEND_READ_RETRY_BACKOFF[min(max(streak, 1), len(_SPEND_READ_RETRY_BACKOFF)) - 1]
        await _reschedule_read(db, failed=failed, due_at=now + backoff)
    return False


async def _reschedule_read(db: AsyncSession, *, failed: InsightSnapshot, due_at: datetime) -> None:
    """A new pending capture for the same publication, from the failed one's own fields (no gate or connection needed)."""
    await db.execute(pg_insert(InsightSnapshot).values(
        id=uuid.uuid4(), org_id=failed.org_id, work_item_id=failed.work_item_id, publication_id=failed.publication_id,
        publication_kind=failed.publication_kind, channel=failed.channel, external_id=None, due_at=due_at,
        status="pending",
    ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at"))
    await db.commit()


class AdsSpendRefreshRateLimitedError(Exception):
    """story #3806(Phase3·3-2 PR 12) — `CommentRefreshRateLimitedError`(channel_
    post_comments.py)와 동형. `retry_after_seconds`를 실어 호출부(라우터)가 429
    Retry-After 헤더로 그대로 옮긴다. story #3779 BE 한글 사용자 문장 가드(2026-09-11
    17:51Z CI 적발) — 그 형제 클래스는 가드 시행 前 코드라 메시지를 raw 문자열로
    생성자에 실었지만(baseline 잔존), 이 클래스는 신규라 그 패턴을 반복하지 않는다
    — 사용자 문장은 라우터가 `t("ads_boost.spend_refresh_rate_limited", ...)`로
    직접 조립한다(이 예외 자신의 `str()`은 로그용 영문 고정 문구일 뿐)."""

    def __init__(self, *, retry_after_seconds: int):
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"ads spend refresh rate limited, retry after {retry_after_seconds}s")


async def refresh_ads_boost_spend_now(
    db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID, requester_member_id: uuid.UUID,
) -> dict:
    """story #3806(Phase3·3-2 PR 12, 페드루 PO 確定 2026-09-11 17:26Z) — 사람이
    「광고비 다시 수집」을 누르면 자연 스케줄(+1d/+7d)을 기다리지 않고 같은 캡처
    →상한판정→scheduler 자동중지 경로를 즉시 1회 돈다. `comments/refresh`(휴먼
    수동 재수집)와 동형 설계: 5분 rate-limit(가장 최근 captured_at 기준, 별도
    상태 테이블 0)·멱등(그 자리서 새 스냅샷 1행을 만들어 바로 처리, 워커 tick의
    나머지 로직 재구현 0 — `_resolve_spend_context`·`_enforce_spend_cap` 그대로
    재사용). `initiated_by` 축(PublicationCommand 전용, PR6·PR8)과는 다른 축 —
    이 함수의 「누가 눌렀나」는 InsightSnapshot에 컬럼을 새로 얹지 않고 기존
    `ActivityLog`(gate 축, `GET /{gate_id}/activity`가 이미 있는 조회표면)에
    남긴다(새 컬럼·새 조회표면 0)."""
    from app.services.ads_boost_execution import _resolve_gate
    from app.services.activity_log import ActivityLogService
    from app.services.insight_snapshots import NORMALIZED_KEYS
    from app.models.channel_connection import ChannelConnection
    import httpx

    gate = await _resolve_gate(db, org_id=org_id, gate_id=gate_id)
    if not gate.scope_key:
        raise AdsSpendFetchError("ADS_SPEND_GATE_MISSING", f"gate has no scope_key: {gate.id}")
    publication_id = uuid.UUID(gate.scope_key)

    now = datetime.now(timezone.utc)
    last_captured_at = (await db.execute(
        select(InsightSnapshot.captured_at).where(
            InsightSnapshot.org_id == org_id, InsightSnapshot.publication_id == publication_id,
            InsightSnapshot.source == _PAID_SOURCE, InsightSnapshot.captured_at.isnot(None),
        ).order_by(InsightSnapshot.captured_at.desc()).limit(1)
    )).scalar_one_or_none()
    if last_captured_at is not None and now - last_captured_at < _SPEND_REFRESH_MIN_INTERVAL:
        retry_after = int((_SPEND_REFRESH_MIN_INTERVAL - (now - last_captured_at)).total_seconds())
        raise AdsSpendRefreshRateLimitedError(retry_after_seconds=max(retry_after, 1))

    # story #4461 — the spend of the campaign is read through the account it lives in (created_connection_id), not the seal's
    from app.services.ads_boost_execution import campaign_connection_id

    connection_id = await campaign_connection_id(db, gate)
    conn = (await db.execute(
        select(ChannelConnection).where(ChannelConnection.id == connection_id)
    )).scalar_one_or_none()
    if conn is None:
        raise AdsSpendFetchError("ADS_SPEND_CONNECTION_MISSING", f"ad connection missing: {connection_id}")

    snapshot = InsightSnapshot(
        id=uuid.uuid4(), org_id=org_id, work_item_id=gate.work_item_id, publication_id=publication_id,
        publication_kind="channel_publication", channel=conn.channel, due_at=now, status="pending",
    )
    db.add(snapshot)
    await db.flush()

    try:
        # 새로 만든 행을 그대로 재조회 — _resolve_spend_context가 gate·run·conn·
        # module을 스냅샷 하나로부터 다시 도출하는 그 계약을 그대로 탄다(드리프트
        # 없는 재사용, 위에서 이미 확認한 gate·conn을 또 손으로 안 옮긴다).
        ctx = await _resolve_spend_context(db, snapshot)
        blocked_ids = {"gate_id": ctx["gate"].id, "run_id": ctx["run"].id}
        async with httpx.AsyncClient(timeout=20) as client:
            spend_minor = await ctx["module"].get_campaign_spend_minor(
                client, campaign_id=ctx["campaign_id"], access_token=ctx["access_token"],
                currency=ctx["gate"].sealed_ads_currency,
            )
        snapshot.normalized = {key: (spend_minor if key == "spend" else None) for key in NORMALIZED_KEYS}
        snapshot.ads_boost_cycle = ctx["run"].cycle_no  # story #4460 — the cycle this capture was taken in
        snapshot.source = _PAID_SOURCE
        snapshot.captured_at = now
        snapshot.status = "captured"
        snapshot.error_code = None
        await db.commit()
    except MetaAdsCampaignError as exc:
        await db.rollback()
        if exc.code in SPEND_CURRENCY_ERROR_CODES:
            # story #4417 — a person's «collect again» that reads a spend in another currency stops the boost like the worker
            logger.error("ads_spend_currency_unreadable gate_id=%s code=%s (refresh)", gate_id, exc.code)
            await _block_unreadable_spend(db, gate_id=blocked_ids["gate_id"], run_id=blocked_ids["run_id"], code=exc.code, now=now)
        raise
    except Exception:
        await db.rollback()
        raise

    capped = await _enforce_spend_cap(db, gate=ctx["gate"], run=ctx["run"], now=now)

    await ActivityLogService(db).record(
        org_id=org_id, action="ads_spend_refresh_requested", actor_id=requester_member_id, actor_type="human",
        # story #4272(까디르 codex P2) — `_enforce_spend_cap`의 rollback 뒤라 로드된 gate 대신 원시 gate_id.
        entity_type="gate", entity_id=gate_id,
        context={"spend_minor": spend_minor, "cap_reached": capped},
    )
    await db.commit()

    # run.status는 여기서 아직 안 바뀐다 — _enforce_spend_cap이 하는 건 pause
    # "명령 생성"뿐(boost_start와 동형 비동기 2단계: 실행은 process_due_
    # publication_commands의 다음 tick 몫). 지어내지 않고 지금 이 순간의 실제
    # 값을 그대로 낸다.
    return {
        "spend_minor": spend_minor, "captured_at": now, "cap_reached": capped, "run_status": ctx["run"].status,
    }


async def process_due_ads_spend_snapshots(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """`insight_snapshots.py::process_due_insight_snapshots`와 동형 SKIP LOCKED
    2단계 커밋 — 단 WHERE에 `channel IN ('meta_ads','ads_sandbox')`를 명시해 그
    함수와 겹쳐 같은 행을 경합하지 않는다(그 함수 쪽도 이 두 채널을 제외하도록
    같이 고쳤다 — insight_snapshots.py::process_due_insight_snapshots 참고,
    안 그러면 두 워커 tick이 같은 pending 행을 서로 다르게 처리하려는 경합이
    생긴다)."""
    import httpx

    now = now or datetime.now(timezone.utc)
    rows = (await db.execute(
        select(InsightSnapshot).where(
            InsightSnapshot.status == "pending", InsightSnapshot.due_at <= now,
            InsightSnapshot.channel.in_(_PAID_CHANNELS),
        ).order_by(InsightSnapshot.due_at.asc())
        .limit(BATCH_SIZE)
        .with_for_update(skip_locked=True)
    )).scalars().all()

    for snapshot in rows:
        snapshot.status = "in_progress"
    await db.commit()

    counts = {"captured": 0, "failed": 0, "error": 0, "capped": 0}
    # story #4272 — rollback이 미리 읽은 행을 전부 만료시켜 뒤 건이 전부 MissingGreenlet으로 error가 되던 부류.
    # 원시 id만 들고 돌며 건마다 다시 읽는다(publication_command.py 배치 루프와 같은 처방).
    snapshot_ids = [snapshot.id for snapshot in rows]
    for snapshot_id in snapshot_ids:
        ids: dict | None = None  # story #4417 — plain ids: a rollback expires the loaded gate/run
        try:
            snapshot = await db.get(InsightSnapshot, snapshot_id)
            if snapshot is None:
                continue
            ctx = await _resolve_spend_context(db, snapshot)
            ids = {"gate_id": ctx["gate"].id, "run_id": ctx["run"].id, "publication_id": snapshot.publication_id}
            await _pause_if_off_approved(db, gate=ctx["gate"], run=ctx["run"])
            if ctx["run"].spend_blocked_at is not None:
                # story #4417 (Qadir 01a0eb71 B) — a follow-up capture of a blocked boost: no spend read (it can't be checked
                # against the budget), only what the block still owes — the pause and the notice.
                snapshot.status = "failed"
                snapshot.error_code = "ADS_SPEND_BLOCKED"
                snapshot.captured_at = now
                await db.commit()
                await _follow_through_block(db, gate=ctx["gate"], run=ctx["run"], now=now)
                counts["failed"] += 1
                continue
            from app.services.external_call_tx import end_transaction_before_external_call

            await end_transaction_before_external_call(db)  # story #4404 — the worker loop; reads only before the call
            async with httpx.AsyncClient(timeout=20) as client:
                spend_minor = await ctx["module"].get_campaign_spend_minor(
                    client, campaign_id=ctx["campaign_id"], access_token=ctx["access_token"],
                    currency=ctx["gate"].sealed_ads_currency,
                )
            from app.services.insight_snapshots import NORMALIZED_KEYS

            # NORMALIZED_KEYS를 그대로 재사용(드리프트 금지) — spend만 채우고
            # 나머지 전부 None(insight_snapshots.py::_normalize와 같은 계약: paid
            # 어댑터는 spend 외 organic 지표를 아예 선언 안 하므로 "미선언"과 같은
            # null, 지어내지 않는다).
            snapshot.normalized = {key: (spend_minor if key == "spend" else None) for key in NORMALIZED_KEYS}
            snapshot.ads_boost_cycle = ctx["run"].cycle_no  # story #4460 — the cycle this capture was taken in
            snapshot.source = _PAID_SOURCE
            snapshot.captured_at = now
            snapshot.status = "captured"
            snapshot.error_code = None
            await db.commit()
            counts["captured"] += 1
            # story #3806(Phase3·3-2 PR 11) — 이 캡처가 상한을 새로 넘겼는지 즉시
            # 판정(같은 tick 안, 다음 tick까지 안 미룬다 — 「상한 내 실행」은 발견
            # 즉시 멈추는 것이 취지).
            if await _enforce_spend_cap(db, gate=ctx["gate"], run=ctx["run"], now=now):
                counts["capped"] += 1

            # story #3809(Phase3·3-7 PR 4a, 페드루 PO 確定 2026-09-11 21:16Z) —
            # 캡처마다 다음 캡처를 그 자리서 이어 예약(멱등 upsert, PR6 스케줄링
            # 관례 그대로). run.status!="running"(사람이 먼저 pause) 또는
            # cap_reached_at이 방금(또는 이전에) 찍혔으면(위 _enforce_spend_cap이
            # 같은 run 객체를 그 자리서 mutate) 더 안 잇는다 — 어차피 곧 멈출
            # boost를 위해 미래 캡처를 예약하는 건 낭비다.
            if ctx["run"].status == "running" and ctx["run"].cap_reached_at is None:
                next_due_at = _next_snapshot_due_at(
                    previous_due_at=snapshot.due_at, ends_at=ctx["gate"].sealed_ads_ends_at,
                )
                if next_due_at is not None:
                    stmt = pg_insert(InsightSnapshot).values(
                        id=uuid.uuid4(), org_id=snapshot.org_id, work_item_id=snapshot.work_item_id,
                        publication_id=snapshot.publication_id, publication_kind=snapshot.publication_kind,
                        channel=snapshot.channel, external_id=None, due_at=next_due_at, status="pending",
                    ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at")
                    await db.execute(stmt)
                    await db.commit()
        except AdsSpendFetchError as exc:
            snapshot.error_code = exc.code
            snapshot.status = "failed"
            snapshot.captured_at = now
            await db.commit()
            counts["failed"] += 1
            # story #4417 (Qadir 01a0eb71 A) — no fetch-error branch ends silently:
            gate, run = await _gate_and_run_for(db, snapshot)
            if exc.code == "ADS_SPEND_NOT_STARTED" and gate is not None:
                # the campaign isn't there yet: a normal wait — look again later (until the sealed period is over)
                if gate.sealed_ads_ends_at is None or now < gate.sealed_ads_ends_at:
                    await _schedule_capture(db, gate=gate, due_at=now + _SPEND_READ_RETRY_BACKOFF[0])
            elif exc.code == "ADS_SPEND_CONNECTION_MISSING" and gate is not None and run is not None:
                # the ad connection is gone while the boost may be running: mark it and tell people to stop it in Ads Manager
                await _block_unreadable_spend(db, gate_id=gate.id, run_id=run.id, code=SPEND_CONTEXT_LOST_CODE, now=now)
            else:
                # ADS_SPEND_GATE_MISSING: no boost left to pause or show (the gate behind this capture is gone) — logged
                logger.error("ads_spend_capture_orphan snapshot_id=%s code=%s", snapshot_id, exc.code)
        except MetaAdsCampaignError as exc:
            await db.rollback()
            if exc.code in SPEND_CURRENCY_ERROR_CODES and ids is not None:
                # story #4417 — the spend is in a currency we can't convert (not the sealed one, or not in the table): it can't
                # be checked against the budget and a retry would read the same — the capture fails and the boost stops.
                logger.error(
                    "ads_spend_currency_unreadable snapshot_id=%s code=%s message=%s", snapshot_id, exc.code, exc.message,
                )
                failed = await db.get(InsightSnapshot, snapshot_id)
                if failed is not None:
                    failed.error_code = exc.code
                    failed.status = "failed"
                    failed.captured_at = now
                    await db.commit()
                await _block_unreadable_spend(db, gate_id=ids["gate_id"], run_id=ids["run_id"], code=exc.code, now=now)
                counts["failed"] += 1
                continue
            logger.error("ads_spend_read_failed snapshot_id=%s code=%s message=%s", snapshot_id, exc.code, exc.message)
            await _after_failed_spend_read(db, snapshot_id=snapshot_id, ids=ids, code=exc.code, now=now)
            counts["failed"] += 1
        except Exception as exc:  # noqa: BLE001 — publication_command.py와 동형 2중 방어.
            await db.rollback()
            # story #4417 — before: the capture stayed in_progress and nothing was scheduled again (the cap was never checked
            # for this boost again). Now it is closed and retried like a failed read.
            logger.error("ads_spend_capture_error snapshot_id=%s", snapshot_id, exc_info=True)
            try:
                await _after_failed_spend_read(
                    db, snapshot_id=snapshot_id, ids=ids, code=getattr(exc, "code", None) or "ADS_SPEND_CAPTURE_ERROR", now=now,
                )
            except Exception:  # noqa: BLE001
                await db.rollback()
                logger.error("ads_spend_capture_error_followup_failed snapshot_id=%s", snapshot_id, exc_info=True)
            counts["error"] += 1
    return counts


class AdsBoostGateNotFoundForSpendError(Exception):
    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"ads_boost gate not found: {gate_id}")


async def _cancel_pause_retry_state(db: AsyncSession, *, run) -> str | None:
    from app.services.ads_boost_cancel import cancel_pause_retry_state

    return await cancel_pause_retry_state(db, run=run)


async def get_ads_boost_spend_summary(db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID) -> dict:
    """story #3806(Phase3·3-2 PR4) — 「승인 예산 대비 지출」. 승인 게이트가 봉인한
    예산(`gate.sealed_ads_budget_minor`, 불변)과 이 gate의 발행물에 걸린 `source==
    "paid"` 행 중 `status="captured"` 스냅샷의 `normalized.spend` 합을 대조한다.
    `remaining_minor`는 음수를 0으로 바닥 처리하지 않는다 — 실제로 봉인 예산을
    넘겨 지출됐다면(Meta 쪽 집행 지연·초과 가능성, 이 레포가 막는 건 "요청 시점
    증액"뿐이지 "이미 집행된 뒤 provider 측 실제 지출"까지 봉인이 통제하진 못한다)
    그 사실을 화면이 그대로 봐야 한다 — 지어낸 하한으로 가리지 않는다."""
    gate = (await db.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id, Gate.gate_type == _ADS_BOOST_GATE_TYPE)
    )).scalar_one_or_none()
    if gate is None:
        raise AdsBoostGateNotFoundForSpendError(gate_id)

    snapshots = (await db.execute(
        select(InsightSnapshot).where(
            InsightSnapshot.org_id == org_id, InsightSnapshot.publication_id == uuid.UUID(gate.scope_key),
            InsightSnapshot.source == _PAID_SOURCE,
        ).order_by(InsightSnapshot.due_at.asc())
    )).scalars().all()

    # story #3806(Phase3·3-2 PR5, 디디 3자기점검 — 페드루 지적 없이 자체 발견) — pause/
    # resume UI가 「실행 중/중지됨」을 그리려면 AdsBoostRun.status(PR3 워커 fix가 만든
    # 「Meta 쪽 지금 상태」 최종 관측값, ads_boost_run.py 모델 docstring)가 필요한데,
    # 지금 어떤 라우터도 이 값을 클라이언트에 노출하지 않는다(grep 0건) — /spend가
    # 이미 per-gate-id 조회 자리라 그 한 번의 왕복에 얹는다(2번째 GET 신설 안 함).
    # run이 아직 없으면(gate 승인 직후·실행 요청 前) None — "미실행"과 "pending"을
    # 뭉개지 않는다(지어내지 않는다).
    run = (await db.execute(
        select(AdsBoostRun).where(AdsBoostRun.org_id == org_id, AdsBoostRun.gate_id == gate_id)
    )).scalar_one_or_none()

    # story #3806(Phase3·3-2 PR 8, 페드루 PO 確定 2026-09-11) — 「있어도 못 읽으면 안
    # 닫힌 것」 처방. boost_start는 그 승인주기당 toggle_seq=0 고정 1행(이 파일 상단
    # 참조 모듈 docstring)이라 gate_id+operation만으로 단건 확정 — run_status와
    # 동형으로 이 GET에 얹는다(2개 모듈 순환import 회피를 위해 지연 import,
    # ads_boost_execution.py도 이 파일을 함수 내부에서만 부르는 동형 관례).
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import (
        ADS_BOOST_CREATE_OUTCOME_UNKNOWN_CODE,
        OP_BOOST_START,
        expected_campaign_name,
    )
    from app.services.publication_command import human_retryable

    # story #4409 — the newest start command: a re-approval gives the same gate a second boost_start (commands are unique per
    # approved version), where scalar_one_or_none() raised MultipleResultsFound.
    # story #4447 — a voided start (its approval was replaced) is not «the» start: the screen draws from the valid approval.
    # Qadir 4870 (06:47Z) ② — nor is a start of an earlier seal: a re-seal voids only the *pending* commands, so an old start that
    # had already stopped (dead_letter · blocked) stayed «the» start and the card never offered «홍보 시작» for the new approval.
    # Only the start of the gate's current seal (every re-seal issues a new sealed_ads_boost_version_id = the command's version).
    boost_start_command = (await db.execute(
        select(PublicationCommand).where(
            PublicationCommand.org_id == org_id, PublicationCommand.gate_id == gate_id,
            PublicationCommand.operation == OP_BOOST_START, PublicationCommand.status != "voided",
            PublicationCommand.approved_version == gate.sealed_ads_boost_version_id,
        ).order_by(PublicationCommand.created_at.desc(), PublicationCommand.id.desc()).limit(1)
    )).scalar_one_or_none()

    # story #3806(Phase3·3-2 PR 11) — _enforce_spend_cap과 같은 계산(드리프트 금지,
    # 이 파일 상단 `_captured_spend_minor_for_gate` docstring 참고). 위에서 이미
    # 가져온 `snapshots`로 직접 합해도 값은 같지만, 두 소비처가 각자 다시 적으면
    # 나중에 한쪽만 고쳐질 위험을 없애기 위해 공유 함수를 그대로 부른다.
    captured_spend_minor = await _captured_spend_minor_for_gate(
        db, org_id=org_id, publication_id=uuid.UUID(gate.scope_key), cycle=run.cycle_no if run is not None else None,
    )
    # story #4460 — the cycles that ended before this one (a cancel): their campaign and what they spent stay on the card
    from app.models.ads_boost_run import AdsBoostRunCycle

    previous_cycles = [
        {"campaign_id": c.campaign_id, "spend_minor": c.spend_minor, "currency": c.currency,
         "started_at": c.started_at.isoformat() if c.started_at else None, "ended_at": c.ended_at.isoformat(),
         "end_reason": c.end_reason}
        for c in (await db.execute(
            select(AdsBoostRunCycle).where(AdsBoostRunCycle.gate_id == gate.id, AdsBoostRunCycle.org_id == org_id)
            .order_by(AdsBoostRunCycle.ended_at)
        )).scalars().all()
    ]
    # story #4416 — what the card needs to point at the running campaign when a pause has not landed yet (money may still be
    # going out): the campaign, its ad account (numeric, no `act_`) and name, and the ad channel (`conn.channel` as is — the
    # screen decides which notice fits; an unknown value falls back to the money line only). All null without a run;
    # `campaign_id` also null while the run has no campaign yet. Org-scoped like the rest of this read; no secrets.
    run_ad = {"campaign_id": None, "ad_account_id": None, "campaign_name": None, "ad_channel": None}
    if run is not None:
        from app.models.channel_connection import ChannelConnection

        from app.services.ads_boost_execution import campaign_connection_id

        ad_connection_id = await campaign_connection_id(db, gate)  # story #4461 — the card links the campaign's own account
        ad_conn = (await db.execute(
            select(ChannelConnection).where(
                ChannelConnection.id == ad_connection_id, ChannelConnection.org_id == org_id,
            )
        )).scalar_one_or_none() if ad_connection_id is not None else None
        run_ad = {
            "campaign_id": run.campaign_id or None,
            "ad_account_id": ((ad_conn.account_id or "").removeprefix("act_") or None) if ad_conn is not None else None,
            "campaign_name": await expected_campaign_name(db, gate),
            "ad_channel": ad_conn.channel if ad_conn is not None else None,
        }
    # story #4461 — the latest pause (any seal: a pause is never refused for its seal) — the card tells a stopped one honestly
    # story #4460 — of this cycle: a cancelled cycle's pause (completed · stopped on the connection) is not the new campaign's
    from app.services.ads_boost_execution import OP_PAUSE, in_ads_boost_cycle

    latest_pause = (await db.execute(
        select(PublicationCommand).where(
            PublicationCommand.org_id == org_id, PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE,
            in_ads_boost_cycle(run.cycle_no if run is not None else 1),
        ).order_by(PublicationCommand.created_at.desc(), PublicationCommand.id.desc()).limit(1)
    )).scalar_one_or_none()
    return {
        **run_ad,
        "pause_command": (
            {"status": latest_pause.status, "failure_kind": latest_pause.failure_kind, "error_code": latest_pause.reason_code}
            if latest_pause is not None else None
        ),
        "created_budget_minor": run.created_budget_minor if run is not None else None,
        "cancel_requested": run is not None and run.cancel_requested_at is not None,  # story #4460 — «취소 중»
        # story #4491 — under «취소 중», the cycle's pause failed at the provider: retried automatically or not any more
        "pause_retry": await _cancel_pause_retry_state(db, run=run),
        "gate_status": gate.status,  # story #4460 — the card says «취소됨» without the page reloading the gate
        "requested_by_member_id": gate.requested_by_member_id,
        "previous_cycles": previous_cycles,
        "gate_id": gate.id,
        "initiated_by": boost_start_command.initiated_by if boost_start_command is not None else None,
        "sealed_ads_budget_minor": gate.sealed_ads_budget_minor,
        "sealed_ads_currency": gate.sealed_ads_currency,
        "captured_spend_minor": captured_spend_minor,
        "remaining_minor": (gate.sealed_ads_budget_minor or 0) - captured_spend_minor,
        "run_status": run.status if run is not None else None,
        # story #4409 — the start command's own state: a needs_check stop used to be invisible (the run stays «pending»,
        # so the screen looked «not started» while the command sat in dead_letter for good).
        "start_command": (
            {
                "id": boost_start_command.id, "status": boost_start_command.status,
                "failure_kind": boost_start_command.failure_kind, "error_code": boost_start_command.reason_code,
                # story #4447 — whether a person may retry it (the endpoint's own rule); the router keeps it for people only
                "human_retryable": human_retryable(boost_start_command),
                # the campaign the person has to look for — only when the outcome is unknown
                "campaign_name": (
                    await expected_campaign_name(db, gate)
                    if boost_start_command.reason_code == ADS_BOOST_CREATE_OUTCOME_UNKNOWN_CODE else None
                ),
            }
            if boost_start_command is not None else None
        ),
        # story #3806(Phase3·3-2 PR 11, §7 실측 열 「상한 초과 0건」의 장치) — run이
        # 없으면(미실행) 당연히 null, run은 있는데 아직 미도달이어도 null(지어내지
        # 않는다) — 도달한 시각이 찍혀야만 값이 있다.
        "cap_reached_at": run.cap_reached_at if run is not None else None,
        # story #4417 — the spend could not be checked against the budget (the run was paused and can't be resumed) · the ad
        # account's currency as read before the start (the Ads Manager link comes from 4416's human-only ids)
        "spend_blocked_at": run.spend_blocked_at if run is not None else None,
        "spend_blocked_code": run.spend_blocked_code if run is not None else None,
        "account_currency": run.account_currency if run is not None else None,
        "snapshots": [
            {
                "due_at": s.due_at, "captured_at": s.captured_at, "status": s.status,
                "spend_minor": (s.normalized or {}).get("spend") if s.status == "captured" else None,
            }
            for s in snapshots
        ],
    }
