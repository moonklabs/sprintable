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
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.embedding import Embedding

logger = logging.getLogger(__name__)

_BATCH_SIZE = 50  # tick당 상한(폭주 방지 — assets-grace-hard-delete의 500-limit과 동형 패턴,
# 유료 임베딩 API 호출이라 더 보수적으로 설정).
_MAX_RETRY_COUNT = 5  # P1-S3f: 연속 실패 이 값 도달 시 terminal failed(배치 재선정 영구 제외).


async def process_embedding_backlog(session: AsyncSession, limit: int = _BATCH_SIZE) -> dict[str, Any]:
    """embeddings status='pending'|('failed' AND retry_count<_MAX_RETRY_COUNT) 배치를 집어
    embed_text(P1-S2) 호출·결과 반영.

    반환: scanned/embedded/pending_retry/failed/terminal 카운트(score_hypotheses 응답 스키마 미러
    +terminal 신규).

    §6 봉합③(story #2461, finding #5) 판단 기록 — 이 함수는 delivery_dispatcher.py의
    claim(짧은 트랜잭션·즉시 commit)→work(세션 없음)→finalize(짧은 트랜잭션) 패턴을 **그대로
    적용하지 않았다.** 그 패턴을 적용하면 claim 직후 커밋해 FOR UPDATE SKIP LOCKED를 놓아야
    하는데, 이 파일의 SKIP LOCKED는 원래 "중첩 cron invocation이 같은 pending row를 동시에
    집어 **유료 Vertex AI API를 중복 호출**하는 것"을 막으려는 설계다(모듈 docstring 참조).
    claim을 즉시 커밋하면 그 보호가 사라지고 「같은 row 중복 임베딩=중복 과금」 창이 열린다 —
    이건 webhook 배달(중복=멱등·무료)과 달리 되돌릴 수 없는 비용 문제라, 패턴을 기계적으로
    복붙하지 않고 대신: ①이벤트루프 블로킹(asyncio.to_thread, 위) 만 고쳤다 — 이건 무조건
    이득(트레이드오프 없음). ②커넥션을 Vertex 호출 동안 계속 쥐는 것(이 함수 구조)은 **그대로
    유지** — PO 검토 후 원하면 후속으로 claim-lease 컬럼(만료 타임스탬프) 추가 마이그레이션과
    함께 완전 분리할 것(그 컬럼 없이는 안전하게 분리 못 함).
    """
    from app.core.config import EMBEDDING_DIMENSION
    from app.services.embedding_client import MODEL_VERSION, embed_text

    rows = (await session.execute(
        select(Embedding)
        .where(or_(
            Embedding.status == "pending",
            and_(Embedding.status == "failed", Embedding.retry_count < _MAX_RETRY_COUNT),
        ))
        .order_by(Embedding.created_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )).scalars().all()

    embedded: list[uuid.UUID] = []
    pending_retry: list[uuid.UUID] = []
    failed: list[dict[str, str]] = []
    terminal: list[uuid.UUID] = []

    for row in rows:
        try:
            # §6 봉합③(story #2461, finding #5) — embed_text()는 google-genai SDK의 동기
            # 블로킹 HTTP 호출이다(비-async). 그동안 `await` 없이 직접 호출해 이 함수를
            # await하는 이벤트루프 전체가 Vertex AI 응답을 기다리는 동안 완전히 멈췄다 —
            # 같은 프로세스의 다른 모든 동시 요청(다른 org의 API 호출 등)도 그 순간 멎는다.
            # DB 커넥션 하나를 오래 쥐는 것보다 넓은 blast radius라 asyncio.to_thread로
            # 스레드풀에 위임해 이벤트루프를 막지 않게 한다.
            vector = await asyncio.to_thread(embed_text, row.embedding_text)
            if vector is None:
                # 인증불가/API오류/응답이상 원인 구분 불가(embed_text가 전부 None으로 수렴).
                row.retry_count += 1
                if row.retry_count >= _MAX_RETRY_COUNT:
                    # poison-pill 종결 — status는 그대로 'failed'지만 위 SELECT 조건이
                    # retry_count로 걸러 다음 tick부터 영구 제외(terminal).
                    row.status = "failed"
                    row.error_message = f"embed_text 반복 실패({row.retry_count}회 연속) — 재시도 중단"
                    terminal.append(row.id)
                else:
                    row.status = "pending"
                    pending_retry.append(row.id)
                continue
            row.embedding = vector
            row.model_version = MODEL_VERSION
            row.dimension = EMBEDDING_DIMENSION
            row.status = "ready"
            row.error_message = None
            row.retry_count = 0  # 성공 시 리셋(향후 재임베딩 트리거로 pending 복귀 시 새로 카운트).
            embedded.append(row.id)
        except Exception as exc:  # embed_text 자체는 raise 안 하지만 방어적 격리(한 row 실패가 배치 전체를 막지 않음).
            logger.exception("embed-backlog: row %s 처리 실패: %s", row.id, exc)
            row.retry_count += 1
            row.status = "failed"
            if row.retry_count >= _MAX_RETRY_COUNT:
                row.error_message = f"{str(exc)[:400]} (반복 실패 {row.retry_count}회 연속 — 재시도 중단)"
                terminal.append(row.id)
            else:
                row.error_message = str(exc)[:500]
                failed.append({"id": str(row.id), "error": str(exc)})

    return {
        "scanned": len(rows),
        "embedded": [str(i) for i in embedded],
        "pending_retry": [str(i) for i in pending_retry],
        "failed": failed,
        "terminal": [str(i) for i in terminal],
    }
