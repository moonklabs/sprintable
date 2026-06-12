"""L2-S5/S6: L2 트리거 워커 루프 (lifespan · default-off · advisory lock · dedup 발사).

블루프린트 §3·§5/§6. L1 활동 스트림 cursor poll(`L1ActivitySource`·S3) + 주기 데드라인 스캔으로
휴리스틱 evaluator(S4)를 구동하는 백그라운드 워커. `pg_pubsub.listen_loop`의 lifespan task 패턴을
재사용한다.

S6: 각 트리거 결정을 `l2_trigger_firings`에 dedup insert(ON CONFLICT (dedup_key) DO NOTHING
RETURNING)하고, **insert 승자만** dispatch service(S1·`dispatch_entity_to_assignee`)를 호출해
Event(dispatched)+wake한다 — 멀티인스턴스/재처리에도 정확히 1 wake.

설계 원칙:
  · **default-off (AC①)** — `settings.l2_trigger_enabled`가 true일 때만 lifespan이 task를 만든다.
    꺼져 있으면 task 자체가 없어 오버헤드 0.
  · **cursor 전진은 처리 성공 후에만 (AC②)** — 배치 처리 중 예외가 나면 cursor를 올리지 않아 다음
    iteration이 같은 배치를 재처리한다(중복 발사는 S6 dedup이 흡수).
  · **advisory lock (AC③)** — `settings.l2_trigger_advisory_lock`가 켜지면 전용 커넥션에서
    `pg_try_advisory_lock` holder인 인스턴스만 poll/evaluate. 멀티인스턴스 중복 구동 방지.
  · **backoff** — iteration 실패 시 1s→30s 지수 백오프, 성공 시 리셋.
  · **graceful shutdown** — CancelledError 수신 시 advisory lock 해제·커넥션 정리 후 종료.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, time as dt_time, timedelta, timezone

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

# dispatch service(S1)가 처리 가능한 anchor entity. 이 외(sprint/hypothesis 등)는 firing만 기록하고
# wake는 skip한다(해당 타입 dispatch 경로는 후속 확장).
_DISPATCHABLE_ANCHORS = frozenset({"epic", "story", "doc"})

# Phase 1 활동-구동 트리거 대상 verb(status_changed→담당자 wake). 확장 시 여기에 추가.
_ACTIVITY_TRIGGER_VERBS = frozenset({"status_changed"})


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class L2TriggerWorker:
    """L2 휴리스틱 트리거 워커. lifespan startup에서 `asyncio.create_task(worker.run())`."""

    WORKER_NAME = "l2_trigger"
    # 멀티인스턴스 단일 holder 보장용 advisory lock 키("L2TR" ASCII). 다른 advisory 사용처와 비충돌.
    _ADVISORY_LOCK_KEY = 0x4C325452
    # 데드라인 nudge 불필요한 종결 상태(타입별).
    _HYPOTHESIS_TERMINAL = ("verified", "falsified", "killed", "archived")
    _EPIC_TERMINAL = ("completed", "done", "closed", "archived", "cancelled", "canceled")

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
    async def _poll_once(self, db) -> list:
        """cursor 이후 활동을 poll·평가·발사하고, **성공 시에만** cursor를 전진(AC②)."""
        cursor = await self._read_cursor(db)
        signals, _next = await self.source.poll_after_seq(
            db, cursor, limit=self.batch_limit, org_id=None
        )
        if not signals:
            return []
        firings = await self._evaluate_signals(db, signals)
        await self._dispatch_decisions(db, firings)
        # 처리 중 예외가 났다면 여기 도달 못 함 → cursor 미전진 → 다음 iter 재처리(AC②).
        await self._write_cursor(db, signals[-1].activity_seq)
        return firings

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

    async def _evaluate_signals(self, db, signals) -> list[tuple[TriggerDecision, uuid.UUID]]:
        """활동-구동 평가 → (decision, org_id) 페어 리스트.

        Phase 1 활동 트리거: dispatchable 엔티티(epic/story/doc)의 `status_changed` 활동은 해당
        엔티티 assignee를 wake한다(dispatch service가 동일 assignee를 재해소). dedup_key가
        source_activity_seq를 포함하므로 같은 활동 재처리는 추가 wake 0(S6 dedup).
        """
        out: list[tuple[TriggerDecision, uuid.UUID]] = []
        for s in signals:
            if s.verb not in _ACTIVITY_TRIGGER_VERBS:
                continue
            if s.object_type not in _DISPATCHABLE_ANCHORS or s.object_id is None:
                continue
            from app.services.agent_dispatch import _fetch_entity

            assignee_id, _title, _desc, _proj = await _fetch_entity(
                db, s.object_type, s.object_id, s.org_id
            )
            if not assignee_id:
                continue  # 담당자 없으면 wake 대상 없음.
            new_status = (s.payload or {}).get("to") or (s.payload or {}).get("status")
            reason = f"{s.object_type} 상태 변경" + (f" → {new_status}" if new_status else "")
            out.append(
                (
                    TriggerDecision(
                        trigger_type="status_changed",
                        target_agent_id=assignee_id,
                        anchor_type=s.object_type,
                        anchor_id=s.object_id,
                        reason=reason,
                        source_activity_seq=s.activity_seq,
                    ),
                    s.org_id,
                )
            )
        return out

    # ── 주기 데드라인 스캔 (시간-구동·활동 무관) ──────────────────────────────────
    async def _scan_deadlines(self, db) -> list:
        """마감 임박 엔티티를 스캔해 deadline 휴리스틱을 평가·발사. → (decision, org_id) 페어.

        deadline은 활동이 발생하지 않으므로 cursor poll로는 못 잡는다 — 별도 주기 스캔.
        · Epic.target_date — assignee_id를 target으로 dispatch service가 wake(dispatchable).
        · Hypothesis.measure_after — drafted_by/created_by(agent-가능)를 target으로 firing 기록
          (현 dispatch 서비스는 hypothesis 미지원이라 wake는 skip·후속 확장).
        Sprint.end_date 스캔은 sprint dispatch 경로 확정과 함께 후속 확장.
        """
        now = _utcnow()
        firings = await self._collect_epic_deadlines(db, now)
        firings += await self._collect_hypothesis_deadlines(db, now)
        await self._dispatch_decisions(db, firings)
        return firings

    async def _collect_epic_deadlines(self, db, now) -> list[tuple[TriggerDecision, uuid.UUID]]:
        horizon_date = (now + timedelta(hours=self.evaluator.t.deadline_epic_target_h)).date()
        rows = (
            await db.execute(
                text(
                    "SELECT id, org_id, target_date, status, assignee_id FROM epics "
                    "WHERE assignee_id IS NOT NULL AND target_date IS NOT NULL "
                    "AND status NOT IN :terminal AND target_date <= :horizon"
                ).bindparams(bindparam("terminal", expanding=True)),
                {"terminal": list(self._EPIC_TERMINAL), "horizon": horizon_date},
            )
        ).mappings().all()
        out: list[tuple[TriggerDecision, uuid.UUID]] = []
        for r in rows:
            # target_date는 DATE — 마감일 23:59:59Z를 deadline으로(당일 내 임박 판정).
            deadline = datetime.combine(r["target_date"], dt_time(23, 59, 59), tzinfo=timezone.utc)
            for d in self.evaluator.evaluate_deadline(
                DeadlineTarget(
                    entity_type="epic",
                    entity_id=r["id"],
                    deadline=deadline,
                    status=r["status"],
                    target_agent_id=r["assignee_id"],
                ),
                now,
            ):
                out.append((d, r["org_id"]))
        return out

    async def _collect_hypothesis_deadlines(self, db, now) -> list[tuple[TriggerDecision, uuid.UUID]]:
        horizon = now + timedelta(hours=self.evaluator.t.deadline_measure_after_h)
        rows = (
            await db.execute(
                text(
                    "SELECT id, org_id, measure_after, status, drafted_by_member_id, "
                    "created_by_member_id FROM hypotheses "
                    "WHERE status NOT IN :terminal AND measure_after <= :horizon"
                ).bindparams(bindparam("terminal", expanding=True)),
                {"terminal": list(self._HYPOTHESIS_TERMINAL), "horizon": horizon},
            )
        ).mappings().all()
        out: list[tuple[TriggerDecision, uuid.UUID]] = []
        for r in rows:
            target = r["drafted_by_member_id"] or r["created_by_member_id"]
            for d in self.evaluator.evaluate_deadline(
                DeadlineTarget(
                    entity_type="hypothesis",
                    entity_id=r["id"],
                    deadline=r["measure_after"],
                    status=r["status"],
                    target_agent_id=target,
                ),
                now,
            ):
                out.append((d, r["org_id"]))
        return out

    # ── dedup 발사 (S6: 정확히 1 wake·멀티인스턴스 안전) ──────────────────────────
    @staticmethod
    def _dedup_key(d: TriggerDecision) -> str:
        """발사 dedup 키. 활동-구동은 활동당 1회, 시간-구동(deadline 등)은 UTC 일자당 1회."""
        if d.source_activity_seq is not None:
            bucket = f"a{d.source_activity_seq}"
        else:
            bucket = _utcnow().strftime("%Y%m%d")
        return f"{d.trigger_type}:{d.anchor_type}:{d.anchor_id}:{d.target_agent_id}:{bucket}"

    async def _dispatch_decisions(self, db, firings: list) -> None:
        """각 (decision, org_id)에 대해 dedup insert 승자만 실 dispatch(AC①②④).

        한 결정의 실패가 배치 전체를 막지 않도록 결정 단위 격리(실패 시 rollback 후 계속).
        """
        for decision, org_id in firings:
            try:
                await self._fire_one(db, decision, org_id)
            except Exception as exc:
                await db.rollback()
                logger.warning(
                    "L2 fire failed (%s anchor=%s): %s", decision.trigger_type, decision.anchor_id, exc
                )

    async def _fire_one(self, db, decision: TriggerDecision, org_id: uuid.UUID) -> None:
        dedup_key = self._dedup_key(decision)
        # AC①④: dedup insert. 동일 dedup_key를 두 워커가 동시에 넣어도 unique로 1행만 — 패자는
        # ON CONFLICT DO NOTHING으로 0행(RETURNING 없음)이라 dispatch를 호출하지 않는다.
        won = await self._claim_firing(db, decision, org_id, dedup_key)
        if not won:
            await db.rollback()
            logger.debug("L2 firing dedup conflict — wake skip: %s", dedup_key)
            return

        if decision.anchor_type not in _DISPATCHABLE_ANCHORS:
            # firing은 기록(같은 트랜잭션 commit)하되 wake는 미지원 타입이라 skip.
            await db.commit()
            logger.info(
                "L2 firing recorded (anchor=%s non-dispatchable, wake skip): %s",
                decision.anchor_type,
                dedup_key,
            )
            return

        # AC②③: 승자만 dispatch service 호출 → Event(event_type=dispatched·기존 allow-list 재사용,
        # 신규 type 0) 생성 + commit + wake. firing은 같은 세션이라 event와 원자 commit.
        from app.services.agent_dispatch import dispatch_entity_to_assignee

        resp, delivery = await dispatch_entity_to_assignee(
            db,
            org_id,
            decision.anchor_type,
            decision.anchor_id,
            message=decision.reason,
            trigger_metadata={
                "source": "l2_heuristic",
                "trigger_type": decision.trigger_type,
                "reason": decision.reason,
                "source_activity_seq": decision.source_activity_seq,
            },
        )
        # firing.event_id 링크(best-effort). dispatched=False(unresolved 등)면 firing만 commit.
        if resp.dispatched and resp.event_id is not None:
            await self._link_event(db, dedup_key, resp.event_id)
        else:
            await db.commit()

        if resp.dispatched and delivery is not None:
            # CC 릴레이(member webhook) — 라우터의 background_tasks 대신 워커는 직접 await.
            from app.services.conversation_webhook import deliver_injected_event_webhook

            await deliver_injected_event_webhook(**delivery)

    async def _claim_firing(
        self, db, decision: TriggerDecision, org_id: uuid.UUID, dedup_key: str
    ) -> bool:
        res = await db.execute(
            text(
                "INSERT INTO l2_trigger_firings "
                "(id, org_id, trigger_type, target_agent_id, anchor_type, anchor_id, dedup_key, "
                "source_activity_seq, payload) "
                "VALUES (gen_random_uuid(), :org, :tt, :tgt, :at, :aid, :dk, :seq, CAST(:payload AS jsonb)) "
                "ON CONFLICT (dedup_key) DO NOTHING RETURNING id"
            ),
            {
                "org": org_id,
                "tt": decision.trigger_type,
                "tgt": decision.target_agent_id,
                "at": decision.anchor_type,
                "aid": decision.anchor_id,
                "dk": dedup_key,
                "seq": decision.source_activity_seq,
                "payload": json.dumps({"reason": decision.reason, "source": "l2_heuristic"}),
            },
        )
        return res.first() is not None

    async def _link_event(self, db, dedup_key: str, event_id: uuid.UUID) -> None:
        await db.execute(
            text("UPDATE l2_trigger_firings SET event_id = :eid WHERE dedup_key = :dk"),
            {"eid": event_id, "dk": dedup_key},
        )
        await db.commit()
