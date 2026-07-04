"""E-LOOP-LEDGER P1-S4: write-path embedding 큐잉 — hypothesis/loop/loop_artifact create(+content
변경 update) 시 embeddings row를 status='pending'으로 동기 INSERT/UPSERT만 한다(네트워크 I/O 0
— 실제 임베딩 생성은 P1-S3 cron이 다음 tick에 처리). score_hypotheses/attribute_loop_outcome이
서비스 함수 안에 직접 배선된 것과 동형 패턴(신규 엔드포인트 0).

content_hash로 staleness를 판단 — 같은 텍스트면 no-op(재큐잉 방지, cron 낭비 방지). 텍스트가
바뀌면 기존 벡터/model_version/dimension을 지우고 pending으로 되돌린다(과거 벡터가 새 텍스트를
대표한다고 오인되는 것을 방지 — 재임베딩 전까지는 검색 결과에서 자연히 빠진다, embedding IS NULL).
"""
from __future__ import annotations

import hashlib
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.embedding import Embedding


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def enqueue_embedding(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
    embedding_text: str,
    created_by_member_id: uuid.UUID | None = None,
) -> None:
    """entity_type+entity_id의 embeddings row를 pending으로 큐잉(신규 또는 재큐잉).

    embedding_text가 비어있으면 아무것도 하지 않는다(예: choose_reason 미기입 상태의 artifact —
    호출부가 조건부로 호출하거나, 빈 텍스트를 그냥 넘겨도 안전하게 no-op).
    """
    if not embedding_text or not embedding_text.strip():
        return

    new_hash = _content_hash(embedding_text)
    existing = (await session.execute(
        select(Embedding).where(
            Embedding.entity_type == entity_type, Embedding.entity_id == entity_id
        )
    )).scalar_one_or_none()

    if existing is not None:
        if existing.content_hash == new_hash:
            return  # 변경 없음 — no-op(재큐잉/cron 낭비 방지)
        existing.embedding_text = embedding_text
        existing.content_hash = new_hash
        existing.status = "pending"
        existing.embedding = None
        existing.model_version = None
        existing.dimension = None
        existing.error_message = None
        await session.flush()
        return

    session.add(Embedding(
        id=uuid.uuid4(),
        org_id=org_id,
        project_id=project_id,
        entity_type=entity_type,
        entity_id=entity_id,
        embedding_text=embedding_text,
        content_hash=new_hash,
        status="pending",
        created_by_member_id=created_by_member_id,
    ))
    await session.flush()


def build_hypothesis_embedding_text(statement: str) -> str:
    return statement


def build_loop_embedding_text(title: str, goal_tags: list[str]) -> str:
    if not goal_tags:
        return title
    return f"{title}\n{' '.join(goal_tags)}"


def build_loop_artifact_embedding_text(
    variant_label: str, choose_reason: str | None, rejection_reason: str | None
) -> str:
    parts = [variant_label]
    if choose_reason:
        parts.append(choose_reason)
    if rejection_reason:
        parts.append(rejection_reason)
    return "\n".join(parts)
