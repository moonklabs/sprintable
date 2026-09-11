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
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ads_boost_run import AdsBoostRun
from app.models.gate import Gate
from app.models.insight_snapshot import InsightSnapshot

_ADS_BOOST_GATE_TYPE = "ads_boost"
_PAID_CHANNELS = ("meta_ads", "ads_sandbox")
_PAID_SOURCE = "paid"
_SNAPSHOT_OFFSETS = (timedelta(days=1), timedelta(days=7))
BATCH_SIZE = 50


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


async def schedule_ads_spend_snapshots(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, publication_id: uuid.UUID,
    channel: str, anchor_at: datetime,
) -> None:
    """boost_start 성공 직후(같은 트랜잭션, commit은 호출자 몫 — insight_snapshots.py
    ::schedule_insight_snapshots와 동형 계약) +1d·+7d 두 행을 연다. `anchor_at`은
    호출자가 이미 확정한 시각(run.started_at)을 그대로 넘긴다 — 재처리마다 새로
    재면 UNIQUE(publication_id, due_at) 멱등이 무력화되는 것도 동형(그 함수 docstring
    그대로)."""
    for due_at in (anchor_at + offset for offset in _SNAPSHOT_OFFSETS):
        stmt = pg_insert(InsightSnapshot).values(
            id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
            publication_kind="channel_publication", channel=channel, external_id=None, due_at=due_at,
            status="pending",
        ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at")
        await db.execute(stmt)


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

    conn = (await db.execute(
        select(ChannelConnection).where(ChannelConnection.id == gate.sealed_ads_connection_id)
    )).scalar_one_or_none()
    if conn is None:
        raise AdsSpendFetchError("ADS_SPEND_CONNECTION_MISSING", f"ad connection missing: {gate.sealed_ads_connection_id}")

    module_path = "app.services.ads_sandbox_campaign" if conn.channel == "ads_sandbox" else "app.services.meta_ads_campaign"
    module = importlib.import_module(module_path)
    return {
        "module": module, "campaign_id": run.campaign_id,
        "access_token": decrypt_channel_credential(conn.encrypted_access_token),
        # story #3806(Phase3·3-2 PR 11) — 캡처 직후 상한 판정(_enforce_spend_cap)이
        # 이미 여기서 조회한 gate·run을 그대로 재사용(추가 쿼리 0).
        "gate": gate, "run": run,
    }


async def _captured_spend_minor_for_gate(db: AsyncSession, *, org_id: uuid.UUID, publication_id: uuid.UUID) -> int:
    """story #3806(Phase3·3-2 PR 11) — `get_ads_boost_spend_summary`가 이미 하던
    "그 gate의 캡처된 paid spend 합" 계산을 추출(드리프트 금지 — 상한 판정
    (`_enforce_spend_cap`)과 조회 API가 같은 계산을 각자 다시 적으면 나중에
    한쪽만 고쳐질 위험)."""
    snapshots = (await db.execute(
        select(InsightSnapshot).where(
            InsightSnapshot.org_id == org_id, InsightSnapshot.publication_id == publication_id,
            InsightSnapshot.source == _PAID_SOURCE, InsightSnapshot.status == "captured",
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
        return False
    if gate.sealed_ads_budget_minor is None or not gate.scope_key:
        return False

    captured = await _captured_spend_minor_for_gate(
        db, org_id=gate.org_id, publication_id=uuid.UUID(gate.scope_key),
    )
    if captured < gate.sealed_ads_budget_minor:
        return False

    # 「도달했다」는 사실은 중지 명령의 성패와 무관하게 확정(먼저 커밋) — 아래
    # request_ads_boost_pause가 이미-paused 등으로 거부돼도 매 tick 재판정하지
    # 않는다(사실 관측과 그에 대한 대응 조치를 별개 실패단위로 취급).
    run.cap_reached_at = now
    await db.commit()

    if gate.resolver_id is None:
        return True  # PR6과 동형 방어 — 귀속 불가 상태는 이론상 불가하나 침묵 안 함.

    from app.services.ads_boost_execution import (
        AdsBoostAlreadyInStateError,
        AdsBoostGateNotApprovedError,
        AdsBoostGateNotFoundError,
        AdsBoostNotStartedError,
        request_ads_boost_pause,
    )

    try:
        await request_ads_boost_pause(
            db, org_id=gate.org_id, gate_id=gate.id, requester_member_id=gate.resolver_id,
            initiated_by="scheduler",
        )
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError, AdsBoostAlreadyInStateError, AdsBoostNotStartedError):
        # 이미 중지됐거나(사람이 먼저 pause) 게이트가 그 사이 재오픈된 경우 —
        # 「상한 도달」 관측 자체는 위에서 이미 확정됐으니 이 건은 이 워커의
        # 실패가 아니다.
        pass
    except Exception:  # noqa: BLE001 — publication_command.py와 동형 2중 방어.
        await db.rollback()
    return True


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
    for snapshot in rows:
        try:
            ctx = await _resolve_spend_context(db, snapshot)
            async with httpx.AsyncClient(timeout=20) as client:
                spend_minor = await ctx["module"].get_campaign_spend_minor(
                    client, campaign_id=ctx["campaign_id"], access_token=ctx["access_token"],
                )
            from app.services.insight_snapshots import NORMALIZED_KEYS

            # NORMALIZED_KEYS를 그대로 재사용(드리프트 금지) — spend만 채우고
            # 나머지 전부 None(insight_snapshots.py::_normalize와 같은 계약: paid
            # 어댑터는 spend 외 organic 지표를 아예 선언 안 하므로 "미선언"과 같은
            # null, 지어내지 않는다).
            snapshot.normalized = {key: (spend_minor if key == "spend" else None) for key in NORMALIZED_KEYS}
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
        except AdsSpendFetchError as exc:
            snapshot.error_code = exc.code
            snapshot.status = "failed"
            snapshot.captured_at = now
            await db.commit()
            counts["failed"] += 1
        except Exception:  # noqa: BLE001 — publication_command.py와 동형 2중 방어.
            await db.rollback()
            counts["error"] += 1
    return counts


class AdsBoostGateNotFoundForSpendError(Exception):
    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"ads_boost gate not found: {gate_id}")


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
    from app.services.ads_boost_execution import OP_BOOST_START

    boost_start_command = (await db.execute(
        select(PublicationCommand).where(
            PublicationCommand.org_id == org_id, PublicationCommand.gate_id == gate_id,
            PublicationCommand.operation == OP_BOOST_START,
        )
    )).scalar_one_or_none()

    # story #3806(Phase3·3-2 PR 11) — _enforce_spend_cap과 같은 계산(드리프트 금지,
    # 이 파일 상단 `_captured_spend_minor_for_gate` docstring 참고). 위에서 이미
    # 가져온 `snapshots`로 직접 합해도 값은 같지만, 두 소비처가 각자 다시 적으면
    # 나중에 한쪽만 고쳐질 위험을 없애기 위해 공유 함수를 그대로 부른다.
    captured_spend_minor = await _captured_spend_minor_for_gate(
        db, org_id=org_id, publication_id=uuid.UUID(gate.scope_key),
    )
    return {
        "gate_id": gate.id,
        "initiated_by": boost_start_command.initiated_by if boost_start_command is not None else None,
        "sealed_ads_budget_minor": gate.sealed_ads_budget_minor,
        "sealed_ads_currency": gate.sealed_ads_currency,
        "captured_spend_minor": captured_spend_minor,
        "remaining_minor": (gate.sealed_ads_budget_minor or 0) - captured_spend_minor,
        "run_status": run.status if run is not None else None,
        # story #3806(Phase3·3-2 PR 11, §7 실측 열 「상한 초과 0건」의 장치) — run이
        # 없으면(미실행) 당연히 null, run은 있는데 아직 미도달이어도 null(지어내지
        # 않는다) — 도달한 시각이 찍혀야만 값이 있다.
        "cap_reached_at": run.cap_reached_at if run is not None else None,
        "snapshots": [
            {
                "due_at": s.due_at, "captured_at": s.captured_at, "status": s.status,
                "spend_minor": (s.normalized or {}).get("spend") if s.status == "captured" else None,
            }
            for s in snapshots
        ],
    }
