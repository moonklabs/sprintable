"""E-LOOP-LEDGER P1-S6: Context Pack 유사도 검색(블루프린트 §P1).

status='ready' 임베딩만 cosine 거리(pgvector `<=>`)로 ORDER BY — S1 이후 이 코드베이스에서
embedding 컬럼에 대한 첫 실 쿼리(app/models/embedding.py의 HNSW 인덱스는 지금까지 미사용 상태였음).

recall 트랩(까심/codex 지적, app/models/embedding.py에 문서화): HNSW는 WHERE 등식필터를 인덱스
레벨에서 걷지 못한다 — pgvector가 그래프 순회 중 후보에 필터를 적용하므로 project_id/status 필터의
선택도가 낮으면 recall이 저하될 수 있다(seq-scan은 아니지만 유효 결과가 LIMIT보다 적게 반환될 수
있음). 완화책으로 SET LOCAL hnsw.ef_search를 기본값(40)보다 높여 후보 풀을 넓힌다 — 근본 해법(테넌트
파티셔닝)은 후속 스토리 스코프.

orphan 정리(assets.py의 AssetLink 패턴 미러): entity_type/entity_id는 DB FK 없는 폴리모픽 참조라
soft-delete/archive된 부모의 stale embedding row가 남을 수 있다. 후보를 부모 타입별로 배치조회해
"살아있음" 조건에 없으면 결과에서 드롭(백필 안 함 — limit개 요청해 그보다 적게 반환될 수 있음,
AssetLink와 동일 트레이드오프).
"""
from __future__ import annotations

import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.embedding import Embedding
from app.models.hypothesis import Hypothesis
from app.models.loop import LoopRun
from app.schemas.context_pack import ContextPackOutcome, ContextPackSearchResult

_EF_SEARCH = 100  # pgvector 기본 40보다 높여 등식필터 결합 시 recall 완화(세션 GUC, SET LOCAL).


def _build_hypothesis_outcome(hyp: Hypothesis) -> ContextPackOutcome | None:
    """a353e88d(PO 결 2026-07-03) — verified/falsified로 채점된 경우만 populate(outcome_scorer.py
    _build_result의 {metric,target,actual,direction} 형상 그대로 매핑). 아직 안 채점됐으면
    None(hypothesis_status는 결과와 무관하게 별도 필드로 항상 노출)."""
    if hyp.outcome_result is None:
        return None
    md = hyp.metric_definition or {}
    return ContextPackOutcome(
        hypothesis_status=hyp.status,
        metric=md.get("metric"),
        actual=hyp.outcome_result.get("actual"),
        target=md.get("target"),
        direction=md.get("direction"),
    )


async def search_similar_embeddings(
    session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID,
    query_vector: list[float], limit: int = 10,
) -> list[ContextPackSearchResult]:
    # Postgres SET/SET LOCAL은 bind parameter를 받지 않는다(asyncpg PostgresSyntaxError) — _EF_SEARCH가
    # 하드코딩 내부 상수(사용자 입력 아님)라 리터럴 인라인이 안전(SQL 인젝션 축 없음).
    await session.execute(text(f"SET LOCAL hnsw.ef_search = {_EF_SEARCH}"))

    distance = Embedding.embedding.cosine_distance(query_vector)
    rows = (await session.execute(
        select(Embedding, distance.label("distance"))
        .where(
            Embedding.org_id == org_id,
            Embedding.project_id == project_id,
            Embedding.status == "ready",
        )
        .order_by(distance)
        .limit(limit)
    )).all()
    if not rows:
        return []

    hyp_ids = {r.Embedding.entity_id for r in rows if r.Embedding.entity_type == "hypothesis"}
    loop_ids = {r.Embedding.entity_id for r in rows if r.Embedding.entity_type == "loop"}

    # a353e88d(PO 결 2026-07-03) — 기존엔 id만 뽑아 살아있음 체크만 했으나, L1 선례 UI가
    # 결과(status/outcome)까지 한 응답으로 받도록 같은 배치 쿼리에서 전체 row를 싣는다
    # (신규 왕복 0 — server-side batch enrich, N+1 금지 PO 요구 그대로).
    alive_hyp_ids: set[uuid.UUID] = set()
    hyp_by_id: dict[uuid.UUID, Hypothesis] = {}
    if hyp_ids:
        hyp_rows = (await session.execute(
            select(Hypothesis).where(Hypothesis.id.in_(hyp_ids), Hypothesis.status != "archived")
        )).scalars().all()
        alive_hyp_ids = {h.id for h in hyp_rows}
        hyp_by_id = {h.id: h for h in hyp_rows}

    alive_loop_ids: set[uuid.UUID] = set()
    if loop_ids:
        alive_loop_ids = set((await session.execute(
            select(LoopRun.id).where(LoopRun.id.in_(loop_ids), LoopRun.deleted_at.is_(None))
        )).scalars().all())

    results: list[ContextPackSearchResult] = []
    for r in rows:
        emb, distance_val = r.Embedding, r.distance
        if emb.entity_type == "hypothesis" and emb.entity_id not in alive_hyp_ids:
            continue
        if emb.entity_type == "loop" and emb.entity_id not in alive_loop_ids:
            continue
        # loop_artifact: 삭제/보관 개념 없음(app/models/loop.py) — 항상 유지.
        hyp = hyp_by_id.get(emb.entity_id) if emb.entity_type == "hypothesis" else None
        results.append(ContextPackSearchResult(
            entity_type=emb.entity_type,
            entity_id=emb.entity_id,
            embedding_text=emb.embedding_text,
            similarity=1.0 - distance_val,
            hypothesis_status=hyp.status if hyp is not None else None,
            outcome=_build_hypothesis_outcome(hyp) if hyp is not None else None,
        ))
    return results
