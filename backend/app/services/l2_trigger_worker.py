"""L2-S5: L2 트리거 워커 루프 (lifespan task · default-off · advisory lock).

블루프린트 §3·§5 S5. L1 활동 스트림 cursor poll(`L1ActivitySource`·S3) + 주기 데드라인 스캔으로
휴리스틱 evaluator(S4)를 구동하는 백그라운드 워커. `pg_pubsub.listen_loop`의 lifespan task 패턴을
재사용한다.

설계 원칙:
  · **default-off (AC①)** — `settings.l2_trigger_enabled`가 true일 때만 lifespan이 task를 만든다.
    꺼져 있으면 task 자체가 없어 오버헤드 0.
  · **cursor 전진은 처리 성공 후에만 (AC②)** — 배치 처리 중 예외가 나면 cursor를 올리지 않아 다음
    iteration이 같은 배치를 재처리한다(중복 발사는 S6 dedup이 흡수).
  · **advisory lock (AC③)** — `settings.l2_trigger_advisory_lock`가 켜지면 전용 커넥션에서
    `pg_try_advisory_lock` holder인 인스턴스만 poll/evaluate. 멀티인스턴스 중복 구동 방지.
  · **backoff** — iteration 실패 시 1s→30s 지수 백오프, 성공 시 리셋.
  · **graceful shutdown** — CancelledError 수신 시 advisory lock 해제·커넥션 정리 후 종료.

실 wake/dispatch(=`l2_trigger_firings` dedup + 발사 + 에이전트 wake)는 **S6**에서 `_dispatch_decisions`
seam을 채운다. S5는 결정(`TriggerDecision`)만 산출·로깅한다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import bindparam, text

from app.core.config import settings
from app.services.l1_activity_source import L1ActivitySource
from app.services.l2_heuristics import (
    DeadlineTarget,
    HeuristicEvaluator,
    HeuristicThresholds,
    TriggerDecision,
)

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class L2TriggerWorker:
    """L2 휴리스틱 트리거 워커. lifespan startup에서 `asyncio.create_task(worker.run())`."""

    WORKER_NAME = "l2_trigger"
    # 멀티인스턴스 단일 holder 보장용 advisory lock 키("L2TR" ASCII). 다른 advisory 사용처와 비충돌.
    _ADVISORY_LOCK_KEY = 0x4C325452
    # 데드라인 nudge 불필요한 hypothesis 종결 상태.
    _HYPOTHESIS_TERMINAL = ("verified", "falsified", "killed", "archived")

    def __init__(
        self,
        *,
        poll_interval_s: float = 5.0,
        deadline_scan_interval_s: float = 300.0,
        batch_limit: int = 200,
        backoff_min: float = 1.0,
        backoff_max: float = 30.0,
        thresholds: HeuristicThresholds | None = None,
        use_advisory_lock: bool | None = None,
    ) -> None:
        self.poll_interval_s = poll_interval_s
        self.deadline_scan_interval_s = deadline_scan_interval_s
        self.batch_limit = batch_limit
        self.backoff_min = backoff_min
        self.backoff_max = backoff_max
        self.source = L1ActivitySource()
        self.evaluator = HeuristicEvaluator(thresholds)
        self.use_advisory_lock = (
            settings.l2_trigger_advisory_lock if use_advisory_lock is None else use_advisory_lock
        )
        self._lock_conn = None  # 전용 AsyncConnection — advisory lock 보유 동안 유지.
        self._holds_lock = False

    # ── 메인 루프 ────────────────────────────────────────────────────────────────
    async def run(self) -> None:
        logger.info(
            "L2 trigger worker starting (advisory_lock=%s, poll=%.0fs, deadline_scan=%.0fs)",
            self.use_advisory_lock,
            self.poll_interval_s,
            self.deadline_scan_interval_s,
        )
        delay = self.backoff_min
        last_deadline_scan = 0.0
        try:
            while True:
                try:
                    if not await self._ensure_lock():
                        # standby — 다른 인스턴스가 holder. 주기적으로 재시도.
                        await asyncio.sleep(self.poll_interval_s)
                        continue

                    from app.core.database import async_session_factory

                    async with async_session_factory() as db:
                        await self._poll_once(db)
                        now_mono = time.monotonic()
                        if now_mono - last_deadline_scan >= self.deadline_scan_interval_s:
                            await self._scan_deadlines(db)
                            last_deadline_scan = now_mono

                    delay = self.backoff_min  # 성공 → backoff 리셋(AC backoff).
                    await asyncio.sleep(self.poll_interval_s)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("L2 worker iteration error: %s — backoff %.1fs", exc, delay)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, self.backoff_max)
        except asyncio.CancelledError:
            logger.info("L2 trigger worker cancelled — shutting down")
        finally:
            await self._release_lock()

    # ── advisory lock (AC③) ──────────────────────────────────────────────────────
    async def _ensure_lock(self) -> bool:
        """advisory lock 미사용 시 항상 True. 사용 시 holder만 True(전용 커넥션·AUTOCOMMIT)."""
        if not self.use_advisory_lock:
            return True
        if self._holds_lock:
            return True
        if self._lock_conn is None:
            from app.core.database import engine

            self._lock_conn = await engine.connect()
            await self._lock_conn.execution_options(isolation_level="AUTOCOMMIT")
        got = (
            await self._lock_conn.execute(
                text("SELECT pg_try_advisory_lock(:k)"), {"k": self._ADVISORY_LOCK_KEY}
            )
        ).scalar()
        self._holds_lock = bool(got)
        if self._holds_lock:
            logger.info("L2 worker acquired advisory lock")
        else:
            logger.debug("L2 worker standby — advisory lock held by another instance")
        return self._holds_lock

    async def _release_lock(self) -> None:
        if self._lock_conn is None:
            return
        try:
            if self._holds_lock:
                await self._lock_conn.execute(
                    text("SELECT pg_advisory_unlock(:k)"), {"k": self._ADVISORY_LOCK_KEY}
                )
            await self._lock_conn.close()
        except Exception as exc:  # shutdown 경로 — 실패해도 조용히 정리.
            logger.debug("L2 worker lock release error: %s", exc)
        finally:
            self._lock_conn = None
            self._holds_lock = False

    # ── cursor poll (AC②) ────────────────────────────────────────────────────────
    async def _poll_once(self, db) -> list[TriggerDecision]:
        """cursor 이후 활동을 poll·평가하고, **성공 시에만** cursor를 전진(AC②)."""
        cursor = await self._read_cursor(db)
        signals, _next = await self.source.poll_after_seq(
            db, cursor, limit=self.batch_limit, org_id=None
        )
        if not signals:
            return []
        decisions = await self._evaluate_signals(db, signals)
        self._dispatch_decisions(decisions)
        # 처리 중 예외가 났다면 여기 도달 못 함 → cursor 미전진 → 다음 iter 재처리(AC②).
        await self._write_cursor(db, signals[-1].activity_seq)
        return decisions

    async def _read_cursor(self, db) -> int:
        row = (
            await db.execute(
                text(
                    "SELECT last_activity_seq FROM l2_trigger_state "
                    "WHERE worker_name = :w AND org_id IS NOT DISTINCT FROM :org"
                ),
                {"w": self.WORKER_NAME, "org": None},
            )
        ).scalar()
        return int(row) if row is not None else 0

    async def _write_cursor(self, db, seq: int) -> None:
        # org_id NULL(global 시스템 워커) — IS NOT DISTINCT FROM으로 NULL 매칭. 행 없으면 INSERT.
        res = await db.execute(
            text(
                "UPDATE l2_trigger_state SET last_activity_seq = :seq, updated_at = now() "
                "WHERE worker_name = :w AND org_id IS NOT DISTINCT FROM :org"
            ),
            {"seq": seq, "w": self.WORKER_NAME, "org": None},
        )
        if res.rowcount == 0:
            await db.execute(
                text(
                    "INSERT INTO l2_trigger_state (worker_name, org_id, last_activity_seq, updated_at) "
                    "VALUES (:w, :org, :seq, now())"
                ),
                {"w": self.WORKER_NAME, "org": None, "seq": seq},
            )
        await db.commit()

    async def _evaluate_signals(self, db, signals) -> list[TriggerDecision]:
        """활동-구동 평가 seam. 활동별 엔티티 상태 fetch + drought/velocity 평가는 **S6**가 채운다
        (실 발사와 동일 트랜잭션이라 firing과 함께 구현). S5는 빈 결정으로 cursor 머신러리만 검증."""
        _ = (db, signals)
        return []

    # ── 주기 데드라인 스캔 (시간-구동·활동 무관) ──────────────────────────────────
    async def _scan_deadlines(self, db) -> list[TriggerDecision]:
        """measure_after가 임박한 비종결 hypothesis를 스캔해 deadline 휴리스틱을 평가.

        deadline은 활동이 발생하지 않으므로 cursor poll로는 못 잡는다 — 별도 주기 스캔.
        target은 agent-가능한 drafted_by/created_by(휴먼 owner는 wake 대상 아님). 둘 다 없으면 skip.
        Sprint.end_date·Epic.target_date 스캔은 해당 엔티티 fetch·target 해소와 함께 S6에서 확장.
        """
        now = _utcnow()
        horizon = now + timedelta(hours=self.evaluator.t.deadline_measure_after_h)
        rows = (
            await db.execute(
                text(
                    "SELECT id, measure_after, status, drafted_by_member_id, created_by_member_id "
                    "FROM hypotheses "
                    "WHERE status NOT IN :terminal AND measure_after <= :horizon"
                ).bindparams(bindparam("terminal", expanding=True)),
                {"terminal": list(self._HYPOTHESIS_TERMINAL), "horizon": horizon},
            )
        ).mappings().all()

        decisions: list[TriggerDecision] = []
        for r in rows:
            target = r["drafted_by_member_id"] or r["created_by_member_id"]
            decisions.extend(
                self.evaluator.evaluate_deadline(
                    DeadlineTarget(
                        entity_type="hypothesis",
                        entity_id=r["id"],
                        deadline=r["measure_after"],
                        status=r["status"],
                        target_agent_id=target,
                    ),
                    now,
                )
            )
        self._dispatch_decisions(decisions)
        return decisions

    # ── 발사 seam (S6에서 dedup + firing + wake 구현) ─────────────────────────────
    def _dispatch_decisions(self, decisions: list[TriggerDecision]) -> None:
        """S6 seam: `l2_trigger_firings` dedup(dedup_key) + firing insert + 에이전트 wake/dispatch.

        S5는 실 발사를 하지 않고 산출된 결정만 로깅한다.
        """
        if decisions:
            logger.info(
                "L2 worker produced %d trigger decision(s) [firing deferred to S6]: %s",
                len(decisions),
                [d.trigger_type for d in decisions],
            )
