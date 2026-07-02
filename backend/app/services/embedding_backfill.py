"""E-LOOP-LEDGER P1-S5: 기존 hypothesis/loop/loop_artifact 전체 1회 backfill(블루프린트 §P1).

P1-S4의 enqueue_embedding(content_hash 멱등)을 그대로 재사용 — 신규 로직은 "전체 스캔" 뿐이다.
재실행해도 안전(같은 텍스트는 no-op) — 순수 1회성이 아니라 언제든 다시 돌려도 되는 멱등 연산.

archived hypothesis/soft-deleted loop 및 그 소속 artifact는 스캔 대상에서 제외한다 — S6(검색)가
어차피 orphan 필터링으로 이들을 결과에서 드롭하므로, backfill 시점에 임베딩해봤자 검색에 노출될
일이 없는 유료 API 비용 낭비다(cron이 나중에 이 pending row를 embed할 때 비용 발생 — 애초에
큐잉을 안 하는 게 맞다).

loop_artifact는 project_id 컬럼이 없어(loop_runs를 통해서만 project 소속) JOIN으로 해소한다.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import Hypothesis
from app.models.loop import LoopArtifact, LoopRun


async def backfill_embeddings(session: AsyncSession) -> dict[str, int]:
    from app.services.embedding_enqueue import (
        build_hypothesis_embedding_text,
        build_loop_artifact_embedding_text,
        build_loop_embedding_text,
        enqueue_embedding,
    )

    counts = {"hypothesis": 0, "loop": 0, "loop_artifact": 0}

    hyps = (await session.execute(
        select(Hypothesis).where(Hypothesis.status != "archived")
    )).scalars().all()
    for h in hyps:
        await enqueue_embedding(
            session, h.org_id, h.project_id, "hypothesis", h.id,
            build_hypothesis_embedding_text(h.statement),
            created_by_member_id=h.owner_member_id,
        )
        counts["hypothesis"] += 1

    loops = (await session.execute(
        select(LoopRun).where(LoopRun.deleted_at.is_(None))
    )).scalars().all()
    for lp in loops:
        await enqueue_embedding(
            session, lp.org_id, lp.project_id, "loop", lp.id,
            build_loop_embedding_text(lp.title, lp.goal_tags),
            created_by_member_id=lp.created_by_member_id,
        )
        counts["loop"] += 1

    artifacts = (await session.execute(
        select(LoopArtifact, LoopRun.project_id)
        .join(LoopRun, LoopArtifact.loop_id == LoopRun.id)
        .where(LoopRun.deleted_at.is_(None))
    )).all()
    for artifact, project_id in artifacts:
        # 배선(P1-S4)과 동일 규칙: 결정 상태에 맞는 이유만 텍스트에 포함(chosen→choose_reason,
        # rejected→rejection_reason, pending→둘 다 None).
        choose_reason = artifact.choose_reason if artifact.decision == "chosen" else None
        rejection_reason = artifact.rejection_reason if artifact.decision == "rejected" else None
        await enqueue_embedding(
            session, artifact.org_id, project_id, "loop_artifact", artifact.id,
            build_loop_artifact_embedding_text(artifact.variant_label, choose_reason, rejection_reason),
            created_by_member_id=artifact.created_by_member_id,
        )
        counts["loop_artifact"] += 1

    return counts
