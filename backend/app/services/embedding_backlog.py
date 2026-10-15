"""E-LOOP-LEDGER P1-S3: embeddings 백로그 cron 배치 임베딩(Context Pack 파운데이션).

score_hypotheses(hypothesis_scorer.py) cron 패턴을 구조적으로 미러(라우터는 verify_cron+위임+
commit만, 실 로직은 이 서비스 모듈) — 단 배치 selection은 workflow_handoff_watchdog.py/
workflow_sla_processor.py의 FOR UPDATE SKIP LOCKED를 따른다(중첩 cron invocation이 같은
pending row를 동시에 집어 Vertex AI를 중복 호출하는 것을 방지 — score_hypotheses엔 이 보호가
없지만 그건 외부 API 중복호출 비용이 없는 GA4/internal_ops 판정이라 무관하고, 이쪽은 유료 API라
직접 미러하지 않는다).

status='pending'뿐 아니라 'failed'도 재시도 대상(app/models/embedding.py 문서화된 FSM —
"재시도는 cron이 pending으로 되돌림"을 이 cron이 매 tick 재선정으로 구현.

embed_text(P1-S2)가 인증불가/API오류/응답이상 전부 예외없이 None으로 수렴시키므로(S8 "false-hit 0"
설계 계승) cron 레벨에서 원인 구분이 불가하다 — 실패 시 pending으로 되돌려 다음 tick 자연
재시도한다(tick당 _BATCH_SIZE 상한이 폭주 방지선).

P1-S3f(story 00ff282b, poison-pill 종결 정책): 구조적으로 항상 실패하는 row(예: embedding_text가
임베딩 불가한 값)가 매 tick 배치 슬롯을 계속 점유하면, pending 총량이 _BATCH_SIZE를 넘길 때
정상 row가 starvation될 수 있다. retry_count(연속 실패 카운터)가 _MAX_RETRY_COUNT(5)에
도달하면 status='failed'인 채로 배치 SELECT 조건에서 제외해 terminal로 만든다(신규 status
값/CHECK 변경 없음 — PO AC 지시로 기존 'failed' 재활용, retry_count 임계값으로만 구분).
terminal row는 embed_text가 나중에 정상화돼도 재선정 대상이 아니므로 자동 재시도되지 않는다
(수동 재큐잉 경로는 이 스토리 스코프 밖 — 필요시 후속 스토리에서 별도 엔드포인트로 추가).

story #4405 — **story #2461 판단(«claim 즉시 커밋 금지»)을 바꾼 조건.** 2461은 claim을 커밋하면 SKIP LOCKED
보호가 풀려 유료 Vertex 중복 호출 창이 열린다며, lease(만료 시각) 칸과 함께가 아니면 claim을 떼지 않는다고
적었다. 4405는 그 조건을 새 칸 · 마이그 없이 채운다: claim이 `status='processing'`(CHECK에 이미 있던 값)으로
표시해 다른 cron이 고르지 않게 하고, lease는 기존 `updated_at`을 claim 때 **명시로** now()로 찍어 쓴다
(`_CLAIM_LEASE` 15분 > 한 배치 최악 ≈ 8분 20초). 이 세 가지(processing 표시 · updated_at 명시 · lease 길이)
중 하나라도 빼면 2461이 막으려던 중복 과금 창이 다시 열린다 — 되돌리기 전에 이 문단을 먼저 볼 것.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.embedding import Embedding

logger = logging.getLogger(__name__)

_BATCH_SIZE = 50  # tick당 상한(폭주 방지 — assets-grace-hard-delete의 500-limit과 동형 패턴,
# 유료 임베딩 API 호출이라 더 보수적으로 설정).
_MAX_RETRY_COUNT = 5  # P1-S3f: 연속 실패 이 값 도달 시 terminal failed(배치 재선정 영구 제외).


_CLAIM_LEASE = timedelta(minutes=15)  # story #4405 — claim 뒤 이만큼 지나도 processing이면 워커가 죽은 것으로 보고 다시 고른다.
# 한 배치의 최악(50행 × embed 10s ≈ 8분)보다 길어 살아 있는 워커의 행을 다른 cron이 가로채지 않는다(중복 embed = 중복 과금 0).


async def process_embedding_backlog(session: AsyncSession, limit: int = _BATCH_SIZE) -> dict[str, Any]:
    """embeddings status='pending'|('failed' AND retry_count<_MAX_RETRY_COUNT)|(processing인데 lease 지남) 배치를 집어
    embed_text(P1-S2) 호출·결과 반영.

    반환: scanned/embedded/pending_retry/failed/terminal/superseded 카운트(score_hypotheses 응답 스키마 미러
    +terminal · superseded).

    story #4405 — **claim(짧은 tx) → 커밋 → embed(세션 · tx 없이) → 행마다 짧은 tx로 기록.** 예전엔 배치 50행을
    `FOR UPDATE SKIP LOCKED`로 잡은 채 행마다 Vertex(10s)를 기다려, 최악 ~500초 동안 그 행들 · 연결을 쥐었다.
    story #2461 판단(claim 즉시 커밋은 SKIP LOCKED 보호를 놓아 **유료 Vertex 중복 호출** 창이 열린다)은 이렇게 지킨다:
    - claim이 `status='processing'`(CHECK에 이미 있는 값) · `updated_at=now()`로 표시하고 커밋 — 다른 cron은 processing을
      안 고르므로 같은 행 중복 embed 0. 고르는 순간의 겹침은 지금처럼 SKIP LOCKED가 막는다.
    - lease = 기존 `updated_at`(새 칸 · 마이그 0): processing인데 `_CLAIM_LEASE`가 지났으면 워커가 죽은 것 → 다시 고른다.
    - 기록은 `status='processing' AND content_hash = claim 때 값`인 행에만. embed 도중 `embedding_enqueue`가 글을 바꿔
      pending으로 되돌렸으면 옛 벡터를 버린다(superseded · 다음 판이 새 글로).
    """
    from app.core.config import EMBEDDING_DIMENSION
    from app.services.embedding_client import MODEL_VERSION, embed_text

    claimed = await _claim_batch(session, limit)

    embedded: list[uuid.UUID] = []
    pending_retry: list[uuid.UUID] = []
    failed: list[dict[str, str]] = []
    terminal: list[uuid.UUID] = []
    superseded: list[uuid.UUID] = []

    for row_id, text_to_embed, claimed_hash in claimed:
        vector: list[float] | None = None
        error: Exception | None = None
        try:
            # §6 봉합③(story #2461, finding #5) — embed_text()는 동기 블로킹 HTTP라 스레드풀로(이벤트 루프를 막지 않게).
            # story #4405 — 이제 세션 · 트랜잭션 없이 기다린다(행 잠금 · 연결을 쥐지 않음).
            vector = await asyncio.to_thread(embed_text, text_to_embed)
        except Exception as exc:  # embed_text 자체는 raise 안 하지만 방어적 격리(한 row 실패가 배치 전체를 막지 않음).
            logger.exception("embed-backlog: row %s 처리 실패: %s", row_id, exc)
            error = exc

        row = (await session.execute(
            select(Embedding)
            .where(Embedding.id == row_id, Embedding.status == "processing", Embedding.content_hash == claimed_hash)
            .with_for_update()
        )).scalar_one_or_none()
        if row is None:
            superseded.append(row_id)
            await session.commit()
            continue

        if error is not None:
            row.retry_count += 1
            row.status = "failed"
            if row.retry_count >= _MAX_RETRY_COUNT:
                row.error_message = f"{str(error)[:400]} (반복 실패 {row.retry_count}회 연속 — 재시도 중단)"
                terminal.append(row.id)
            else:
                row.error_message = str(error)[:500]
                failed.append({"id": str(row.id), "error": str(error)})
        elif vector is None:
            # 인증불가/API오류/응답이상 원인 구분 불가(embed_text가 전부 None으로 수렴).
            row.retry_count += 1
            if row.retry_count >= _MAX_RETRY_COUNT:
                # poison-pill 종결 — status는 'failed', 위 SELECT 조건이 retry_count로 걸러 다음 tick부터 영구 제외(terminal).
                row.status = "failed"
                row.error_message = f"embed_text 반복 실패({row.retry_count}회 연속) — 재시도 중단"
                terminal.append(row.id)
            else:
                row.status = "pending"
                pending_retry.append(row.id)
        else:
            row.embedding = vector
            row.model_version = MODEL_VERSION
            row.dimension = EMBEDDING_DIMENSION
            row.status = "ready"
            row.error_message = None
            row.retry_count = 0  # 성공 시 리셋(향후 재임베딩 트리거로 pending 복귀 시 새로 카운트).
            embedded.append(row.id)
        row.updated_at = func.now()  # onupdate에 기대지 않고 명시(claim과 같은 규칙)
        await session.commit()  # 행마다 짧은 트랜잭션

    return {
        "scanned": len(claimed),
        "embedded": [str(i) for i in embedded],
        "pending_retry": [str(i) for i in pending_retry],
        "failed": failed,
        "terminal": [str(i) for i in terminal],
        "superseded": [str(i) for i in superseded],
    }


async def _claim_batch(session: AsyncSession, limit: int) -> list[tuple[uuid.UUID, str, str]]:
    """고를 행을 SKIP LOCKED로 잡아 processing으로 표시하고 **커밋** — 이후 embed 동안 잠금 · 연결을 쥐지 않는다.
    반환 (id, embedding_text, content_hash) — 커밋 뒤 ORM 객체를 다시 읽지 않게 값으로."""
    lease_cutoff = datetime.now(timezone.utc) - _CLAIM_LEASE
    rows = (await session.execute(
        select(Embedding)
        .where(or_(
            Embedding.status == "pending",
            and_(Embedding.status == "failed", Embedding.retry_count < _MAX_RETRY_COUNT),
            and_(Embedding.status == "processing", Embedding.updated_at < lease_cutoff),
        ))
        .order_by(Embedding.created_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )).scalars().all()
    claimed = [(r.id, r.embedding_text, r.content_hash) for r in rows]
    if claimed:
        await session.execute(
            update(Embedding)
            .where(Embedding.id.in_([c[0] for c in claimed]))
            .values(status="processing", updated_at=func.now())
            .execution_options(synchronize_session=False)
        )
    await session.commit()
    return claimed
