"""E-LOOP-LEDGER P1-S6: /api/v2/context-pack 라우터(유사도 검색, 블루프린트 §P1).

계약: 성공은 raw list 반환, 오류는 HTTPException(dict detail {code,message}) — loops.py/docs.py
동형(main.py 핸들러가 {data:null,error:{code,message},meta:null}로 감쌈).

authz: project_id 필수(Query(...))+has_project_access 명시 호출(docs.py의
_require_doc_project_access와 동형, IDOR-safe — 선생님 결정#6: search는 loops.py LIST의
get_project_scoped_org_id 단독 의존보다 엄격한 project 멤버십을 요구한다. get_project_scoped_org_id는
project의 org 소속만 확인하고 caller의 project 멤버십 자체는 검증하지 않음 — has_project_access를
별도로 걸어야 실제 project-level IDOR을 막는다).

query embed는 동기 embed_client(P1-S2) 직접 호출 — 검색은 사용자가 응답을 기다리는 요청이라 cron의
None-tolerant(false-hit 0) 설계와 달리 embed 실패를 즉시 503으로 드러낸다(결과를 조용히 비워
"검색 결과 없음"으로 오인시키지 않음).

P1-S8: 검색 호출마다 구조화 로깅(query_latency_ms/result_count/embeddings_total_rows) — 선생님
A2("pgvector 우선·임계치 계산해 전용 벡터DB 분리 시기 추론")의 실측 데이터 소스. 새 인프라 0(로깅만
— 임계치 자체는 "실측 후 재판단", 이 스토리는 과설계 방지 위해 계측만 한다). embeddings_total_rows는
전 org 합산(테넌트 개별이 아니라 pgvector 인스턴스 전체 규모가 분리 임계치의 관심사).
"""
from __future__ import annotations

import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_project_scoped_org_id
from app.dependencies.database import get_db
from app.schemas.context_pack import ContextPackSearchResult

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/context-pack", tags=["context-pack"])


@router.get("/search", response_model=list[ContextPackSearchResult])
async def search_context_pack(
    project_id: uuid.UUID = Query(...),
    query: str = Query(..., min_length=1),
    limit: int = Query(default=10, ge=1, le=50),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> list[ContextPackSearchResult]:
    from app.services.project_auth import has_project_access
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(
            status_code=403,
            detail={"code": "PROJECT_ACCESS_DENIED", "message": "해당 프로젝트 접근 권한이 없습니다"},
        )

    from app.services.embedding_client import embed_text
    vector = embed_text(query)
    if vector is None:
        raise HTTPException(
            status_code=503,
            detail={"code": "EMBED_UNAVAILABLE", "message": "임베딩 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하세요."},
        )

    start = time.monotonic()
    from app.services.context_pack_search import search_similar_embeddings
    results = await search_similar_embeddings(session, org_id, project_id, vector, limit=limit)
    latency_ms = round((time.monotonic() - start) * 1000, 2)

    await _log_search_instrumentation(session, latency_ms, len(results))
    return results


async def _log_search_instrumentation(session: AsyncSession, latency_ms: float, result_count: int) -> None:
    """A2 계측: 실패해도 검색 응답 자체를 막지 않는다(로깅은 항상 non-fatal)."""
    from app.models.embedding import Embedding

    try:
        total_rows = (await session.execute(select(func.count()).select_from(Embedding))).scalar() or 0
        logger.info(
            "context-pack search",
            extra={"structured": {
                "query_latency_ms": latency_ms,
                "result_count": result_count,
                "embeddings_total_rows": total_rows,
            }},
        )
    except Exception as exc:
        logger.warning("context-pack search instrumentation 실패(응답엔 무영향): %s", exc)
