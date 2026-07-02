"""E-LOOP-LEDGER P1-S3: embeddings 백로그 cron 배치 임베딩(Context Pack 파운데이션).

score_hypotheses(hypothesis_scorer.py) cron 패턴을 구조적으로 미러(라우터는 verify_cron+위임+
commit만, 실 로직은 이 서비스 모듈) — 단 배치 selection은 workflow_handoff_watchdog.py/
workflow_sla_processor.py의 FOR UPDATE SKIP LOCKED를 따른다(중첩 cron invocation이 같은
pending row를 동시에 집어 Vertex AI를 중복 호출하는 것을 방지 — score_hypotheses엔 이 보호가
없지만 그건 외부 API 중복호출 비용이 없는 GA4/internal_ops 판정이라 무관하고, 이쪽은 유료 API라
직접 미러하지 않는다).

status='pending'뿐 아니라 'failed'도 재시도 대상(app/models/embedding.py 문서화된 FSM —
"재시도는 cron이 pending으로 되돌림"을 이 cron이 매 tick 재선정으로 구현. 별도 retry_count
컬럼/마이그 없음 — PO 지시로 이 스토리는 마이그 0).

embed_text(P1-S2)가 인증불가/API오류/응답이상 전부 예외없이 None으로 수렴시키므로(S8 "false-hit 0"
설계 계승) cron 레벨에서 원인 구분이 불가하다 — None은 'failed'로 전환하지 않고 pending 그대로
둔다(다음 tick 자연 재시도, 무한 루프 아님 — tick당 _BATCH_SIZE 상한이 유일한 방어선).
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.embedding import Embedding

logger = logging.getLogger(__name__)

_BATCH_SIZE = 50  # tick당 상한(폭주 방지 — assets-grace-hard-delete의 500-limit과 동형 패턴,
# 유료 임베딩 API 호출이라 더 보수적으로 설정).


async def process_embedding_backlog(session: AsyncSession, limit: int = _BATCH_SIZE) -> dict[str, Any]:
    """embeddings status='pending'|'failed' 배치를 집어 embed_text(P1-S2) 호출·결과 반영.

    반환: scanned/embedded/pending_retry/failed 카운트(score_hypotheses 응답 스키마 미러).
    """
    from app.core.config import EMBEDDING_DIMENSION
    from app.services.embedding_client import MODEL_VERSION, embed_text

    rows = (await session.execute(
        select(Embedding)
        .where(Embedding.status.in_(("pending", "failed")))
        .order_by(Embedding.created_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )).scalars().all()

    embedded: list[uuid.UUID] = []
    pending_retry: list[uuid.UUID] = []
    failed: list[dict[str, str]] = []

    for row in rows:
        try:
            vector = embed_text(row.embedding_text)
            if vector is None:
                # 인증불가/API오류/응답이상 원인 구분 불가(embed_text가 전부 None으로 수렴) →
                # pending 유지(false-hit 0). 이미 'failed'였던 row도 여기서 pending으로 재정착.
                row.status = "pending"
                pending_retry.append(row.id)
                continue
            row.embedding = vector
            row.model_version = MODEL_VERSION
            row.dimension = EMBEDDING_DIMENSION
            row.status = "ready"
            row.error_message = None
            embedded.append(row.id)
        except Exception as exc:  # embed_text 자체는 raise 안 하지만 방어적 격리(한 row 실패가 배치 전체를 막지 않음).
            logger.exception("embed-backlog: row %s 처리 실패: %s", row.id, exc)
            row.status = "failed"
            row.error_message = str(exc)[:500]
            failed.append({"id": str(row.id), "error": str(exc)})

    return {
        "scanned": len(rows),
        "embedded": [str(i) for i in embedded],
        "pending_retry": [str(i) for i in pending_retry],
        "failed": failed,
    }
